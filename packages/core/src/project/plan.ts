import { err, ok, type Result } from "../errors.js";
import { isReservedRepoId } from "../mirrors.js";

// The rows `frm project add` and `POST /projects` both write: a repo, a workspace, its
// one workspace_repo, a build profile and builder agent, and unless suppressed an orchestrate
// profile/agent and a review profile/agent. Pure and I/O-free — neither `mirror_path` (needs a home
// root) nor a profile's hash/allowlist/`created_at` (needs @bayon/proto's catalogue and a clock):
// each door fills those in from the same shape, so the CLI and the route can never drift on what a
// project's rows are.

/** `repos.id` = `workspaces.id` = this, so both doors derive every other id the same way. */
export const PROJECT_NAME = /^[a-z0-9-]{1,32}$/;

/** `origin_url`: https, explicit `ssh://`, or `user@host:path` scp-style — the three forms git
 * itself accepts. No bare filesystem paths here: the route takes a folder only inside one
 * `projects.local_roots` allows (§14), and judges that on its own. */
const ORIGIN_URL = /^(?:https?:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:)\S+$/;

export interface ProjectPlanInput {
  readonly name: string;
  readonly repoUrl: string;
  readonly runner: string;
  readonly executor: string;
  readonly base?: string;
  readonly orchestrator: boolean;
  /** The reviewer agent's runner; null: no reviewer. */
  readonly reviewerRunner: string | null;
}

const invalid = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

/** `name`'s shape and that it would not collide with an executor's own mirror name. */
export function checkProjectName(name: string): Result<void> {
  if (!PROJECT_NAME.test(name)) {
    return invalid(
      `project name ${JSON.stringify(name)} must match ${PROJECT_NAME.source}`,
    );
  }
  if (isReservedRepoId(name)) {
    return invalid(
      `project name ${JSON.stringify(name)}: that prefix is reserved for executor mirrors`,
    );
  }
  return ok(undefined);
}

/** `repoUrl`'s shape: https, `ssh://`, or scp-style only (§14; the route's own refusal). */
export function checkOriginUrl(repoUrl: string): Result<void> {
  return ORIGIN_URL.test(repoUrl)
    ? ok(undefined)
    : invalid(
        `repo url ${JSON.stringify(repoUrl)} must be https, ssh:// or user@host:path`,
      );
}

/** The name and url shape checks `POST /projects` runs before writing anything, less its folder
 * case (projects.local_roots, §14). `frm project add` checks only the name (a local path stays a
 * valid `--repo` there). */
export function parseProjectPlanInput(
  input: ProjectPlanInput,
): Result<ProjectPlanInput> {
  const name = checkProjectName(input.name);
  if (!name.ok) return name;
  const url = checkOriginUrl(input.repoUrl);
  if (!url.ok) return url;
  return ok(input);
}

export interface ProjectIds {
  readonly repo: string;
  readonly workspace: string;
  readonly builderProfile: string;
  readonly builder: string;
  readonly orchestrator: {
    readonly agent: string;
    readonly profile: string;
  } | null;
  readonly reviewer: {
    readonly agent: string;
    readonly profile: string;
    readonly runner: string;
  } | null;
}

/** `repos.id` = `workspaces.id` = `input.name`; every other id is derived, nothing asked twice. */
export function projectIds(input: ProjectPlanInput): ProjectIds {
  return {
    repo: input.name,
    workspace: input.name,
    builderProfile: `${input.name}-build`,
    builder: `${input.name}-builder`,
    orchestrator: input.orchestrator
      ? {
          agent: `${input.name}-orchestrator`,
          profile: `${input.name}-orchestrate`,
        }
      : null,
    reviewer:
      input.reviewerRunner === null
        ? null
        : {
            agent: `${input.name}-reviewer`,
            profile: `${input.name}-review`,
            runner: input.reviewerRunner,
          },
  };
}

export type AgentKind = "builder" | "orchestrator" | "reviewer";

/** One agent to write: its id, kind, profile and runner. */
export interface Staffed {
  readonly id: string;
  readonly kind: AgentKind;
  readonly profile: string;
  readonly runner: string;
}

/** Every agent the plan staffs: the builder always, the orchestrator and reviewer unless
 * suppressed. */
export function projectStaff(
  input: ProjectPlanInput,
  ids: ProjectIds,
): Staffed[] {
  return [
    {
      id: ids.builder,
      kind: "builder",
      profile: ids.builderProfile,
      runner: input.runner,
    },
    ...(ids.orchestrator === null
      ? []
      : [
          {
            id: ids.orchestrator.agent,
            kind: "orchestrator" as const,
            profile: ids.orchestrator.profile,
            runner: input.runner,
          },
        ]),
    ...(ids.reviewer === null
      ? []
      : [
          {
            id: ids.reviewer.agent,
            kind: "reviewer" as const,
            profile: ids.reviewer.profile,
            runner: ids.reviewer.runner,
          },
        ]),
  ];
}

export interface ProjectRepoPlan {
  readonly id: string;
  readonly name: string;
  readonly origin_url: string;
  readonly default_base_branch?: string;
}

export interface ProjectWorkspacePlan {
  readonly id: string;
  readonly name: string;
  readonly kind: "single";
}

export interface ProjectWorkspaceRepoPlan {
  readonly workspace_id: string;
  readonly repo_id: string;
  readonly rel_path: string;
}

/** A profile row short its allowlist/version/hash/`created_at`: `withProfileDefaults`
 * (`@bayon/proto`) fills those in, so both doors agree on what "the default allowlist" means. */
export interface ProjectProfilePlan {
  readonly id: string;
  readonly name: string;
  readonly runner_id: string;
  readonly model_tier: string;
}

/** An agent row short `created_at`: each door stamps it with its own `now`. */
export interface ProjectAgentPlan {
  readonly id: string;
  readonly name: string;
  readonly kind: AgentKind;
  readonly runner_id: string;
  readonly executor_id: string;
  readonly profile_id: string;
  readonly workspace_id: string;
}

export interface ProjectPlan {
  readonly repo: ProjectRepoPlan;
  readonly workspace: ProjectWorkspacePlan;
  readonly workspaceRepo: ProjectWorkspaceRepoPlan;
  readonly profiles: readonly ProjectProfilePlan[];
  readonly agents: readonly ProjectAgentPlan[];
}

/** The tier a project's profiles start on, by either door (and `projectAgentPlan`'s). */
export const DEFAULT_MODEL_TIER = "standard";

/** The rows a project's ids and staffing plan; no I/O, no `now`, no mirror path — those are the
 * door's to supply (`mirror_path` needs a home root, `created_at`/the hash need a clock). */
export function projectPlan(
  input: ProjectPlanInput,
  ids: ProjectIds,
): ProjectPlan {
  const staff = projectStaff(input, ids);
  return {
    repo: {
      id: ids.repo,
      name: ids.repo,
      origin_url: input.repoUrl,
      ...(input.base === undefined ? {} : { default_base_branch: input.base }),
    },
    workspace: { id: ids.workspace, name: ids.workspace, kind: "single" },
    workspaceRepo: {
      workspace_id: ids.workspace,
      repo_id: ids.repo,
      rel_path: ids.workspace,
    },
    profiles: staff.map((s) => ({
      id: s.profile,
      name: s.profile,
      runner_id: s.runner,
      model_tier: DEFAULT_MODEL_TIER,
    })),
    agents: staff.map((s) => ({
      id: s.id,
      name: s.id,
      kind: s.kind,
      runner_id: s.runner,
      executor_id: input.executor,
      profile_id: s.profile,
      workspace_id: ids.workspace,
    })),
  };
}
