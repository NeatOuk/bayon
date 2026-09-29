import {
  checkOriginUrl,
  checkProjectName,
  err,
  ok,
  projectIds,
  ticketKey,
  type Clock,
  type FrmError,
  type Result,
} from "@bayon/core";
import {
  agentModels,
  getExecutor,
  getRepo,
  getRunner,
  getWorkspace,
  deliveryConfigOf,
  docsSourceOf,
  jiraPushOf,
  jiraSourceOf,
  listProjects,
  qaConfigOf,
  stepTiersOf,
  type Db,
} from "@bayon/db";
import {
  createProject,
  setProjectPaused,
  setProjectSettings,
} from "@bayon/db/api";
import {
  ProjectPauseState,
  ProjectSettingsState,
  type AgentView,
  type CreateProjectAgentRequest,
  type CreateProjectRequest,
  type PatchAgentRequest,
  type PatchProjectRequest,
  type ProjectCreated,
  type ProjectsView,
  type PushTargetsDetected,
} from "@bayon/proto";
import type { NewTicket } from "@bayon/db/api";
import { parseAs } from "../dto.js";
import { loadTicketSettings } from "../tickets/ticket-settings.js";
import { runGit, type GitRunner } from "../tickets/git-facts.js";
import { localProject, type LocalProject } from "./local-project.js";
import {
  detectFolderPushTargets,
  detectProjectPushTargets,
  warningsOf,
  withPushUrls,
  type FolderPushTargets,
} from "./push-target.js";
import { addProjectAgent, patchAgent } from "./project-agents.js";
import { toNewProject, toProjectPlanInput } from "./project-plan.js";
import { docsView } from "../docs/view.js";
import { qaHarnessTicket, qaView } from "./qa-harness-ticket.js";

// POST /projects (§9.5 amendment): every refusal in the ticket's list is checked, and
// writes nothing, before `createProject` runs. A class over {db, clock}, as GateService and
// TicketService are: this needs three reads (a repo, one or two runners, an executor) before its
// one write, which does not fit ApiStore's one-Result-per-DB-shape style.

export interface ProjectsServiceDeps {
  readonly db: Db;
  readonly clock: Clock;
  /** `$FRM_HOME/mirrors`; null without FRM_HOME, refused as a host-misconfiguration `validation`. */
  readonly mirrorsRoot: string | null;
  /** How git is run to read a folder's own origin (039); tests may hand in their own. */
  readonly git?: GitRunner;
}

/** An absolute path is a folder on this host, judged by `projects.local_roots` (§14); anything
 * else is a url, judged by its shape. */
const isFolder = (repoUrl: string): boolean => repoUrl.startsWith("/");

/** Who pauses, resumes or sets a project: the bearer is the operator's (§12.1). */
const OPERATOR = "operator";

const invalid = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

/** An unregistered runner or a missing executor answers `not_found` (§4 reads); this route means
 * "you asked for something that doesn't exist yet", not "the thing you named doesn't exist" — 400,
 * not 404. */
function asValidation(error: FrmError): FrmError {
  return error.class === "not_found"
    ? { ...error, class: "validation" }
    : error;
}

