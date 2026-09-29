import { JIRA_TOKEN_SECRET, err, ok, type Result } from "@bayon/core";
import { getWorkspace, jiraSourceOf, lastJiraSync, type Db } from "@bayon/db";
import {
  JiraSyncRecord,
  type JiraStatuses,
  type JiraSyncResult,
  type JiraTokenStatus,
  type ProjectJiraView,
} from "@bayon/proto";
import type { Fetch } from "../atlassian/client.js";
import { jsonColumn, parseAs } from "../dto.js";
import { JIRA_PUSH_TIMEOUT_MS } from "./push-deliver.js";
import { callFor, listStatuses } from "./push-client.js";
import type { JiraSync } from "./sync.js";
import {
  jiraTokenStatus,
  storeTokenHint,
  type JiraTokenStore,
} from "./token.js";

// `GET /projects/:id/jira` and `POST /projects/:id/jira/sync`: the project's source
// with its last sync, read from the newest `jira.sync` audit row; and a sync on the button. And
// `GET /jira`: whether the token is in the host store, before any project has a source. And
// `GET /projects/:id/jira/statuses`: the site's status names, for the push settings.

export interface JiraServiceDeps {
  readonly db: Db;
  readonly sync: JiraSync;
  /** The store the sync reads the token from: the same one, so `present` tells the truth. */
  readonly token: JiraTokenStore;
  /** Global fetch in production; tests inject one. */
  readonly fetch?: Fetch;
}

const notFound = (workspaceId: string) =>
  err({
    class: "not_found" as const,
    message: `project ${workspaceId} does not exist`,
    retryable: false,
  });

export class JiraService {
  readonly #db: Db;
  readonly #sync: JiraSync;
  readonly #token: JiraTokenStore;
  readonly #fetch: Fetch;

  constructor(deps: JiraServiceDeps) {
    this.#db = deps.db;
    this.#sync = deps.sync;
    this.#token = deps.token;
    this.#fetch = deps.fetch ?? ((url, init) => fetch(url, init));
  }

  /** Whether a sync could read the token now; a boolean, never the value. */
  token(): Promise<JiraTokenStatus> {
    return jiraTokenStatus(this.#token);
  }

  /** The source and the last sync; an unknown project is not_found. */
  async status(workspaceId: string): Promise<Result<ProjectJiraView>> {
    const workspace = await getWorkspace(this.#db, workspaceId);
    if (!workspace.ok) {
      return workspace.error.class === "not_found"
        ? notFound(workspaceId)
        : workspace;
    }
    const last = await lastJiraSync(this.#db, workspaceId);
    if (!last.ok) return last;
    const source = jiraSourceOf(workspace.value);
    if (last.value === null) return ok({ source, last_sync: null });
    const payload = jsonColumn(last.value.payload_json, "jira.sync payload");
    if (!payload.ok) return payload;
    const record = parseAs(JiraSyncRecord, payload.value, "jira.sync payload");
    return record.ok
      ? ok({ source, last_sync: { ...record.value, at: last.value.ts } })
      : record;
  }

  /**
   * The status names the project's Jira site offers, for its push settings' fields. An unknown
   * project is not_found, one with no source a conflict; the token is read now and dropped.
   */
  async statuses(workspaceId: string): Promise<Result<JiraStatuses>> {
    const workspace = await getWorkspace(this.#db, workspaceId);
    if (!workspace.ok)
      return workspace.error.class === "not_found"
        ? notFound(workspaceId)
        : workspace;
    const source = jiraSourceOf(workspace.value);
    if (source === null)
      return err({
        class: "conflict",
        message: `project ${workspaceId} has no Jira source`,
        retryable: false,
      });
    const token = await this.#token.secrets.get(JIRA_TOKEN_SECRET);
    if (!token.ok)
      return err({
        class: "validation",
        message: `${JIRA_TOKEN_SECRET} could not be read from the host secret store: ${storeTokenHint(this.#token)}`,
        retryable: false,
      });
    const listed = await listStatuses(
      callFor(
        source.url,
        { email: source.email, token: token.value },
        { fetch: this.#fetch, timeoutMs: JIRA_PUSH_TIMEOUT_MS },
      ),
    );
    return listed.ok ? ok({ statuses: listed.value }) : listed;
  }

  /** A sync now, from the button. */
  sync(workspaceId: string): Promise<Result<JiraSyncResult>> {
    return this.#sync.run(workspaceId, "rest");
  }
}
