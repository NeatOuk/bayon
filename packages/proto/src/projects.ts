import { NO_STEP_TIERS, RepoReachOutcome, StepTiers } from "@bayon/core";
import { z } from "zod";
import {
  DeliveryConfig,
  DeliveryConfigView,
  PushTargetPatch,
  PushTargetView,
} from "./delivery.js";
import { DocsSource, DocsSourceView } from "./docs.js";
import {
  DEFAULT_JIRA_PUSH_VIEW,
  JiraPushConfig,
  JiraPushView,
  JiraSource,
  JiraSourceView,
} from "./jira.js";
import { QaConfig, QaConfigView } from "./qa.js";
import { StepTiersInput, StepTiersPatch } from "./step-tiers.js";

// `POST /projects` (§9.5 amendment): one insert-only door onto the same five tables
// `frm project add` writes (repos, workspaces, workspace_repos, profiles, agents), for one project.
// `name`'s shape and `repo_url`'s shape are core's own checks (`checkProjectName`,
// `checkOriginUrl`), re-run server-side by `ProjectsService` — not duplicated here, so there is one
// place that decides what either looks like.

const rowId = z.string().min(1).max(64);

export const CreateProjectRequest = z.strictObject({
  name: z.string().min(1).max(32),
  repo_url: z.string().min(1).max(2_000),
  base_branch: z.string().min(1).max(200).optional(),
  runner_id: rowId,
  executor_id: rowId.default("local"),
  orchestrator: z.boolean().default(true),
  /** Absent: the reviewer runs on `runner_id`. Null: no reviewer. */
  reviewer_runner_id: rowId.nullable().optional(),
  /** The Jira issues it mirrors into its tickets; absent: none. */
  jira: JiraSource.optional(),
  /** Its QA harness; absent: none, which a project may configure later. */
  qa: QaConfig.optional(),
  /** Where its documentation lives; absent: none. */
  docs: DocsSource.optional(),
  /** How its finished work leaves; absent: `none`, and nothing is ever pushed. */
  delivery: DeliveryConfig.optional(),
  /** The tier each step of its work runs; a step absent or null inherits. */
  step_tiers: StepTiersInput.optional(),
  /**
   * Its sessions' model calls go through the context proxy (spec M12); absent: off. A
   * spawn then needs a certificate earned with compression on (`frm runner conformance …
   * --compression`).
   */
  context_compression: z.boolean().optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

export const ProjectCreated = z.object({
  repo_id: z.string(),
  workspace_id: z.string(),
  builder_agent_id: z.string(),
  orchestrator_agent_id: z.string().nullable(),
  reviewer_agent_id: z.string().nullable(),
  /** A folder with submodules: each submodule's repo, in its workspace. */
  submodule_repo_ids: z.array(z.string()),
  /**
   * What creation noticed and the operator should know (039): a folder origin that carried
   * credentials (removed, never stored), or one that is no remote a push can reach.
   */
  warnings: z.array(z.string()).default([]),
});
export type ProjectCreated = z.infer<typeof ProjectCreated>;

/** `POST /projects/repo-check`: the URL New project is about to use, and its base. */
export const RepoCheckRequest = z.strictObject({
  repo_url: z.string().min(1).max(2_000),
  base_branch: z.string().min(1).max(200).optional(),
});
export type RepoCheckRequest = z.infer<typeof RepoCheckRequest>;

/**
 * What the check found, in plain words. `ok`: a project on this URL (and base) can be
 * created. `outcome` null: the supervisor did not answer in time, so nothing was checked. `command`:
 * the one command that fixes it, when there is one (storing a forge token, trusting a host key).
 */
export const RepoCheckView = z.object({
  ok: z.boolean(),
  outcome: RepoReachOutcome.nullable(),
  message: z.string(),
  default_branch: z.string().nullable(),
  command: z.string().nullable(),
});
export type RepoCheckView = z.infer<typeof RepoCheckView>;

/** `GET /projects`: a project is a workspace, with its repos, agents and open tickets. */
export const ProjectRepoView = z.object({
  id: z.string(),
  origin_url: z.string().nullable(),
  /** Where its delivered work is pushed when that is not `origin_url` (039); null: the origin. */
  push_url: z.string().nullable(),
  /** Where it sits under a session's root. */
  rel_path: z.string(),
  /** A submodule workspace's dep: its path in the primary; null for the primary or a lone repo. */
  submodule_path: z.string().nullable(),
  default_base_branch: z.string(),
});
export type ProjectRepoView = z.infer<typeof ProjectRepoView>;

export const ProjectAgentView = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  runner_id: z.string(),
  enabled: z.boolean(),
  /** Its slots; 0, like `enabled: false`, is admission's `disabled` (shows and edits it). */
  max_concurrency: z.int().nonnegative(),
  /** The model its sessions run where their project names no tier for their step (   *): its role binding's tier, else its profile's; null when neither resolves to an
   * active model. */
  model: z.string().nullable().default(null),
  /** That model's row id, for its certification; null with `model`. */
  model_id: z.string().nullable().default(null),
  /** It has a mission (`agents.mission_id`): an orchestrator without one is not ready. */
  has_mission: z.boolean().default(false),
});
export type ProjectAgentView = z.infer<typeof ProjectAgentView>;

