// The models enabled agents run, counted as uses beside listBoundModels' role bindings
// and step tiers: a new project's agents run their profile's tier with neither, and that is the
// model their sessions need certified. GET /runners lists them in `bound_roles` as
// `<project> · <agent> agent`, and `frm runner conformance <runner>` certifies them by default.
//
// Resolved per role, as a session's tier is (core sessionTier: binding, then step, then profile):
// a builder runs the builder role in the plan, build and review (ce_review) steps; a reviewer runs
// plan_reviewer and code_reviewer in the review step; any other kind runs its own role, in no step.
// For each role, a binding's own `model_tier` wins. Otherwise the profile's tier counts only while
// a step the role runs has no project tier: a covered step runs the project's tier, which
// stepBoundModels already lists. A fleet agent (no project) serves projects with and without step
// tiers, so its profile's tier counts. A profile counts only for its own runner. Read-only.
import type { ModelStep } from "@bayon/core";
import { all, qb, read, type Db, type R } from "../connection.js";
import { stepTiersOf } from "./step-tiers.js";

/** One model an enabled agent runs, labelled for bound_roles. */
export interface AgentBoundModel {
  readonly role: string;
  readonly runner_id: string;
  readonly model_id: string;
}

/** How an agent's model reads among a runner model's uses. */
export const agentBoundLabel = (
  workspaceId: string | null,
  name: string,
): string => `${workspaceId ?? "fleet"} · ${name} agent`;

/** The roles an agent of `kind` runs, and the steps each runs in. */
function rolesOf(
  kind: string,
): readonly { readonly role: string; readonly steps: readonly ModelStep[] }[] {
  if (kind === "builder") {
    return [{ role: "builder", steps: ["plan", "build", "review"] }];
  }
  if (kind === "reviewer") {
    return [
      { role: "plan_reviewer", steps: ["review"] },
      { role: "code_reviewer", steps: ["review"] },
    ];
  }
  return [{ role: kind, steps: [] }];
}

/** Every enabled agent's models, once per (agent, model), in agent id order. */
export function agentBoundModels(db: Db): R<AgentBoundModel[]> {
  return read(db, (ix) => {
    const agents = all(
      ix,
      qb
        .selectFrom("agents")
        .select(["name", "kind", "runner_id", "profile_id", "workspace_id"])
        .where("enabled", "=", 1)
        .orderBy("id"),
    );
    const bindingTier = new Map(
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
    const workspaces = new Map(
      all(
        ix,
        qb
          .selectFrom("workspaces")
          .select(["id", "plan_tier", "build_tier", "review_tier"]),
      ).map((w) => [w.id, stepTiersOf(w)] as const),
    );
    const models = all(
      ix,
      qb
        .selectFrom("models")
        .select(["id", "runner_id", "tier"])
        .where("active", "=", 1),
    );
    return agents.flatMap((a) => {
      const profile =
        a.profile_id === null ? undefined : profiles.get(a.profile_id);
      const profileTier =
        profile !== undefined && profile.runner_id === a.runner_id
          ? profile.model_tier
          : null;
      const steps =
        a.workspace_id === null ? undefined : workspaces.get(a.workspace_id);
      const tiers = rolesOf(a.kind).flatMap(({ role, steps: runs }) => {
        const bound = bindingTier.get(role) ?? null;
        if (bound !== null) return [bound];
        const uncovered =
          steps === undefined ||
          runs.length === 0 ||
          runs.some((step) => steps[step] === null);
        return uncovered && profileTier !== null ? [profileTier] : [];
      });
      const ids = new Set(
        tiers.flatMap((tier) => {
          const model = models.find(
            (m) => m.runner_id === a.runner_id && m.tier === tier,
          );
          return model === undefined ? [] : [model.id];
        }),
      );
      const role = agentBoundLabel(a.workspace_id, a.name);
      return [...ids].map((model_id) => ({
        role,
        runner_id: a.runner_id,
        model_id,
      }));
    });
  });
}
