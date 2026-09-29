import { DEFAULT_MODEL_TIER, type ProjectProfilePlan } from "./plan.js";

// One more agent for a project: `POST /projects/:id/agents`'s rows, pure and I/O-free
// like `projectPlan`. The writer (`createProjectAgent`, @bayon/db/api) reads the facts inside its
// transaction and calls this, so what the names are is decided in one place.
//
// Naming: the profile is `<ws>-<stem>-<runner>` — one per (project, kind, runner), shared by every
// agent of that kind on that runner; the stem is the kind, except an orchestrator's, which is
// `orchestrate` as `projectPlan` names its one (`<ws>-orchestrate`). The agent is
// `<ws>-<kind>-<n>`, n the smallest ≥ 1 that no agent in the fleet has as its id or its name
// (`agents.name` is unique fleet-wide). `projectPlan`'s own `<ws>-builder`/`<ws>-orchestrator`/
// `<ws>-reviewer` never take that shape, so the first builder added beside `<ws>-builder` is
// `<ws>-builder-1`. At most one orchestrator of a project is enabled: the writer's rule, not the
// plan's (it needs the rows).

/** The kinds an operator adds to a project from the API (an orchestrator). */
export const ADDABLE_AGENT_KINDS = [
  "builder",
  "reviewer",
  "orchestrator",
] as const;
export type AddableAgentKind = (typeof ADDABLE_AGENT_KINDS)[number];

/** A profile id's middle word, by kind: `projectPlan`'s `orchestrate` for an orchestrator. */
const PROFILE_STEM: Readonly<Record<AddableAgentKind, string>> = {
  builder: "builder",
  reviewer: "reviewer",
  orchestrator: "orchestrate",
};

export interface ProjectAgentInput {
  /** The project: `workspaces.id`. */
  readonly workspace: string;
  readonly kind: AddableAgentKind;
  readonly runner: string;
}

/** What the writer reads, inside its transaction, before it plans. */
export interface ProjectAgentFacts {
  /** Every agent id and every agent name in the fleet. */
  readonly taken: ReadonlySet<string>;
  /** The project's oldest agent's executor: a project's agents run where its others do. Null when
   * it has none; resolve then falls back to the workspace's default (§9.1). */
  readonly executor: string | null;
}

/** An agent row short `created_at` and `max_concurrency`: the writer stamps the one and passes the
 * other through. */
export interface AddedAgentPlan {
  readonly id: string;
  readonly name: string;
  readonly kind: AddableAgentKind;
  readonly runner_id: string;
  readonly executor_id: string | null;
  readonly profile_id: string;
  readonly workspace_id: string;
}

export interface AddAgentPlan {
  /** Inserted only when no profile has its id yet. */
  readonly profile: ProjectProfilePlan;
  readonly agent: AddedAgentPlan;
}

/** The profile every `kind` agent of the project on `runner` shares; no facts needed, so the door
 * can fill its defaults (an async hash) before the writer's transaction opens. */
export function projectAgentProfile(
  input: ProjectAgentInput,
): ProjectProfilePlan {
  const id = `${input.workspace}-${PROFILE_STEM[input.kind]}-${input.runner}`;
  return {
    id,
    name: id,
    runner_id: input.runner,
    model_tier: DEFAULT_MODEL_TIER,
  };
}

/** `<workspace>-<kind>-<n>`, n the smallest ≥ 1 not in `taken`. */
export function projectAgentId(
  workspace: string,
  kind: AddableAgentKind,
  taken: ReadonlySet<string>,
): string {
  const prefix = `${workspace}-${kind}-`;
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

/** The profile and agent rows one more `input.kind` on `input.runner` needs. */
export function projectAgentPlan(
  input: ProjectAgentInput,
  facts: ProjectAgentFacts,
): AddAgentPlan {
  const profile = projectAgentProfile(input);
  const id = projectAgentId(input.workspace, input.kind, facts.taken);
  return {
    profile,
    agent: {
      id,
      name: id,
      kind: input.kind,
      runner_id: input.runner,
      executor_id: facts.executor,
      profile_id: profile.id,
      workspace_id: input.workspace,
    },
  };
}
