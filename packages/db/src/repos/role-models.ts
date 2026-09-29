// The models a role binding and an agent would run (§9.8), for certification per model:
// the tier is the binding's `model_tier` when it sets one, else — for a session, in a project that
// names one for its step — the project's, else the profile's (core sessionTier),
// and the model is the runner's active row of that tier. A profile counts only for the runner it is
// for, as the reviewer pick's bound profile does. Read-only; the rows are the operator's.
import { ModelTier, sessionTier, type ModelStep } from "@bayon/core";
import type { Selectable } from "kysely";
import { all, qb, read, type Db, type R } from "../connection.js";
import type { ModelRow, ProfileRow } from "../schema.js";
import type { RoleBindingsTable } from "../schema-work.js";
import { stepBoundModels } from "./step-bound-models.js";
import { stepTierIn, type StepRef } from "./step-tiers.js";

type BindingRow = Selectable<RoleBindingsTable>;
type Tiered = Pick<ProfileRow, "id" | "runner_id" | "model_tier">;

/**
 * One model a role binding runs, on its runner or on its fallback runner; or one a project's step
 * tier selects, on the runner of an agent that runs that step.
 */
export interface BoundModel {
  /** The binding's role; for a step tier, `<project> · <step> step` (stepBoundLabel). */
  readonly role: string;
  readonly runner_id: string;
  /** The binding's executor; null: the spawn's default. */
  readonly executor_id: string | null;
  readonly tier: string;
  readonly model_id: string;
  readonly model: string;
  /** On the binding's fallback runner rather than its own. */
  readonly fallback: boolean;
  /** The project step whose tier selects it; null for a role binding's. */
  readonly step: {
    readonly workspace_id: string;
    readonly step: ModelStep;
  } | null;
}

/**
 * The tier `binding` runs on `runnerId`: its own model_tier, else its profile's when that profile
 * is `runnerId`'s; null when neither says (the agent's own profile decides at spawn).
 */
export function bindingTierOn(
  binding: Pick<BindingRow, "model_tier" | "profile_id">,
  runnerId: string,
  profiles: ReadonlyMap<string, Tiered>,
): string | null {
  const profile =
    binding.profile_id === null ? undefined : profiles.get(binding.profile_id);
  const profileTier =
    profile !== undefined && profile.runner_id === runnerId
      ? profile.model_tier
      : null;
  return binding.model_tier ?? profileTier;
}

const activeOf = (
  models: readonly ModelRow[],
  runnerId: string,
  tier: string,
): ModelRow | undefined =>
  models.find(
    (m) => m.runner_id === runnerId && m.tier === tier && m.active === 1,
  );

/**
 * Every role binding's models, its runner's then its fallback's, by role; then every model a
 * project's step tier selects, by project. What certification per model is checked on,
 * and what `frm runner conformance` certifies by default.
 */
export function listBoundModels(db: Db): R<BoundModel[]> {
  return read(db, (ix) => {
    const bindings = all(
      ix,
      qb.selectFrom("role_bindings").selectAll().orderBy("role"),
    );
    const profiles = new Map(
      all(
        ix,
        qb.selectFrom("profiles").select(["id", "runner_id", "model_tier"]),
      ).map((p) => [p.id, p] as const),
    );
    const models = all(
      ix,
      qb.selectFrom("models").selectAll().where("active", "=", 1),
    );
    const byBinding = bindings.flatMap((b) =>
      [
        { runner: b.runner_id, fallback: false },
        { runner: b.fallback_runner_id, fallback: true },
      ].flatMap(({ runner, fallback }) => {
        if (runner === null) return [];
        const tier = bindingTierOn(b, runner, profiles);
        const model =
          tier === null ? undefined : activeOf(models, runner, tier);
        return tier === null || model === undefined
          ? []
          : [
              {
                role: b.role,
                runner_id: runner,
                executor_id: b.executor_id,
                tier,
                model_id: model.id,
                model: model.model,
                fallback,
                step: null,
              },
            ];
      }),
    );
    return [...byBinding, ...stepBoundModels(ix, bindings, models)];
  });
}

/** No step: the session's tier is its binding's, else its profile's. */
const NO_STEP: StepRef = { workspaceId: null, step: null };

/** The tier and model a session runs; either null when nothing names one. */
export interface SpawnModel {
  readonly tier: string | null;
  readonly model: ModelRow | null;
}

/**
 * The model a session of `role` runs on `runnerId` with `profileId`, in step `step` of its project
 *: the tier is the role binding's when it sets one, else the project's for the step,
 * else the profile's (core sessionTier; a profile counts only for its own runner); the model is the
 * runner's active one of that tier, or null. What resolve spawns with and what the reviewer pick
 * checks certification on, so the two never differ. `step` absent: no project tier.
 */
export async function bindingModelOn(
  db: Db,
  role: string,
  runnerId: string,
  profileId: string | null,
  step: StepRef = NO_STEP,
): R<SpawnModel> {
  return read(db, (ix) => {
    const binding = all(
      ix,
      qb
        .selectFrom("role_bindings")
        .select("model_tier")
        .where("role", "=", role),
    )[0];
    const profile =
      profileId === null
        ? undefined
        : all(
            ix,
            qb
              .selectFrom("profiles")
              .select(["runner_id", "model_tier"])
              .where("id", "=", profileId),
          )[0];
    const profileTier =
      profile !== undefined && profile.runner_id === runnerId
        ? profile.model_tier
        : null;
    const tier = sessionTier({
      binding: binding?.model_tier,
      step: stepTierIn(ix, step),
      profile: profileTier,
    });
    const known = ModelTier.safeParse(tier);
    const model = !known.success
      ? undefined
      : all(
          ix,
          qb
            .selectFrom("models")
            .selectAll()
            .where("runner_id", "=", runnerId)
            .where("tier", "=", known.data)
            .where("active", "=", 1),
        )[0];
    return { tier, model: model ?? null };
  });
}

/** An agent's model: what a session of its role would run on its runner with its profile. */
export interface AgentModel {
  readonly agent_id: string;
  readonly model_id: string | null;
  readonly model: string | null;
}

/**
 * Each agent's model for display: the role named by its kind (when a binding has that
 * role) and its own profile, as bindingModelOn decides. Null when no tier or no active model.
 */
export function agentModels(db: Db): R<AgentModel[]> {
  return read(db, (ix) => {
    const agents = all(
      ix,
      qb
        .selectFrom("agents")
        .select(["id", "kind", "runner_id", "profile_id"])
        .orderBy("id"),
    );
    const bindings = new Map(
      all(
        ix,
        qb.selectFrom("role_bindings").select(["role", "model_tier"]),
      ).map((b) => [b.role, b.model_tier] as const),
    );
    const profiles = new Map(
      all(
        ix,
        qb.selectFrom("profiles").select(["id", "runner_id", "model_tier"]),
      ).map((p) => [p.id, p] as const),
    );
    const models = all(
      ix,
      qb.selectFrom("models").selectAll().where("active", "=", 1),
    );
    return agents.map((a) => {
      const profile =
        a.profile_id === null ? undefined : profiles.get(a.profile_id);
      const profileTier =
        profile !== undefined && profile.runner_id === a.runner_id
          ? profile.model_tier
          : null;
      const tier = bindings.get(a.kind) ?? profileTier;
      const model =
        tier === null ? undefined : activeOf(models, a.runner_id, tier);
      return {
        agent_id: a.id,
        model_id: model?.id ?? null,
        model: model?.model ?? null,
      };
    });
  });
}
