import { err, ok, type GateState, type Result } from "@bayon/core";
import {
  getTicket,
  getTicketByNum,
  listGateSessions,
  listGates,
  type Db,
  type GateCursor,
} from "@bayon/db";
import type { GatesPage } from "@bayon/proto";
import { loadTicketSettings } from "../tickets/ticket-settings.js";
import { toGateSummaries } from "../tickets/ticket-views.js";

// GET /gates and the `gates` WS topic: gates with their tickets, newest first,
// keyset-paged by an opaque `<started_at>.<id>` cursor.

export const encodeGateCursor = (c: GateCursor): string =>
  `${c.started_at}.${c.id}`;

const CURSOR = /^(\d{1,16})\.(.+)$/;

export function decodeGateCursor(text: string): GateCursor | null {
  const m = CURSOR.exec(text);
  const id = m?.[2];
  return m === null || id === undefined
    ? null
    : { started_at: Number(m[1]), id };
}

export interface GatesPageQuery {
  readonly states?: readonly GateState[];
  /** A ticket's ULID or number. */
  readonly ticket?: string;
  /** One project's gates, by their ticket's project. */
  readonly project?: string;
  readonly latest: boolean;
  readonly limit: number;
  readonly cursor?: string;
}

async function ticketIdOf(
  db: Db,
  ref: string | undefined,
): Promise<Result<string | undefined>> {
  if (ref === undefined) return ok(undefined);
  const found = /^\d+$/.test(ref)
    ? await getTicketByNum(db, Number(ref))
    : await getTicket(db, ref);
  return found.ok ? ok(found.value.id) : found;
}

export async function gatesPage(
  db: Db,
  q: GatesPageQuery,
): Promise<Result<GatesPage>> {
  const after = q.cursor === undefined ? undefined : decodeGateCursor(q.cursor);
  if (after === null) {
    return err({
      class: "validation",
      message: "cursor is not one a page returned",
      retryable: false,
    });
  }
  const settings = await loadTicketSettings(db);
  if (!settings.ok) return settings;
  const ticketId = await ticketIdOf(db, q.ticket);
  if (!ticketId.ok) return ticketId;
  const page = await listGates(db, {
    latest: q.latest,
    limit: q.limit,
    ...(q.states === undefined ? {} : { states: q.states }),
    ...(ticketId.value === undefined ? {} : { ticket_id: ticketId.value }),
    ...(q.project === undefined ? {} : { workspace_id: q.project }),
    ...(after === undefined ? {} : { after }),
  });
  if (!page.ok) return page;
  const sessions = await listGateSessions(
    db,
    page.value.rows.map((r) => r.id),
  );
  if (!sessions.ok) return sessions;
  const items = toGateSummaries(
    page.value.rows,
    settings.value["tickets.key_prefix"],
    sessions.value,
  );
  if (!items.ok) return items;
  return ok({
    items: items.value,
    next_cursor:
      page.value.nextCursor === null
        ? null
        : encodeGateCursor(page.value.nextCursor),
    has_more: page.value.hasMore,
  });
}
