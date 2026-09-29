import type { ErrorClass } from "@bayon/core";
import type {
  JiraStatuses,
  JiraSyncResult,
  JiraTokenStatus,
  ProjectJiraView,
} from "@bayon/proto";
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
} from "@nestjs/common";
import { FrmHttpError, unwrap } from "../errors.js";
import { JIRA_SERVICE } from "../tokens.js";
import type { JiraService } from "./service.js";

/**
 * A failed sync's status: Jira's own failures are a bad gateway, a Jira that never answered a
 * gateway timeout, a sync cut short by the API stopping unavailable; the rest as every route maps
 * its class (400 for a refused token or query, 404, 409).
 */
const SYNC_STATUS: Readonly<Partial<Record<ErrorClass, number>>> = {
  runner_error: HttpStatus.BAD_GATEWAY,
  timeout: HttpStatus.GATEWAY_TIMEOUT,
  interrupted: HttpStatus.SERVICE_UNAVAILABLE,
};

/**
 * A project's Jira mirror, one way, Jira → Bayon: `GET /projects/:id/jira` and
 * `POST /projects/:id/jira/sync`. Mounted beside ProjectsController on the same prefix, no route of
 * which it shadows.
 */
@Controller("projects")
export class JiraController {
  readonly #jira: JiraService;

  constructor(@Inject(JIRA_SERVICE) jira: JiraService) {
    this.#jira = jira;
  }

  /** The source and the last sync (null before the first); an unknown project 404. */
  @Get(":id/jira")
  async status(@Param("id") id: string): Promise<ProjectJiraView> {
    return unwrap(await this.#jira.status(id));
  }

  /**
   * The status names the project's Jira site offers, for the push settings: 404 for an
   * unknown project, 409 for one with no source, 400 for a refused token, 502/504 for Jira failing.
   */
  @Get(":id/jira/statuses")
  async statuses(@Param("id") id: string): Promise<JiraStatuses> {
    const listed = await this.#jira.statuses(id);
    if (listed.ok) return listed.value;
    const status = SYNC_STATUS[listed.error.class];
    throw status === undefined
      ? new FrmHttpError(listed.error)
      : new FrmHttpError(listed.error, status);
  }

  /**
   * Syncs now and answers its counts. An unknown project 404; one with no Jira source, or already
   * syncing, 409; a refused token or query 400; Jira failing 502, not answering 504. Each run that
   * reached Jira is audited `jira.sync`, failed or not.
   */
  @Post(":id/jira/sync")
  @HttpCode(HttpStatus.OK)
  async sync(@Param("id") id: string): Promise<JiraSyncResult> {
    const synced = await this.#jira.sync(id);
    if (synced.ok) return synced.value;
    const status = SYNC_STATUS[synced.error.class];
    throw status === undefined
      ? new FrmHttpError(synced.error)
      : new FrmHttpError(synced.error, status);
  }
}

/**
 * `GET /jira`: whether the host secret store holds JIRA_API_TOKEN where a sync would
 * look, and which store that is. Global: the New project form asks before any project exists.
 * Only a boolean leaves; the value is read and dropped.
 */
@Controller("jira")
export class JiraTokenController {
  readonly #jira: JiraService;

  constructor(@Inject(JIRA_SERVICE) jira: JiraService) {
    this.#jira = jira;
  }

  @Get()
  token(): Promise<JiraTokenStatus> {
    return this.#jira.token();
  }
}
