import { InboxItem, InboxPage, type InboxStatus } from "@bayon/proto";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { ApiRequestError, getJson, postJson } from "@/api/http";

/**
 * How long a fetched page stands without being asked for again. The `inbox` topic pushes a snapshot
 * at most once a second and invalidates on every change, so anything inside this window is already
 * on its way.
 */
export const INBOX_STALE_MS = 5_000;

/** Every inbox list: the `inbox` topic and an answer refresh them by this prefix. */
export const INBOX_KEY = ["inbox"] as const;

const inboxPath = (
  status: InboxStatus,
  cursor: string | null,
  project?: string,
  ticket?: number,
): string => {
  const params = new URLSearchParams({ status });
  if (project !== undefined) params.set("project", project);
  if (ticket !== undefined) params.set("ticket", String(ticket));
  if (cursor !== null) params.set("cursor", cursor);
  return `/inbox?${params.toString()}`;
};

/** Both of one project's lists: an `inbox` frame refetches them by this prefix. */
export const projectInboxKey = (project: string): readonly string[] => [
  ...INBOX_KEY,
  "project",
  project,
];

/** Every ticket-filtered list: an `inbox` frame refetches them by this prefix. */
export const TICKET_INBOX_KEY = [...INBOX_KEY, "ticket"] as const;

/**
 * `GET /inbox?status=`, page after page on its keyset cursor (the server's page size). With
 * `project`, one project's requests (its ticket's, else its session's, else that session's agent's:
 *), under a key the fleet's snapshot is never written into. With `ticket`, one ticket's
 *, under a key of its own too.
 *
 * What keeps this list fresh is the `inbox` topic, which invalidates it the moment a request opens
 * or closes — not staleness. So a reader that joins a page already fetched seconds ago reuses it
 * (the header's count and the screen read one query, and that is one request, not two).
 */
export const inboxQuery = (
  status: InboxStatus,
  project?: string,
  ticket?: number,
) =>
  infiniteQueryOptions({
    queryKey: [
      ...(project === undefined ? INBOX_KEY : projectInboxKey(project)),
      ...(ticket === undefined ? [] : ["ticket", ticket]),
      status,
    ],
    queryFn: ({ pageParam, signal }) =>
      getJson(inboxPath(status, pageParam, project, ticket), InboxPage, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.has_more ? last.next_cursor : null),
    staleTime: INBOX_STALE_MS,
  });

/**
 * A ticket's open questions, the first page: what its ticket view lists, each with the
 * Inbox's Answer button. Under INBOX_KEY, so an answer's refresh refetches it.
 */
export const ticketQuestionsQuery = (ticket: number) =>
  queryOptions({
    queryKey: [...INBOX_KEY, "questions", ticket],
    queryFn: ({ signal }) =>
      getJson(inboxPath("open", null, undefined, ticket), InboxPage, signal),
  });

/** `POST /inbox/:id/answer`. An answer is final: a second one is 409. */
export const answerInboxItem = (
  id: string,
  answer: string,
): Promise<InboxItem> =>
  postJson(`/inbox/${encodeURIComponent(id)}/answer`, { answer }, InboxItem);

/**
 * `POST /inbox/:id/dismiss`: the operator withdraws an open question as no longer
 * relevant. Final: a closed one is 409.
 */
export const dismissInboxItem = (id: string): Promise<InboxItem> =>
  postJson(`/inbox/${encodeURIComponent(id)}/dismiss`, {}, InboxItem);

/**
 * A 409 that ends the request: someone answered first, or (a staffing approval) the ticket moved on
 * and the answer can never land. A retryable 409 is the server saying "not now" instead — approving
 * a proposal whose agent is busy — and the request stays open.
 */
export const isFinalConflict = (error: Error): boolean =>
  error instanceof ApiRequestError &&
  error.status === 409 &&
  error.error.retryable !== true;

/** A 409 in the server's own words (why not now, or why never); any other error as it reads. */
export const conflictMessage = (error: Error): string =>
  error instanceof ApiRequestError && error.status === 409
    ? error.error.message
    : error.message;
