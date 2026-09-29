import {
  STARTED_TRIGGER,
  statusMapOf,
  type JiraPushEvent,
  type JiraPushLink,
  type JiraPushRows,
  type JiraPushTicket,
} from "@bayon/core";
import { sql, type SqlBool } from "kysely";
import {
  all,
  first,
  qb,
  readSnapshot,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { JIRA_ORIGIN } from "./jira-mirror.js";

// What the Jira pusher reads each tick: the ticket_events and pull-request links past its
// watermarks, and the mirrored tickets they name, in one snapshot. Reads only: ticket_events and
// ticket_links are other writers' tables, deliveries the supervisor's; the pusher writes its own
// outbox (jira-pushes.ts). A pull request is tailed through `ticket_links` (append-only, one row per
// new PR, written with the delivery that opened it) because a `deliveries` row is updated in place;
// its url must be a `deliveries.pr_url` of the ticket, so a `pr` link an agent added is never sent.

export const JIRA_PUSH_SOURCES = ["ticket_events", "ticket_links"] as const;
export type JiraPushSource = (typeof JIRA_PUSH_SOURCES)[number];
export type JiraPushCursors = Readonly<Partial<Record<JiraPushSource, number>>>;

/** The most rows one tick reads from a source; the watermark then stops at the last one read. */
export const JIRA_PUSH_SOURCE_LIMIT = 500;

const PR_LINK = "pr";
const MOVES = [...STARTED_TRIGGER, "done"];

export interface JiraPushSourceRows extends JiraPushRows {
  /** Each source's watermark as stored; a missing one is a first boot for that source. */
  readonly cursors: JiraPushCursors;
  /** Where each source's watermark moves to once these rows are filed. */
  readonly advance: Readonly<Record<JiraPushSource, number>>;
}

interface Window {
  readonly after: number;
  readonly head: number;
}

const moved = (w: Window, seqs: readonly number[]): number =>
  seqs.length >= JIRA_PUSH_SOURCE_LIMIT ? (seqs.at(-1) ?? w.head) : w.head;

function heads(ix: Internals): Record<JiraPushSource, number> {
  const max = (table: JiraPushSource) =>
    first(
      ix,
      qb.selectFrom(table).select(sql<number | null>`max(rowid)`.as("head")),
    )?.head ?? 0;
  return {
    ticket_events: max("ticket_events"),
    ticket_links: max("ticket_links"),
  };
}

function storedCursors(ix: Internals): JiraPushCursors {
  const known: readonly string[] = JIRA_PUSH_SOURCES;
  return Object.fromEntries(
    all(ix, qb.selectFrom("jira_push_cursors").select(["source", "last_seen"]))
      .filter((r) => known.includes(r.source))
      .map((r) => [r.source, r.last_seen]),
  );
}

function eventsIn(ix: Internals, w: Window) {
  const rows: JiraPushEvent[] = all(
    ix,
    qb
      .selectFrom("ticket_events")
      .select([
        "id",
        "ticket_id",
        "actor_id",
        "from_status",
        "to_status",
        "payload_json",
      ])
      .where("id", ">", w.after)
      .where("id", "<=", w.head)
      .where("to_status", "in", MOVES)
      .orderBy("id")
      .limit(JIRA_PUSH_SOURCE_LIMIT),
  );
  return {
    rows,
    advance: moved(
      w,
      rows.map((r) => r.id),
    ),
  };
}

function linksIn(ix: Internals, w: Window) {
  const seq = sql<number>`l.rowid`;
  const rows = all(
    ix,
    qb
      .selectFrom("ticket_links as l")
      .select([seq.as("seq"), "l.ticket_id", "l.url"])
      .where(sql<SqlBool>`${seq} > ${w.after} AND ${seq} <= ${w.head}`)
      .where("l.kind", "=", PR_LINK)
      .where("l.url", "is not", null)
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom("deliveries as d")
            .select("d.id")
            .whereRef("d.ticket_id", "=", "l.ticket_id")
            .whereRef("d.pr_url", "=", "l.url"),
        ),
      )
      .orderBy(seq)
      .limit(JIRA_PUSH_SOURCE_LIMIT),
  );
  const links: JiraPushLink[] = rows.flatMap((r) =>
    r.url === null ? [] : [{ seq: r.seq, ticket_id: r.ticket_id, url: r.url }],
  );
  return {
    rows: links,
    advance: moved(
      w,
      rows.map((r) => r.seq),
    ),
  };
}

/** The mirrored tickets `ids` names, in projects with a Jira source that push something. */
function ticketsOf(
  ix: Internals,
  ids: readonly string[],
): ReadonlyMap<string, JiraPushTicket> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return new Map();
  const rows = all(
    ix,
    qb
      .selectFrom("tickets as t")
      .innerJoin("workspaces as w", "w.id", "t.workspace_id")
      .select([
        "t.id",
        "t.status",
        "t.workspace_id",
        "t.origin_ref",
        "t.origin_fingerprint",
        "w.jira_url",
        "w.jira_status_map_json",
        "w.jira_comment_prs",
      ])
      .where("t.id", "in", wanted)
      .where("t.origin", "=", JIRA_ORIGIN)
      .where("w.jira_url", "is not", null)
      .where((eb) =>
        eb.or([
          eb("w.jira_status_map_json", "is not", null),
          eb("w.jira_comment_prs", "=", 1),
        ]),
      ),
  );
  return new Map(
    rows.flatMap((r): [string, JiraPushTicket][] =>
      r.jira_url === null || r.workspace_id === null
        ? []
        : [
            [
              r.id,
              {
                id: r.id,
                status: r.status,
                workspace_id: r.workspace_id,
                origin_ref: r.origin_ref,
                origin_fingerprint: r.origin_fingerprint,
                jira_url: r.jira_url,
                status_map: statusMapOf(r.jira_status_map_json),
                comment_prs: r.jira_comment_prs === 1,
              },
            ],
          ],
    ),
  );
}

/**
 * One tick's reads, in one snapshot. A source with no watermark (first boot) reads nothing and its
 * watermark starts at its newest row, so history is never back-filled.
 */
export async function jiraPushSources(db: Db): R<JiraPushSourceRows> {
  return readSnapshot(db, (ix) => {
    const head = heads(ix);
    const cursors = storedCursors(ix);
    const window = (s: JiraPushSource): Window | null => {
      const after = cursors[s];
      return after === undefined
        ? null
        : { after, head: Math.max(after, head[s]) };
    };
    const we = window("ticket_events");
    const wl = window("ticket_links");
    const events = we === null ? null : eventsIn(ix, we);
    const links = wl === null ? null : linksIn(ix, wl);
    const tickets = ticketsOf(ix, [
      ...(events?.rows ?? []).map((e) => e.ticket_id),
      ...(links?.rows ?? []).map((l) => l.ticket_id),
    ]);
    return {
      cursors,
      advance: {
        ticket_events: events?.advance ?? head.ticket_events,
        ticket_links: links?.advance ?? head.ticket_links,
      },
      events: events?.rows ?? [],
      links: links?.rows ?? [],
      tickets,
    };
  });
}
