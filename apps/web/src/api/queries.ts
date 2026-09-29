import type { StaffRole } from "@bayon/core";
import {
  BudgetSettings,
  CommandAccepted,
  Fleet,
  MissionDiff,
  MissionVersion,
  MissionView,
  SessionView,
  StaffAccepted,
  StopMode,
  TICKETS_PAGE_MAX_LIMIT,
  TicketDetail,
  TicketView,
  TicketsPage,
  WorkspacesView,
  type AttachWhen,
  type CreateTicketRequest,
  type MissionSaveRequest,
  type PatchTicketRequest,
  type TicketSummary,
  type TransitionRequest,
} from "@bayon/proto";
import { queryOptions } from "@tanstack/react-query";
import {
  deleteJson,
  getJson,
  getText,
  patchJson,
  postJson,
  putJson,
} from "@/api/http";

const segment = encodeURIComponent;

/** `GET /fleet`. The `fleet` topic replaces it from then on, so it never goes stale by itself. */
export const fleetQuery = queryOptions({
  queryKey: ["fleet"],
  queryFn: ({ signal }) => getJson("/fleet", Fleet, signal),
  staleTime: Infinity,
});

/** `GET /sessions/:id`, uncached — a fresh read for a caller that can't rely on a poll's cadence
 * (e.g. the Terminal tab deciding whether a just-closed socket is worth reconnecting). */
export const fetchSession = (id: string): Promise<SessionView> =>
  getJson(`/sessions/${segment(id)}`, SessionView);

/** `GET /sessions/:id`. */
export const sessionQuery = (id: string) =>
  queryOptions({
    queryKey: ["session", id],
    queryFn: ({ signal }) =>
      getJson(`/sessions/${segment(id)}`, SessionView, signal),
  });

/**
 * `POST /sessions/:id/stop`. Graceful preserves resumability where the runner supports it.
 *
 * an earlier change wired an idempotency key through `staffTicket` only, where a retried spawn is the
 * expensive mistake. This call and the two attach ones below accept a key but no caller supplies
 * one yet, so a network-level retry of an ambiguous failure can still deliver the command twice.
 */
export const stopSession = (
  sessionId: string,
  mode: StopMode,
  idempotencyKey?: string,
): Promise<CommandAccepted> =>
  postJson(`/sessions/${segment(sessionId)}/stop`, { mode }, CommandAccepted, {
    idempotencyKey,
  });

/**
 * `POST /sessions/:id/attach` (§12.5): takes the attach lease, moves the session to
 * `human_attached`. A 202 `CommandAccepted` — the lease/tmux fields land on the session row itself,
 * read back via `sessionQuery`, not in this response (REST convention for every session
 * command). `clientToken` becomes `attach_lease_owner` verbatim, so the caller can later recognize
 * its own lease on a poll by simple equality rather than guessing which non-null value is its own.
 * `when`: `turn_end` waits for the open run to end — `attach_intent_at` shows it pending
 * meanwhile — and `now` stops the agent mid-turn.
 */
export const attachSession = (
  sessionId: string,
  clientToken: string,
  when: AttachWhen,
  idempotencyKey?: string,
): Promise<CommandAccepted> =>
  postJson(
    `/sessions/${segment(sessionId)}/attach`,
    { client_token: clientToken, when },
    CommandAccepted,
    { idempotencyKey },
  );

/**
 * `DELETE /sessions/:id/attach`: releases the lease, returns the session to `idle`; before the
 * attach has happened, cancels a pending "take over after this step".
 */
export const detachSession = (
  sessionId: string,
  idempotencyKey?: string,
): Promise<CommandAccepted> =>
  deleteJson(`/sessions/${segment(sessionId)}/attach`, CommandAccepted, {
    idempotencyKey,
  });

/**
 * The full text behind a truncated event (§8.5: the row keeps a capped projection, the rest is at
 * `payload_path`), from `GET /sessions/:id/events/:eventId/payload`.
 */
export const payloadQuery = (sessionId: string, eventId: number) =>
  queryOptions({
    queryKey: ["payload", sessionId, eventId],
    queryFn: ({ signal }) =>
      getText(
        `/sessions/${segment(sessionId)}/events/${eventId}/payload`,
        signal,
      ),
    staleTime: Infinity,
  });

/** `PUT /settings/budget` (§12.1): sets the operator's daily cap, or null to clear it. */
export const putBudgetCap = (
  dailyCapUsd: number | null,
): Promise<BudgetSettings> =>
  putJson("/settings/budget", { daily_cap_usd: dailyCapUsd }, BudgetSettings);

