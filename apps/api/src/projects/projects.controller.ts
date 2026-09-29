import {
  CreateProjectAgentRequest,
  CreateProjectRequest,
  PatchAgentRequest,
  PatchProjectRequest,
  type AgentView,
  type ProjectCreated,
  type ProjectPauseState,
  type ProjectSettingsState,
  type ProjectsView,
  type PushTargetsDetected,
} from "@bayon/proto";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { unwrap } from "../errors.js";
import { PROJECTS_SERVICE } from "../tokens.js";
import type { ProjectsService } from "./projects-service.js";

/** `POST /projects` (§9.5 amendment): 201 with the new project's ids, no command row
 * (nothing to claim), no `If-Match` (create carries none, as `POST /tickets`). */
@Controller("projects")
export class ProjectsController {
  readonly #projects: ProjectsService;

  constructor(@Inject(PROJECTS_SERVICE) projects: ProjectsService) {
    this.#projects = projects;
  }

  /** `GET /projects`: every project, read-only. */
  @Get()
  async list(): Promise<ProjectsView> {
    return unwrap(await this.#projects.list());
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body({ schema: CreateProjectRequest }) body: CreateProjectRequest,
  ): Promise<ProjectCreated> {
    return unwrap(await this.#projects.create(body));
  }

  /** `POST /projects/:id/agents`: 201 with the new builder, reviewer or orchestrator
   *. An unknown project: 404; an unregistered or disabled runner: 400; an orchestrator
   * while the project has an enabled one: 409 — each writing nothing. */
  @Post(":id/agents")
  @HttpCode(HttpStatus.CREATED)
  async addAgent(
    @Param("id") id: string,
    @Body({ schema: CreateProjectAgentRequest })
    body: CreateProjectAgentRequest,
  ): Promise<AgentView> {
    return unwrap(await this.#projects.addAgent(id, body));
  }

  /**
   * Pauses one project: its new spawns and its sessions' new turns wait
   * (`project_paused`) and its orchestrator does not pulse, while every other project runs on;
   * turns in flight and hand-off packets finish. Audited; the same state again changes nothing
   * (`changed: false`). An unknown project: 404.
   */
  @Post(":id/pause")
  @HttpCode(HttpStatus.OK)
  async pause(@Param("id") id: string): Promise<ProjectPauseState> {
    return unwrap(await this.#projects.setPaused(id, true));
  }

  /** Lifts a project's pause: admission's next recheck admits what it queued. Audited. */
  @Post(":id/resume")
  @HttpCode(HttpStatus.OK)
  async resume(@Param("id") id: string): Promise<ProjectPauseState> {
    return unwrap(await this.#projects.setPaused(id, false));
  }

  /**
   * What each of a folder project's repos would push to (039): its folder's own origin, read now,
   * credentials removed, beside the target stored. Writes nothing — saving one is `PATCH :id
   * {push_urls}`. An unknown project: 404.
   */
  @Post(":id/push-targets/detect")
  @HttpCode(HttpStatus.OK)
  async detectPushTargets(
    @Param("id") id: string,
  ): Promise<PushTargetsDetected> {
    return unwrap(await this.#projects.detectPushTargets(id));
  }

  /**
   * A project's own settings: `staff_approval` on makes its orchestrator's staffing a
   * proposal the operator answers in the inbox. Audited `project.set`; the same value again changes
   * nothing (`changed: false`). An unknown project: 404; any other field: 400.
   */
  @Patch(":id")
  async patch(
    @Param("id") id: string,
    @Body({ schema: PatchProjectRequest }) body: PatchProjectRequest,
  ): Promise<ProjectSettingsState> {
    return unwrap(await this.#projects.patch(id, body));
  }
}

/** `PATCH /agents/:id`: enable, disable or resize an agent; 404 for an unknown one.
 * Mounted with ProjectsController, on the same service. `/agents`' other routes
 * (`pulse-policies`, `:id/pulse-policy`) are AgentsController's; none of them matches `PATCH :id`. */
@Controller("agents")
export class AgentEditController {
  readonly #projects: ProjectsService;

  constructor(@Inject(PROJECTS_SERVICE) projects: ProjectsService) {
    this.#projects = projects;
  }

  @Patch(":id")
  async patch(
    @Param("id") id: string,
    @Body({ schema: PatchAgentRequest }) body: PatchAgentRequest,
  ): Promise<AgentView> {
    return unwrap(await this.#projects.setAgent(id, body));
  }
}
