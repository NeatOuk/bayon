import {
  JIRA_FIELDS,
  JIRA_TODO,
  JIRA_TOKEN_SECRET,
  complexityColumns,
  deltaJql,
  err,
  jiraHost,
  mapIssue,
  ok,
  type ComplexityColumns,
  type FrmError,
  type JiraIssue,
  type JiraMirrorItem,
  type JiraSourceFields,
  type Result,
} from "@bayon/core";
import {
  getWorkspace,
  jiraSourceOf,
  mirroredOpenFingerprints,
  type Db,
} from "@bayon/db";
import {
  appendAudit,
  mirrorJiraPage,
  parkDepartedJira,
  type Decide,
  type JiraDeparted,
  type JiraSkipped,
} from "@bayon/db/api";
import type {
  JiraQuickSyncRecord,
  JiraSyncRecord,
  JiraSyncResult,
  JiraSyncVia,
} from "@bayon/proto";
import { lawDecider } from "../tickets/law-decider.js";
import { loadGateSettings } from "../tickets/law-facts.js";
import { loadTicketSettings } from "../tickets/ticket-settings.js";
import {
  JIRA_MAX_ISSUES,
  JIRA_MESSAGE_MAX,
  JIRA_PAGE_SIZE,
  JIRA_TIMEOUT_MS,
  getByIds,
  scrubSecret,
  searchJql,
  type Fetch,
  type JiraAuth,
  type JiraClientOptions,
} from "./client.js";
import { storeTokenHint, type JiraTokenStore } from "./token.js";

// One project's Jira mirror, one way: its JQL's To Do issues become backlog tickets,
// kept in step while Bayon has not started them, and parked when they leave. A run is idempotent;
// a page is one transaction, so a failure leaves the pages before it committed and the next run
// converges. Every run that reaches Jira ends in exactly one `jira.sync` audit row, which lands in
// the project's history.
//
// The token is read from the host secret store here, at sync time, and goes into the client's
// Authorization header and nowhere else: not a log line, an audit payload, an error or a response.
//
// Pausing the fleet or the project does not stop a sync: the mirror spawns nothing, it only files
// and tidies tickets, which a paused project may still hold.
//
// Between full runs the timer runs a quick pass (`quick()`): the same run over only the
// issues updated within a window, which files and updates but never parks, since a ticket missing
// from a partial result has not left the query. It holds the same one-run-per-project lock. It is
// audited `jira.quick_sync` only when it wrote something, and never as `jira.sync`: that row is the
// project's last (full) sync, which the GUI shows and the notifier's failure rule reads.

export interface JiraLogger {
  warn(message: string): void;
  error(message: string): void;
}

export interface JiraSyncDeps {
  readonly db: Db;
  /** The host secret store (token.ts): JIRA_API_TOKEN is read on every run, never kept. */
  readonly token: JiraTokenStore;
  /** Global fetch in production; tests point it at a fixture server. */
  readonly fetch?: Fetch;
  readonly timeoutMs?: number;
  /** The most issues one run reads (JIRA_MAX_ISSUES); past it the run is `capped`. */
  readonly maxIssues?: number;
  /** The most issues one quick pass reads (JIRA_QUICK_MAX_ISSUES); past it, it is `capped`. */
  readonly maxQuickIssues?: number;
  /** An issue into its mirror ticket (core mapIssue); tests inject one that throws. */
  readonly map?: (issue: JiraIssue, site: string) => JiraMirrorItem;
  readonly logger?: JiraLogger;
}

/** A skipped list longer than this is cut in the result and its audit row. */
export const JIRA_SKIPPED_KEPT = 100;
/** A quick pass reads one page normally; past this many, the next full sync catches up. */
export const JIRA_QUICK_MAX_PAGES = 5;
export const JIRA_QUICK_MAX_ISSUES = JIRA_QUICK_MAX_PAGES * JIRA_PAGE_SIZE;
/** The quick pass's audit action; the full run's is `jira.sync`. */
export const JIRA_QUICK_ACTION = "jira.quick_sync";