/** `GET /missions/:agent`: the newest version (null before the first save) and the changelog. */
export const missionQuery = (agent: string) =>
  queryOptions({
    queryKey: ["mission", agent],
    queryFn: ({ signal }) =>
      getJson(`/missions/${segment(agent)}`, MissionView, signal),
  });

/** `GET /missions/:agent/diff/:a/:b`. Versions are immutable, so a diff never goes stale. */
export const missionDiffQuery = (agent: string, from: number, to: number) =>
  queryOptions({
    queryKey: ["mission-diff", agent, from, to],
    queryFn: ({ signal }) =>
      getJson(
        `/missions/${segment(agent)}/diff/${from}/${to}`,
        MissionDiff,
        signal,
      ),
    staleTime: Infinity,
  });

/** `POST /missions/:agent`: version `base_version + 1`, or 409 (`current_version`) on a stale base. */
export const saveMission = (
  agent: string,
  request: MissionSaveRequest,
): Promise<MissionVersion> =>
  postJson(`/missions/${segment(agent)}`, request, MissionVersion);

/** Board lists and ticket details: the `tickets` topic invalidates by these prefixes. */
export const TICKETS_KEY = ["tickets"] as const;
export const TICKET_KEY = ["ticket"] as const;

/** The board's filters; all are the server's (`GET /tickets?q=&needs_human=&workspace_id=`). */
export interface TicketFilter {
  readonly q: string;
  readonly needsHuman: boolean;
  /** One project's tickets; null is every project's. */
  readonly workspaceId: string | null;
}

/** Enough pages for any M1 board; past them the board says it shows only the first. */
const MAX_BOARD_PAGES = 20;

const ticketsPath = (filter: TicketFilter, cursor: number | undefined) => {
  const params = new URLSearchParams();
  if (filter.q !== "") params.set("q", filter.q);
  if (filter.needsHuman) params.set("needs_human", "1");
  if (filter.workspaceId !== null)
    params.set("workspace_id", filter.workspaceId);
  if (cursor !== undefined) params.set("cursor", String(cursor));
  params.set("limit", String(TICKETS_PAGE_MAX_LIMIT));
  return `/tickets?${params.toString()}`;
};

/** `GET /tickets`, page after page: the board groups by status itself. */
export const ticketsQuery = (filter: TicketFilter) =>
  queryOptions({
    queryKey: [...TICKETS_KEY, filter.q, filter.needsHuman, filter.workspaceId],
    queryFn: async ({ signal }) => {
      let items: readonly TicketSummary[] = [];
      let cursor: number | undefined;
      for (let page = 0; page < MAX_BOARD_PAGES; page++) {
        const next = await getJson(
          ticketsPath(filter, cursor),
          TicketsPage,
          signal,
        );
        items = [...items, ...next.items];
        if (!next.has_more) return { items, complete: true };
        cursor = next.next_cursor;
      }
      return { items, complete: false };
    },
  });

/** `GET /tickets/:num`: the ticket, its extras, and the moves the laws allow the operator. */
export const ticketQuery = (num: number) =>
  queryOptions({
    queryKey: [...TICKET_KEY, num],
    queryFn: ({ signal }) => getJson(`/tickets/${num}`, TicketDetail, signal),
  });

/** `POST /tickets/:num/transition` against `version`: 409 when stale, 422 when a law refuses. */
export const transitionTicket = (
  num: number,
  version: number,
  request: TransitionRequest,
): Promise<TicketView> =>
  postJson(`/tickets/${num}/transition`, request, TicketView, { version });

/** `PATCH /tickets/:num` against `version`. */
export const patchTicket = (
  num: number,
  version: number,
  patch: PatchTicketRequest,
): Promise<TicketView> =>
  patchJson(`/tickets/${num}`, patch, TicketView, { version });

/** `GET /workspaces`: every row, for the project pickers and the board's card badges. */
export const workspacesQuery = queryOptions({
  queryKey: ["workspaces"],
  queryFn: ({ signal }) => getJson("/workspaces", WorkspacesView, signal),
});

/** `POST /tickets`: the new backlog ticket. No `version`: creation carries no If-Match. */
export const createTicket = (
  request: CreateTicketRequest,
): Promise<TicketView> => postJson("/tickets", request, TicketView);

/**
 * `POST /tickets/:num/staff`: queues a session.spawn for `role`. Not CAS'd, so no `version` — an
 * `idempotencyKey` is what keeps a retry from spawning a second session.
 */
export const staffTicket = (
  num: number,
  role: StaffRole,
  idempotencyKey?: string,
): Promise<StaffAccepted> =>
  postJson(`/tickets/${num}/staff`, { role }, StaffAccepted, {
    idempotencyKey,
  });
