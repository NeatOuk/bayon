import {
  sessionTier,
  type AgentKind,
  type BindingRole,
  type ModelStep,
  type ModelTier,
} from "@bayon/core";
import type {
  ProjectAgentView,
  ProjectView,
  RoleBindingView,
  RunnerView,
} from "@bayon/proto";
import {
  CERTIFICATION_EXECUTOR,
  type CertificationKind,
  type CertificationState,
} from "@/ide/runner-certification";

// The model each step of a project's work will run, for Project settings → Models, from
// data the GUI already reads: the project's agents (GET /projects), their runners' active models and
// certifications (GET /runners) and the role bindings (GET /role-bindings). The order is core's
// sessionTier, the one the spawn and the gate pick use: the role binding's tier, else the project's
// for the step, else the profile's. A builder's session runs its agent's own profile (GET /projects
// resolved it into the agent's model). A gate's reviewer runs the binding's profile when it is for
// the reviewer's runner, as the pick's `boundProfile` does, and the pick tries the binding's runner
// first: there the binding's own model (GET /role-bindings resolved it) is what an inherit runs.

/** How each step reads on the screen. */
export const STEP_LABELS: Readonly<Record<ModelStep, string>> = {
  plan: "Plan",
  build: "Build",
  review: "Review",
};

/**
 * Whose sessions run a step, the role binding whose tier wins over the project's for it, and whether
 * a gate's pick places the session (its binding's runner first, its binding's profile there).
 */
const RUNS: Readonly<
  Record<
    ModelStep,
    {
      readonly kind: AgentKind;
      readonly role: BindingRole;
      readonly gatePick: boolean;
    }
  >
> = {
  // A builder's spawn resolves its own profile: the binding's profile never counts (resolve.ts).
  plan: { kind: "builder", role: "builder", gatePick: false },
  build: { kind: "builder", role: "builder", gatePick: false },
  // A gate's reviewer: code review is the round every ticket passes.
  review: { kind: "reviewer", role: "code_reviewer", gatePick: true },
};

export interface StepModel {
  /** The runner of the agent that runs the step; null when the project has no such agent. */
  readonly runnerId: string | null;
  readonly tier: string | null;
  readonly modelId: string | null;
  readonly model: string | null;
  /** The role binding whose own tier decides instead of the project's; null when none does. */
  readonly boundBy: BindingRole | null;
  /** The role binding whose profile an inheriting step runs, instead of the agent's; or null. */
  readonly profileOf: BindingRole | null;
  /** On CERTIFICATION_EXECUTOR; null when there is no model to certify. */
  readonly certification: CertificationState | null;
  /** For review: whether that certificate may review a gate; null for another step, or none. */
  readonly gateEligible: boolean | null;
  /** What stops the step running, in a sentence; null when nothing does. */
  readonly problem: string | null;
}

/** The agent that runs a step: an enabled one of `kind`, on `first`'s runner when one is. */
const agentFor = (
  project: ProjectView,
  kind: AgentKind,
  first: string | null,
): ProjectAgentView | undefined => {
  const all = project.agents.filter((agent) => agent.kind === kind);
  const enabled = all.filter((agent) => agent.enabled);
  return (
    enabled.find((agent) => agent.runner_id === first) ?? enabled[0] ?? all[0]
  );
};

function certificationOf(
  runner: RunnerView,
  modelId: string,
  compression: boolean,
): { readonly state: CertificationState; readonly gateEligible: boolean } {
  const rows = runner.certifications.filter(
    (c) =>
      c.executor_id === CERTIFICATION_EXECUTOR &&
      c.model_id === modelId &&
      c.compression === compression,
  );
  const live = rows.find(
    (c) => c.passed_at !== null && c.decertified_at === null,
  );
  if (live !== undefined)
    return { state: "certified", gateEligible: live.gate_eligible };
  const state: CertificationState =
    rows.length === 0
      ? "never run"
      : rows.every((c) => c.decertified_at !== null)
        ? "decertified"
        : "not certified";
  return { state, gateEligible: false };
}

const NONE = {
  tier: null,
  modelId: null,
  model: null,
  boundBy: null,
  profileOf: null,
  certification: null,
  gateEligible: null,
} as const;

/** Why a step with this model would not run, or null. */
function problemOf(
  step: ModelStep,
  m: Omit<StepModel, "problem">,
): string | null {
  if (m.modelId === null) {
    return m.tier === null
      ? "Its agent resolves to no active model: a spawn is refused (no_model)."
      : `Runner ${m.runnerId ?? ""} has no active ${m.tier} model: a spawn is refused (no_model).`;
  }
  if (m.certification !== "certified") {
    return `Not certified on ${CERTIFICATION_EXECUTOR}: admission refuses it until it is.`;
  }
  return step === "review" && m.gateEligible === false
    ? `Not gate-eligible on ${CERTIFICATION_EXECUTOR}: no gate review can run on it.`
    : null;
}

/**
 * The model `step` runs in `project` with its tier set to `tier` (null: inherit): on the runner of
 * the agent that runs it, its binding's tier first, and whether it is certified — and, for review,
 * gate-eligible — on CERTIFICATION_EXECUTOR: with its normal certificate, or, asked for
 * `compression`, the one earned with context compression on.
 */
export function stepModel(
  step: ModelStep,
  tier: ModelTier | null,
  project: ProjectView,
  runners: readonly RunnerView[],
  bindings: readonly RoleBindingView[],
  certificate: CertificationKind = {},
): StepModel {
  const { kind, role, gatePick } = RUNS[step];
  const binding = bindings.find((b) => b.role === role);
  const agent = agentFor(
    project,
    kind,
    gatePick ? (binding?.runner_id ?? null) : null,
  );
  if (agent === undefined) {
    return {
      ...NONE,
      runnerId: null,
      problem: `This project has no ${kind} agent: nothing runs this step.`,
    };
  }
  const runner = runners.find((r) => r.id === agent.runner_id);
  const bindingTier = binding?.model_tier ?? null;
  const named = sessionTier({ binding: bindingTier, step: tier });
  // Inheriting on the binding's own runner, a gate's reviewer runs the binding's profile's model.
  const bindingModel =
    gatePick && binding?.runner_id === agent.runner_id
      ? (binding.model_id ?? null)
      : null;
  const inherited = bindingModel ?? agent.model_id;
  const row =
    named === null
      ? runner?.models.find((m) => m.id === inherited)
      : runner?.models.find((m) => m.tier === named);
  const cert =
    row === undefined || runner === undefined
      ? null
      : certificationOf(runner, row.id, certificate.compression === true);
  const resolved = {
    runnerId: agent.runner_id,
    tier: row?.tier ?? named,
    modelId: row?.id ?? null,
    model: row?.model ?? null,
    boundBy: bindingTier === null ? null : role,
    profileOf: named === null && bindingModel !== null ? role : null,
    certification: cert?.state ?? null,
    gateEligible: step === "review" ? (cert?.gateEligible ?? null) : null,
  };
  return { ...resolved, problem: problemOf(step, resolved) };
}