export class ProjectsService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #mirrorsRoot: string | null;
  readonly #git: GitRunner;

  constructor(deps: ProjectsServiceDeps) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#mirrorsRoot = deps.mirrorsRoot;
    this.#git = deps.git ?? runGit();
  }

  /** A url as it is; a folder as its real path, branch and submodules. */
  async #source(repoUrl: string): Promise<Result<LocalProject>> {
    if (isFolder(repoUrl)) return localProject(this.#db, repoUrl, this.#git);
    const url = checkOriginUrl(repoUrl);
    return url.ok ? ok({ origin: repoUrl, base: null, submodules: [] }) : url;
  }

  /** `POST /projects/:id/agents`: one more builder, reviewer or orchestrator, on the
   * runner asked. */
  addAgent(
    workspaceId: string,
    body: CreateProjectAgentRequest,
  ): Promise<Result<AgentView>> {
    return addProjectAgent(this.#db, this.#clock.now(), workspaceId, body);
  }

  /** `PATCH /agents/:id`: enabled and max_concurrency, nothing else. */
  setAgent(id: string, body: PatchAgentRequest): Promise<Result<AgentView>> {
    return patchAgent(this.#db, id, body);
  }

  /** `POST /projects/:id/pause|resume`: the project's hold, audited; an unknown one 404. */
  async setPaused(
    workspaceId: string,
    paused: boolean,
  ): Promise<Result<ProjectPauseState>> {
    const set = await setProjectPaused(this.#db, workspaceId, paused, OPERATOR);
    return set.ok
      ? parseAs(ProjectPauseState, set.value, `project ${workspaceId} pause`)
      : set;
  }

  /**
   * `PATCH /projects/:id`: its staffing
   * approval, Jira source (checked by proto `JiraSource`; null turns the mirror off), QA harness, …,
   * tier per step (proto `StepTiersPatch`) and context compression, audited in one `project.set`
   * row; unknown 404.
   *
   * "Bayon, build me one" (`qa.mode = "pending"`) files its ticket **inside the settings write**.
   * The columns are compiled here — the template, the rubric and the key prefix are the API's — and
   * the writer inserts them in the same transaction as the mode, only on the move into `pending`.
   * Filing afterwards was the bug the review found: a failure left the mode `pending` with no
   * ticket, and the retry, which files only on the transition, filed nothing.
   */
  async patch(
    workspaceId: string,
    body: PatchProjectRequest,
  ): Promise<Result<ProjectSettingsState>> {
    const ticket =
      body.qa?.mode === "pending"
        ? await this.#harnessTicket(workspaceId)
        : ok(undefined);
    if (!ticket.ok) return ticket;
    const set = await setProjectSettings(
      this.#db,
      workspaceId,
      {
        ...(body.staff_approval === undefined
          ? {}
          : { staff_approval: body.staff_approval }),
        ...(body.jira === undefined ? {} : { jira: body.jira }),
        ...(body.qa === undefined ? {} : { qa: body.qa }),
        ...(body.docs === undefined ? {} : { docs: body.docs }),
        ...(body.delivery === undefined ? {} : { delivery: body.delivery }),
        ...(body.push_urls === undefined ? {} : { push_urls: body.push_urls }),
        ...(body.jira_push === undefined ? {} : { jira_push: body.jira_push }),
        ...(body.step_tiers === undefined
          ? {}
          : { step_tiers: body.step_tiers }),
        ...(body.context_compression === undefined
          ? {}
          : { context_compression: body.context_compression }),
        ...(ticket.value === undefined ? {} : { qaTicket: ticket.value }),
      },
      OPERATOR,
    );
    if (!set.ok) return set;
    const key =
      set.value.qaTicket === null
        ? ok(null)
        : await this.#keyOf(set.value.qaTicket.num);
    if (!key.ok) return key;
    return parseAs(
      ProjectSettingsState,
      {
        ...set.value,
        qa: qaView(set.value.qa),
        docs: docsView(set.value.docs),
        qa_ticket: key.value,
      },
      `project ${workspaceId}`,
    );
  }

  /**
   * `POST /projects/:id/push-targets/detect` (039): what each folder repo's own origin proposes as
   * its push target, beside the one stored. Reads the folders; writes nothing.
   */
  async detectPushTargets(
    workspaceId: string,
  ): Promise<Result<PushTargetsDetected>> {
    const found = await detectProjectPushTargets(
      this.#db,
      workspaceId,
      this.#git,
    );
    return found.ok ? ok({ targets: found.value }) : found;
  }

  /** The harness ticket's columns for `workspaceId`, compiled but not yet written. */
  async #harnessTicket(workspaceId: string): Promise<Result<NewTicket>> {
    const workspace = await getWorkspace(this.#db, workspaceId);
    if (!workspace.ok) return workspace;
    return qaHarnessTicket(this.#db, workspace.value.name);
  }

  /** A filed ticket's key, as every other door spells one. */
  async #keyOf(num: number): Promise<Result<string>> {
    const settings = await loadTicketSettings(this.#db);
    return settings.ok
      ? ok(ticketKey(settings.value["tickets.key_prefix"], num))
      : settings;
  }

  /** Every workspace as a project. */
  async list(): Promise<Result<ProjectsView>> {
    const listed = await listProjects(this.#db);
    if (!listed.ok) return listed;
    const models = await agentModels(this.#db);
    if (!models.ok) return models;
    const modelOf = new Map(models.value.map((m) => [m.agent_id, m]));
    return ok({
      projects: listed.value.map((p) => ({
        id: p.workspace.id,
        name: p.workspace.name,
        kind: p.workspace.kind,
        repos: p.repos.map((r) => ({
          id: r.id,
          origin_url: r.origin_url,
          push_url: r.push_url,
          rel_path: r.rel_path,
          submodule_path: r.submodule_path,
          default_base_branch: r.default_base_branch,
        })),
        agents: p.agents.map((a) => ({
          id: a.id,
          name: a.name,
          kind: a.kind,
          runner_id: a.runner_id,
          enabled: a.enabled === 1,
          max_concurrency: a.max_concurrency,
          model: modelOf.get(a.id)?.model ?? null,
          model_id: modelOf.get(a.id)?.model_id ?? null,
        })),
        open_tickets: p.openTickets,
        paused: p.workspace.paused === 1,
        staff_approval: p.workspace.staff_approval === 1,
        jira: jiraSourceOf(p.workspace),
        qa: qaView(qaConfigOf(p.workspace)),
        docs: docsView(docsSourceOf(p.workspace)),
        delivery: deliveryConfigOf(p.workspace),
        jira_push: jiraPushOf(p.workspace),
        step_tiers: stepTiersOf(p.workspace),
        context_compression: p.workspace.context_compression === 1,
      })),
    });
  }

  async create(body: CreateProjectRequest): Promise<Result<ProjectCreated>> {
    if (this.#mirrorsRoot === null) {
      return invalid("no FRM_HOME: set it before creating a project");
    }
    const asked = toProjectPlanInput(body);
    const name = checkProjectName(asked.name);
    if (!name.ok) return name;
    const source = await this.#source(asked.repoUrl);
    if (!source.ok) return source;
    const { origin, base, submodules } = source.value;
    if (isFolder(asked.repoUrl) && asked.base === undefined && base === null) {
      return invalid(
        `${origin} is on no branch and has no main or master: check one out, or give a base branch`,
      );
    }
    const input = {
      ...asked,
      repoUrl: origin,
      // An explicit base wins; a folder otherwise brings the branch it is on.
      ...(asked.base === undefined && base !== null ? { base } : {}),
    };

    const existing = await getRepo(this.#db, input.name);
    if (existing.ok) {
      return err({
        class: "conflict",
        message: `project ${input.name} already exists (repo ${input.name})`,
        retryable: false,
      });
    }
    if (existing.error.class !== "not_found") return existing;

    const runnerIds = new Set(
      input.reviewerRunner === null
        ? [input.runner]
        : [input.runner, input.reviewerRunner],
    );
    for (const runnerId of runnerIds) {
      const runner = await getRunner(this.#db, runnerId);
      if (!runner.ok) return err(asValidation(runner.error));
    }
    const executor = await getExecutor(this.#db, input.executor);
    if (!executor.ok) return err(asValidation(executor.error));
    if (executor.value.enabled !== 1) {
      return invalid(`executor ${input.executor} is disabled`);
    }

    const ids = projectIds(input);
    const now = this.#clock.now();
    const planned = await toNewProject(
      input,
      ids,
      this.#mirrorsRoot,
      now,
      submodules,
      body.jira,
      body.qa,
      body.docs,
      body.delivery,
      body.step_tiers,
      body.context_compression,
    );
    // A documentation source with no site and no Jira source to take one from is refused here, with
    // the same sentence PATCH gives, rather than as 037's CHECK text.
    if (!planned.ok) return planned;
    // A folder's own origin, and each submodule checkout's, as the repos' push targets (039). A URL
    // project is not probed: its origin already is its remote.
    const pushTargets: FolderPushTargets | null = isFolder(asked.repoUrl)
      ? await detectFolderPushTargets(this.#git, origin, submodules)
      : null;
    const project =
      pushTargets === null
        ? planned.value
        : withPushUrls(planned.value, pushTargets);
    const depIds = project.submodules.map((d) => String(d.repo.id));
    const clash = depIds.find((id, i) => depIds.indexOf(id) !== i);
    if (clash !== undefined) {
      return invalid(`two submodules would both be repo ${clash}`);
    }
    const written = await createProject(this.#db, project);
    if (!written.ok) return written;
    return ok({
      repo_id: ids.repo,
      workspace_id: ids.workspace,
      builder_agent_id: ids.builder,
      orchestrator_agent_id: ids.orchestrator?.agent ?? null,
      reviewer_agent_id: ids.reviewer?.agent ?? null,
      submodule_repo_ids: depIds,
      warnings: pushTargets === null ? [] : warningsOf(pushTargets),
    });
  }
}