export const ProjectView = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["single", "multi", "submodule"]),
  repos: z.array(ProjectRepoView),
  agents: z.array(ProjectAgentView),
  /** Tickets not done or rejected. */
  open_tickets: z.int().nonnegative(),
  /**
   * A builder can take its tickets: staffing's own pick with every slot free — its own
   * enabled builder, or while it has none, a fleet builder on the builder binding's runners.
   */
  has_builder: z.boolean().default(false),
  /** An enabled reviewer can review its work: its own, or the fleet's while it has none. */
  has_reviewer: z.boolean().default(false),
  /** Paused: nothing new starts in it until it is resumed; other projects run on. */
  paused: z.boolean(),
  /**
   * Its orchestrator's staffing waits for the operator's approval: `ticket_staff` files a
   * proposal in the inbox instead of starting a session. The operator's own staffing never does.
   */
  staff_approval: z.boolean(),
  /** The Jira source it mirrors; null: none. */
  jira: JiraSourceView.nullable(),
  /** Its QA harness; `mode: "none"` for a project that runs none. */
  qa: QaConfigView,
  /** Where its documentation lives; `kind: "none"` for a project with none. */
  docs: DocsSourceView,
  /** How its finished work leaves; `mode: "none"` for a project that delivers none. */
  delivery: DeliveryConfigView,
  /**
   * What goes back to its Jira issues: status moves and pull-request comments. An
   * answer from before 041 has none: read as the default, moving nothing.
   */
  jira_push: JiraPushView.default(DEFAULT_JIRA_PUSH_VIEW),
  /**
   * The tier each step of its work runs: plan (`spike`), build (`build`,
   * `build_complex`, `fix`), review (`review`, every gate's reviewer); null inherits — the role
   * binding's tier, else the agent's profile's. An answer from before 048 has none.
   */
  step_tiers: StepTiers.default(NO_STEP_TIERS),
  /**
   * Its sessions' model calls go through the context proxy (spec M12), where the
   * runner, the executor and the role allow it; off by default. An answer from before 049 has none.
   */
  context_compression: z.boolean().default(false),
});
export type ProjectView = z.infer<typeof ProjectView>;

export const ProjectsView = z.object({ projects: z.array(ProjectView) });
export type ProjectsView = z.infer<typeof ProjectsView>;

/**
 * `POST /projects/:id/pause` and `POST /projects/:id/resume`: the project's state after
 * the call. While paused, its spawns and its sessions' next turns wait (`project_paused`) and its
 * orchestrator does not pulse; what is in flight finishes.
 */
export const ProjectPauseState = z.object({
  /** The project: its workspace's id. */
  project: z.string(),
  paused: z.boolean(),
  /** False when the project already was in that state: nothing was written or audited. */
  changed: z.boolean(),
});
export type ProjectPauseState = z.infer<typeof ProjectPauseState>;

/**
 * `PATCH /projects/:id`: a project's own settings,
 * each optional, at least one: its staffing approval, its Jira source (null turns the mirror off),
 * its QA harness and its documentation source.
 */
export const PatchProjectRequest = z
  .strictObject({
    staff_approval: z.boolean().optional(),
    jira: JiraSource.nullable().optional(),
    /** Its QA harness; `mode: "none"` turns the gate off. */
    qa: QaConfig.optional(),
    /** Where its documentation lives; `kind: "none"` turns the reader off. */
    docs: DocsSource.optional(),
    /**
     * Its delivery; `mode: "none"` turns it off. Setting anything else is the standing
     * §14 approval for the pushes and pull requests the job then makes, which is why it is an
     * audited operator write and never an agent's.
     */
    delivery: DeliveryConfig.optional(),
    /**
     * Where its repos' delivered work is pushed (039), one entry per repo to change; null pushes
     * to the origin again. Audited `project.set` with the rest.
     */
    push_urls: z.array(PushTargetPatch).min(1).max(64).optional(),
    /**
     * What goes back to its Jira issues: the status each moment moves an issue to, and
     * whether pull requests are commented. An audited operator write, never an agent's (§14).
     */
    jira_push: JiraPushConfig.optional(),
    /**
     * The tier each step of its work runs: the steps named change, null inherits again.
     * A role binding's own tier still wins at spawn. Audited `project.set` with the rest.
     */
    step_tiers: StepTiersPatch.optional(),
    /**
     * Context compression (spec M12): the sessions spawned after the change run their
     * model calls through the context proxy, each on a certificate earned with compression on. A
     * live session keeps what it was spawned with. Audited `project.set` with the rest.
     */
    context_compression: z.boolean().optional(),
  })
  .refine(
    (patch) => Object.keys(patch).length > 0,
    "a patch sets at least one setting",
  );
export type PatchProjectRequest = z.infer<typeof PatchProjectRequest>;

/** `PATCH /projects/:id`'s answer: the settings after the call, as the pause doors answer theirs. */
export const ProjectSettingsState = z.object({
  /** The project: its workspace's id. */
  project: z.string(),
  staff_approval: z.boolean(),
  jira: JiraSourceView.nullable(),
  qa: QaConfigView,
  docs: DocsSourceView,
  delivery: DeliveryConfigView,
  jira_push: JiraPushView.default(DEFAULT_JIRA_PUSH_VIEW),
  /** The tier each step runs after the call; null inherits. */
  step_tiers: StepTiers.default(NO_STEP_TIERS),
  /** Its context compression switch after the call. */
  context_compression: z.boolean().default(false),
  /** Every repo's push target after the call, primary first (039). */
  push_targets: z.array(PushTargetView).default([]),
  /**
   * The ticket `mode: "pending"` filed asking for a harness, by key; null when none was filed (any
   * other mode, or the project was already pending).
   */
  qa_ticket: z.string().nullable().default(null),
  /** False when the project already had these values: nothing was written or audited. */
  changed: z.boolean(),
});
export type ProjectSettingsState = z.infer<typeof ProjectSettingsState>;