/** A quick pass's counts: no `parked`, since it never parks. */
export type JiraQuickResult = Omit<JiraQuickSyncRecord, "ok" | "error"> & {
  readonly project: string;
};
/** A Jira status name, as a park's note quotes it. */
const STATUS_NAME_MAX = 100;

const QUIET: JiraLogger = { warn: () => undefined, error: () => undefined };

interface Counts {
  /** Issues read from Jira, before the To Do filter. */
  matched: number;
  created: number;
  updated: number;
  unchanged: number;
  parked: number;
  ignored: number;
  skipped: JiraSkipped[];
  capped: boolean;
}

const noCounts = (): Counts => ({
  matched: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  parked: 0,
  ignored: 0,
  skipped: [],
  capped: false,
});

/** What one run reads, and whether it may park: only a run that read the whole query may. */
interface Pass {
  readonly jql: string;
  readonly maxIssues: number;
  readonly departs: boolean;
}

interface Source {
  readonly workspaceId: string;
  readonly source: JiraSourceFields;
  readonly host: string;
}

/** What one run needs besides the source: the token, the new-ticket columns, the park's laws. */
interface Ready {
  readonly auth: JiraAuth;
  readonly complexity: ComplexityColumns;
  readonly decide: Decide;
}

const moved = (status: string): string =>
  `moved to ${status.slice(0, STATUS_NAME_MAX)} in Jira`;
const GONE = "no longer visible in Jira";
const UNMATCHED = "no longer matches the project's Jira query";

const capMessage = (message: string): string =>
  message.length <= JIRA_MESSAGE_MAX
    ? message
    : `${message.slice(0, JIRA_MESSAGE_MAX - 1)}…`;

/** An error as the audit row keeps it: class, capped message, retryable; never its cause. */
const stored = (e: FrmError) => ({
  class: e.class,
  message: capMessage(e.message),
  retryable: e.retryable,
});

/**
 * Whatever a run threw, as a typed error: `internal`, not retryable, its message capped and
 * scrubbed of the token when the run had read one. Never its cause or stack.
 */
function unexpected(
  workspaceId: string,
  thrown: unknown,
  auth?: JiraAuth,
): FrmError {
  const said =
    thrown instanceof Error ? thrown.message : "a non-error was thrown";
  const message = `the Jira sync of ${workspaceId} failed unexpectedly: ${said}`;
  return {
    class: "internal",
    message: capMessage(
      auth === undefined ? message : scrubSecret(message, auth),
    ),
    retryable: false,
  };
}

export class JiraSync {
  readonly #db: Db;
  readonly #token: JiraTokenStore;
  readonly #fetch: Fetch;
  readonly #timeoutMs: number;
  readonly #maxIssues: number;
  readonly #maxQuickIssues: number;
  readonly #map: NonNullable<JiraSyncDeps["map"]>;
  readonly #logger: JiraLogger;
  /** The projects syncing now: one run per project at a time, full or quick. */
  readonly #running = new Set<string>();
  /** The projects whose last quick pass failed: a failure is logged once, not once a minute. */
  readonly #quickFailing = new Set<string>();

  constructor(deps: JiraSyncDeps) {
    this.#db = deps.db;
    this.#token = deps.token;
    this.#fetch = deps.fetch ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = deps.timeoutMs ?? JIRA_TIMEOUT_MS;
    this.#maxIssues = deps.maxIssues ?? JIRA_MAX_ISSUES;
    this.#maxQuickIssues = deps.maxQuickIssues ?? JIRA_QUICK_MAX_ISSUES;
    this.#map = deps.map ?? mapIssue;
    this.#logger = deps.logger ?? QUIET;
  }

  isRunning(workspaceId: string): boolean {
    return this.#running.has(workspaceId);
  }

