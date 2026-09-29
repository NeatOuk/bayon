import {
  err,
  ok,
  systemClock,
  type Clock,
  type FrmError,
  type Result,
} from "@bayon/core";
import {
  ApiErrorBody,
  BudgetView,
  BudgetsView,
  CommandAccepted,
  CommandView,
  EVENTS_PAGE_MAX_LIMIT,
  EventsPage,
  ExecutorHealthAccepted,
  ExecutorsView,
  ExportRunAccepted,
  Fleet,
  FleetPauseState,
  Health,
  IDEMPOTENCY_HEADER,
  MissionVersion,
  PulseRunAccepted,
  RoleBindingView,
  RunnerConformanceAccepted,
  RunnersView,
  SessionView,
  TicketDetail,
  TicketView,
  type CreateTicketRequest,
  type EventItem,
  type MissionSaveRequest,
  type PutBudget,
  type PutRoleBinding,
  type RunnerConformanceRequest,
  type SpawnRequest,
  type StopMode,
  type TransitionRequest,
} from "@bayon/proto";
import { z } from "zod";
import { within } from "./deadline.js";

// The /api/v1 calls the smoke makes, as the operator would (§12.1). Every reply is zod-parsed.

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** One page's own deadline: a single GET must answer within this even under load. */
export const EVENTS_PAGE_TIMEOUT_MS = 15_000;

/**
 * `events()` stops paging here even if the API keeps saying `has_more: true`. A smoke session's
 * handful of events fits in one or two pages of `EVENTS_PAGE_MAX_LIMIT`; a server stuck forever
 * reporting more must not spin this loop forever with it.
 */
export const EVENTS_MAX_PAGES = 50;

export interface ApiClient {
  health(): Promise<Result<Health>>;
  spawn(body: SpawnRequest, key: string): Promise<Result<CommandAccepted>>;
  stop(
    sessionId: string,
    mode: StopMode,
    key: string,
  ): Promise<Result<CommandAccepted>>;
  command(id: string): Promise<Result<CommandView>>;
  session(id: string): Promise<Result<SessionView>>;
  /** Every stored event of the session, paging until `has_more` is false. */
  events(sessionId: string): Promise<Result<EventItem[]>>;
  /** `POST /missions/:agent`: a new mission version for the agent named `agent`. */
  saveMission(
    agent: string,
    body: MissionSaveRequest,
  ): Promise<Result<MissionVersion>>;
  /** `POST /tickets` as the operator: a new backlog ticket. */
  createTicket(body: CreateTicketRequest): Promise<Result<TicketView>>;
  /** `POST /exports/run`: one `export.run` command; the supervisor runs the exporter. */
  exportsRun(key: string): Promise<Result<ExportRunAccepted>>;
  /** `POST /tickets/:ref/transition` as the operator, compare-and-set on `version` (If-Match). */
  transitionTicket(
    ref: string,
    version: number,
    body: TransitionRequest,
  ): Promise<Result<TicketView>>;
  /** `POST /pulses/run-now`: one `pulse.run` command for the agent. */
  pulseRunNow(agentId: string, key: string): Promise<Result<PulseRunAccepted>>;
  /** `GET /tickets/:ref`: the ticket with its gates, findings, hand-offs and economics. */
  ticket(ref: string): Promise<Result<TicketDetail>>;
  /** `GET /runners`: every runner with its certification per executor. */
  runners(): Promise<Result<RunnersView>>;
  /** `POST /runners/:id/conformance`: one `runner.conformance` command. */
  runnerConformance(
    runnerId: string,
    body: RunnerConformanceRequest,
    key: string,
  ): Promise<Result<RunnerConformanceAccepted>>;
  /** `PUT /role-bindings`: one role's binding, replaced whole. */
  putRoleBinding(body: PutRoleBinding): Promise<Result<RoleBindingView>>;
  /** `GET /executors`: every executor with its health and its detail. */
  executors(): Promise<Result<ExecutorsView>>;
  /** `POST /executors/:id/health`: one `executor.health` command. */
  executorHealth(
    id: string,
    key: string,
  ): Promise<Result<ExecutorHealthAccepted>>;
  /** `GET /fleet`: the overview the Fleet screen reads, budgets included. */
  fleet(): Promise<Result<Fleet>>;
  /** `POST /fleet/pause` — the kill switch (§13.3): new spawns and turns wait, in-flight finish. */
  pause(): Promise<Result<FleetPauseState>>;
  /** `POST /fleet/resume`: admission's next recheck admits what the pause queued. */
  resume(): Promise<Result<FleetPauseState>>;
  /** `GET /budgets`: every budget with what its window has spent so far (§13.4). */
  budgets(): Promise<Result<BudgetsView>>;
  /** `PUT /budgets`: replaces one scope-and-period budget whole, keeping its id. Audited. */
  putBudget(body: PutBudget): Promise<Result<BudgetView>>;
}

/** What a failed HTTP call's error carries as `cause`: the status it answered with. */
export const HttpCause = z.object({ status: z.int() });

interface Call {
  readonly method?: "GET" | "POST" | "PUT";
  readonly body?: unknown;
  readonly key?: string;
  readonly ifMatch?: number;
}

