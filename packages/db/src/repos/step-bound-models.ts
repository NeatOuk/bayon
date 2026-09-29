// The models projects' step tiers select, counted as bound beside the role bindings'
// (listBoundModels): GET /runners lists them in `bound_roles` as `<project> · <step> step`, and
// `frm runner conformance <runner>` certifies them by default — a step tier whose model nobody
// certified would otherwise surface only as every spawn of that step refused `uncertified`.
//
// A step's model is on the runner of each agent that may run it, by the pool rule staffing and the
// gate pick use (agent-scope.ts): the project's own agents of the kind (enabled), else the fleet's
// (no project) while it has none. plan and build run on its builders; review is every LLM gate's
// reviewer — plan and code review on its reviewers (the fleet's narrowed to the binding's runner and
// fallback, as the pick narrows them), ce_review on its builders. A role binding that sets its own
// `model_tier` wins over the project's tier (core sessionTier), so that role adds nothing here.
import { MODEL_STEPS, type BindingRole, type ModelStep } from "@bayon/core";
import type { Selectable } from "kysely";
import { all, qb, type Internals } from "../connection.js";
import type { AgentRow, ModelRow } from "../schema.js";
import type { RoleBindingsTable } from "../schema-work.js";
import type { BoundModel } from "./role-models.js";
import { stepTiersOf } from "./step-tiers.js";

type Binding = Pick<
  Selectable<RoleBindingsTable>,
  "role" | "model_tier" | "runner_id" | "fallback_runner_id"
>;
type Agent = Pick<
  AgentRow,
  "kind" | "runner_id" | "executor_id" | "workspace_id" | "enabled"
>;

/** How a step-tier model reads among a runner model's bound roles. */
export const stepBoundLabel = (project: string, step: ModelStep): string =>
  `${project} · ${step} step`;

/** Which roles' sessions run each step, and the kind of agent each takes. */
const STEP_ROLES: Readonly<
  Record<
    ModelStep,
    readonly {
      readonly role: BindingRole;
      readonly kind: "builder" | "reviewer";
    }[]
  >
> = {
  plan: [{ role: "builder", kind: "builder" }],
  build: [{ role: "builder", kind: "builder" }],
  review: [
    { role: "plan_reviewer", kind: "reviewer" },
    { role: "code_reviewer", kind: "reviewer" },
    // ce_review: the builder's own runner and agent, reviewing (run class review).
    { role: "builder", kind: "builder" },
  ],
};

/**
 * The agents of `kind` whose sessions in project `workspaceId` may run: its own, enabled; the
 * fleet's while it has none of the kind, narrowed to the binding's runners for a reviewer.
 */
function pool(
  agents: readonly Agent[],
  kind: "builder" | "reviewer",
  workspaceId: string,
  binding: Binding | undefined,
): Agent[] {
  const ofKind = agents.filter((a) => a.kind === kind);
  const own = ofKind.filter((a) => a.workspace_id === workspaceId);
  if (own.length > 0) return own.filter((a) => a.enabled === 1);
  const pair =
    kind === "reviewer" && binding !== undefined
      ? [binding.runner_id, binding.fallback_runner_id]
      : null;
  return ofKind.filter(
    (a) =>
      a.workspace_id === null &&
      a.enabled === 1 &&
      (pair === null || pair.includes(a.runner_id)),
  );
}

/** Every model a project's step tier selects, once per (project, step, runner). */
export function stepBoundModels(
  ix: Internals,
  bindings: readonly Binding[],
  models: readonly ModelRow[],
): BoundModel[] {
  const workspaces = all(
    ix,
    qb
      .selectFrom("workspaces")
      .select(["id", "plan_tier", "build_tier", "review_tier"])
      .orderBy("id"),
  );
  const agents = all(
    ix,
    qb
      .selectFrom("agents")
      .select(["kind", "runner_id", "executor_id", "workspace_id", "enabled"])
      .orderBy("id"),
  );
  const bindingOf = new Map(bindings.map((b) => [b.role, b] as const));
  const seen = new Set<string>();
  return workspaces.flatMap((w) => {
    const tiers = stepTiersOf(w);
    return MODEL_STEPS.flatMap((step) => {
      const tier = tiers[step];
      if (tier === null) return [];
      return STEP_ROLES[step].flatMap(({ role, kind }) => {
        const binding = bindingOf.get(role);
        if (binding?.model_tier != null) return [];
        return pool(agents, kind, w.id, binding).flatMap((agent) => {
          const model = models.find(
            (m) =>
              m.runner_id === agent.runner_id &&
              m.tier === tier &&
              m.active === 1,
          );
          const key = `${w.id}\u0000${step}\u0000${agent.runner_id}`;
          if (model === undefined || seen.has(key)) return [];
          seen.add(key);
          return [
            {
              role: stepBoundLabel(w.id, step),
              runner_id: agent.runner_id,
              executor_id: agent.executor_id,
              tier,
              model_id: model.id,
              model: model.model,
              fallback: false,
              step: { workspace_id: w.id, step },
            },
          ];
        });
      });
    });
  });
}