  /**
   * Syncs project `workspaceId`. Refused before anything runs: an unknown project (not_found), one
   * with no Jira source or already syncing (conflict). Otherwise the run is audited `jira.sync`,
   * and its counts or its error come back.
   */
  run(
    workspaceId: string,
    via: JiraSyncVia,
    signal?: AbortSignal,
  ): Promise<Result<JiraSyncResult>> {
    return this.#locked(workspaceId, (s) => this.#audited(s, via, signal));
  }

  /**
   * A quick pass over project `workspaceId` (the timer's): the issues its query matches
   * that were updated in the last `minutes`, filed and updated as `run()` does, and nothing parked.
   * Refused as `run()` refuses, and while a run of either kind holds the project. Audited
   * `jira.quick_sync` only when it created or updated a ticket.
   */
  quick(
    workspaceId: string,
    minutes: number,
    signal?: AbortSignal,
  ): Promise<Result<JiraQuickResult>> {
    if (!Number.isInteger(minutes) || minutes < 1) {
      return Promise.resolve(
        err({
          class: "validation",
          message: `a quick Jira pass looks back a whole number of minutes, not ${String(minutes)}`,
          retryable: false,
        }),
      );
    }
    return this.#locked(workspaceId, (s) =>
      this.#quickAudited(s, minutes, signal),
    );
  }

  /** `pass` over the project's source, holding its lock; refused while another run holds it. */
  async #locked<T>(
    workspaceId: string,
    pass: (s: Source) => Promise<Result<T>>,
  ): Promise<Result<T>> {
    if (this.#running.has(workspaceId)) {
      return err({
        class: "conflict",
        message: `a Jira sync of project ${workspaceId} is already running`,
        retryable: true,
      });
    }
    this.#running.add(workspaceId);
    try {
      const source = await this.#source(workspaceId);
      return source.ok ? await pass(source.value) : source;
    } catch (thrown) {
      // A throw from past the run itself (the source read, the audit write): typed, logged.
      const error = unexpected(workspaceId, thrown);
      this.#logger.error(error.message);
      return err(error);
    } finally {
      this.#running.delete(workspaceId);
    }
  }

  async #source(workspaceId: string): Promise<Result<Source>> {
    const workspace = await getWorkspace(this.#db, workspaceId);
    if (!workspace.ok) {
      return workspace.error.class === "not_found"
        ? err({
            class: "not_found",
            message: `project ${workspaceId} does not exist`,
            retryable: false,
          })
        : workspace;
    }
    const source = jiraSourceOf(workspace.value);
    return source === null
      ? err({
          class: "conflict",
          message: `project ${workspaceId} has no Jira source: add one under Jira in the project's settings`,
          retryable: false,
        })
      : ok({ workspaceId, source, host: jiraHost(source.url) });
  }

  async #audited(
    s: Source,
    via: JiraSyncVia,
    signal: AbortSignal | undefined,
  ): Promise<Result<JiraSyncResult>> {
    const counts = noCounts();
    const outcome = await this.#mirror(
      s,
      counts,
      { jql: s.source.jql, maxIssues: this.#maxIssues, departs: true },
      signal,
    );
    const kept = {
      ...counts,
      skipped: counts.skipped.slice(0, JIRA_SKIPPED_KEPT),
    };
    const record: JiraSyncRecord = {
      via,
      ok: outcome.ok,
      ...kept,
      ...(outcome.ok ? {} : { error: stored(outcome.error) }),
    };
    const audit = await appendAudit(this.#db, {
      actor: "operator",
      action: "jira.sync",
      target_kind: "project",
      target_id: s.workspaceId,
      payload: record,
    });
    if (!outcome.ok) {
      this.#logger.warn(
        `jira sync of ${s.workspaceId} (${via}) failed: ${outcome.error.class}: ${stored(outcome.error).message}`,
      );
      return outcome;
    }
    if (!audit.ok) {
      this.#logger.error(
        `jira sync of ${s.workspaceId}: its audit row was not written: ${audit.error.message}`,
      );
      return audit;
    }
    return ok({ project: s.workspaceId, ...kept });
  }

  async #quickAudited(
    s: Source,
    minutes: number,
    signal: AbortSignal | undefined,
  ): Promise<Result<JiraQuickResult>> {
    const counts = noCounts();
    const outcome = await this.#mirror(
      s,
      counts,
      {
        jql: deltaJql(s.source.jql, minutes),
        maxIssues: this.#maxQuickIssues,
        departs: false,
      },
      signal,
    );
    this.#noteQuick(s.workspaceId, outcome);
    const kept = {
      window_minutes: minutes,
      matched: counts.matched,
      created: counts.created,
      updated: counts.updated,
      unchanged: counts.unchanged,
      ignored: counts.ignored,
      skipped: counts.skipped.slice(0, JIRA_SKIPPED_KEPT),
      capped: counts.capped,
    };
    // Nothing written, nothing to attribute: a quiet project adds no row a minute.
    if (counts.created + counts.updated > 0) {
      const record: JiraQuickSyncRecord = {
        ...kept,
        ok: outcome.ok,
        ...(outcome.ok ? {} : { error: stored(outcome.error) }),
      };
      const audit = await appendAudit(this.#db, {
        actor: "operator",
        action: JIRA_QUICK_ACTION,
        target_kind: "project",
        target_id: s.workspaceId,
        payload: record,
      });
      if (!audit.ok) {
        this.#logger.error(
          `quick jira pass of ${s.workspaceId}: its audit row was not written: ${audit.error.message}`,
        );
        if (outcome.ok) return audit;
      }
    }
    return outcome.ok ? ok({ project: s.workspaceId, ...kept }) : outcome;
  }

  /**
   * A failed quick pass is logged on the first failure of a streak only: an outage is one line, not
   * one a minute. It is not audited unless it wrote something; the next full run, reading the same
   * Jira with the same token, audits the failure and notifies it.
   */
  #noteQuick(workspaceId: string, outcome: Result<void>): void {
    if (outcome.ok) {
      this.#quickFailing.delete(workspaceId);
      return;
    }
    if (this.#quickFailing.has(workspaceId)) return;
    this.#quickFailing.add(workspaceId);
    this.#logger.warn(
      `quick jira pass of ${workspaceId} failed: ${outcome.error.class}: ${stored(outcome.error).message} (logged once until a quick pass works again; the full sync audits it)`,
    );
  }

  async #ready(s: Source): Promise<Result<Ready>> {
    const token = await this.#token.secrets.get(JIRA_TOKEN_SECRET);
    if (!token.ok) {
      return err({
        class: "validation",
        message: `${JIRA_TOKEN_SECRET} could not be read from the host secret store (${token.error.message}): ${storeTokenHint(this.#token)}`,
        retryable: false,
      });
    }
    const settings = await loadTicketSettings(this.#db);
    if (!settings.ok) return settings;
    const complexity = await complexityColumns(
      {},
      settings.value["complexity.rubric"],
    );
    if (!complexity.ok) return complexity;
    const gates = await loadGateSettings(this.#db);
    return ok({
      auth: { email: s.source.email, token: token.value },
      complexity: complexity.value,
      decide: lawDecider(
        { kind: "operator" },
        { to: "parked" },
        "park",
        undefined,
        gates,
      ),
    });
  }

  /**
   * The run itself, filling `counts` as it goes, so a failure still reports what it wrote. Anything
   * it throws comes back as a typed error, so the run's audit row is written all the same.
   */
  async #mirror(
    s: Source,
    counts: Counts,
    pass: Pass,
    signal: AbortSignal | undefined,
  ): Promise<Result<void>> {
    let auth: JiraAuth | undefined;
    try {
      const ready = await this.#ready(s);
      if (!ready.ok) return ready;
      auth = ready.value.auth;
      return await this.#pages(s, ready.value, counts, pass, signal);
    } catch (thrown) {
      return err(unexpected(s.workspaceId, thrown, auth));
    }
  }

  async #pages(
    s: Source,
    ready: Ready,
    counts: Counts,
    pass: Pass,
    signal: AbortSignal | undefined,
  ): Promise<Result<void>> {
    const client: JiraClientOptions = {
      fetch: this.#fetch,
      timeoutMs: this.#timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    };
    /** Every fingerprint in the result, and the status name of each that is not To Do. */
    const seen = new Set<string>();
    const started = new Map<string, string>();
    const searched = await searchJql(
      s.source.url,
      ready.auth,
      pass.jql,
      JIRA_FIELDS,
      {
        ...client,
        maxIssues: pass.maxIssues,
        onPage: async (issues) => {
          const items = issues.map((i) => this.#map(i, s.source.url));
          counts.matched += items.length;
          for (const item of items) {
            seen.add(item.fingerprint);
            if (item.status_category !== JIRA_TODO)
              started.set(item.fingerprint, item.status_name);
          }
          const todo = items.filter((i) => i.status_category === JIRA_TODO);
          counts.ignored += items.length - todo.length;
          if (todo.length === 0) return ok(undefined);
          const page = await mirrorJiraPage(this.#db, {
            workspaceId: s.workspaceId,
            host: s.host,
            items: todo,
            complexity: ready.complexity,
          });
          if (!page.ok) return page;
          counts.created += page.value.created;
          counts.updated += page.value.updated;
          counts.unchanged += page.value.unchanged;
          counts.skipped.push(...page.value.skipped);
          return ok(undefined);
        },
      },
    );
    if (!searched.ok) return searched;
    counts.capped = searched.value.capped;
    // An incomplete result says nothing about what left it: nothing departs. A quick pass's result
    // is never complete (only what changed in its window), so it never parks.
    if (!pass.departs || searched.value.capped) return ok(undefined);
    const departed = await this.#departed(s, ready.auth, client, seen, started);
    if (!departed.ok) return departed;
    if (departed.value.length === 0) return ok(undefined);
    const parked = await parkDepartedJira(this.#db, {
      workspaceId: s.workspaceId,
      host: s.host,
      departed: departed.value,
      decide: ready.decide,
    });
    if (!parked.ok) return parked;
    counts.parked = parked.value.parked;
    return ok(undefined);
  }

  /**
   * The project's unstarted mirrored tickets whose issue is no longer a To Do issue of its query,
   * each with why: moved on in Jira, gone from sight, or outside a query that changed.
   */
  async #departed(
    s: Source,
    auth: JiraAuth,
    client: JiraClientOptions,
    seen: ReadonlySet<string>,
    started: ReadonlyMap<string, string>,
  ): Promise<Result<readonly JiraDeparted[]>> {
    const open = await mirroredOpenFingerprints(
      this.#db,
      s.workspaceId,
      s.host,
    );
    if (!open.ok) return open;
    const inResult = open.value.flatMap((o) => {
      const status = started.get(o.fingerprint);
      return status === undefined
        ? []
        : [{ fingerprint: o.fingerprint, reason: moved(status) }];
    });
    const missing = open.value.filter((o) => !seen.has(o.fingerprint));
    if (missing.length === 0) return ok(inResult);
    const found = await getByIds(
      s.source.url,
      auth,
      missing.map((m) => m.issueId),
      JIRA_FIELDS,
      client,
    );
    if (!found.ok) return found;
    const byId = new Map(found.value.map((i) => [i.id, i]));
    const outside = missing.map((m) => {
      const issue = byId.get(m.issueId);
      const reason =
        issue === undefined
          ? GONE
          : issue.fields.status.statusCategory.key === JIRA_TODO
            ? UNMATCHED
            : moved(issue.fields.status.name);
      return { fingerprint: m.fingerprint, reason };
    });
    return ok([...inResult, ...outside]);
  }
}