export function apiClient(o: {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch?: Fetch;
  readonly clock?: Clock;
}): ApiClient {
  const fetcher: Fetch = o.fetch ?? ((url, init) => fetch(url, init));
  const clock = o.clock ?? systemClock;

  async function call<T>(
    schema: z.ZodType<T>,
    path: string,
    c: Call = {},
  ): Promise<Result<T>> {
    const method = c.method ?? "GET";
    const label = `${method} ${path}`;
    const fail = (e: Omit<FrmError, "message">, message: string): Result<T> =>
      err({ ...e, message: `${label}: ${message}` });
    let response: Response;
    try {
      response = await fetcher(`${o.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${o.token}`,
          ...(c.body === undefined
            ? {}
            : { "content-type": "application/json" }),
          ...(c.key === undefined ? {} : { [IDEMPOTENCY_HEADER]: c.key }),
          ...(c.ifMatch === undefined ? {} : { "if-match": `"${c.ifMatch}"` }),
        },
        body: c.body === undefined ? undefined : JSON.stringify(c.body),
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return fail({ class: "internal", retryable: true, cause }, message);
    }
    const json: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const body = ApiErrorBody.safeParse(json);
      const cause = { status: response.status };
      return body.success
        ? fail({ ...body.data.error, cause }, body.data.error.message)
        : fail(
            { class: "internal", retryable: false, cause },
            `HTTP ${response.status}`,
          );
    }
    const parsed = schema.safeParse(json);
    return parsed.success
      ? ok(parsed.data)
      : fail(
          { class: "validation", retryable: false },
          `unexpected reply: ${z.prettifyError(parsed.error)}`,
        );
  }

  return {
    health: () => call(Health, "/health"),
    spawn: (body, key) =>
      call(CommandAccepted, "/sessions", { method: "POST", body, key }),
    stop: (sessionId, mode, key) =>
      call(CommandAccepted, `/sessions/${sessionId}/stop`, {
        method: "POST",
        body: { mode },
        key,
      }),
    command: (id) => call(CommandView, `/commands/${id}`),
    session: (id) => call(SessionView, `/sessions/${id}`),
    async events(sessionId) {
      let items: EventItem[] = [];
      let since = 0;
      for (let pageNo = 1; pageNo <= EVENTS_MAX_PAGES; pageNo++) {
        const label = `GET /sessions/${sessionId}/events (page ${pageNo})`;
        const withinDeadline = await within(
          { clock, timeoutMs: EVENTS_PAGE_TIMEOUT_MS, what: label },
          call(
            EventsPage,
            `/sessions/${sessionId}/events?since=${since}&limit=${EVENTS_PAGE_MAX_LIMIT}`,
          ),
        );
        if (!withinDeadline.ok) return withinDeadline; // the per-page deadline passed
        const page = withinDeadline.value;
        if (!page.ok) return page; // the call itself failed
        items = [...items, ...page.value.items];
        if (!page.value.has_more) return ok(items);
        since = page.value.next_cursor;
      }
      return err({
        class: "internal",
        message:
          `GET /sessions/${sessionId}/events: still has_more after ${EVENTS_MAX_PAGES} pages; ` +
          "the API may be stuck paginating",
        retryable: false,
      });
    },
    saveMission: (agent, body) =>
      call(MissionVersion, `/missions/${encodeURIComponent(agent)}`, {
        method: "POST",
        body,
      }),
    createTicket: (body) =>
      call(TicketView, "/tickets", { method: "POST", body }),
    exportsRun: (key) =>
      call(ExportRunAccepted, "/exports/run", { method: "POST", key }),
    transitionTicket: (ref, version, body) =>
      call(TicketView, `/tickets/${encodeURIComponent(ref)}/transition`, {
        method: "POST",
        body,
        ifMatch: version,
      }),
    pulseRunNow: (agentId, key) =>
      call(PulseRunAccepted, "/pulses/run-now", {
        method: "POST",
        body: { agent_id: agentId },
        key,
      }),
    ticket: (ref) => call(TicketDetail, `/tickets/${encodeURIComponent(ref)}`),
    runners: () => call(RunnersView, "/runners"),
    runnerConformance: (runnerId, body, key) =>
      call(
        RunnerConformanceAccepted,
        `/runners/${encodeURIComponent(runnerId)}/conformance`,
        { method: "POST", body, key },
      ),
    putRoleBinding: (body) =>
      call(RoleBindingView, "/role-bindings", { method: "PUT", body }),
    executors: () => call(ExecutorsView, "/executors"),
    fleet: () => call(Fleet, "/fleet"),
    pause: () => call(FleetPauseState, "/fleet/pause", { method: "POST" }),
    resume: () => call(FleetPauseState, "/fleet/resume", { method: "POST" }),
    budgets: () => call(BudgetsView, "/budgets"),
    putBudget: (body) => call(BudgetView, "/budgets", { method: "PUT", body }),
    executorHealth: (id, key) =>
      call(
        ExecutorHealthAccepted,
        `/executors/${encodeURIComponent(id)}/health`,
        { method: "POST", key },
      ),
  };
}
