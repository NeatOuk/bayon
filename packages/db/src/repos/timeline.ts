// GET /projects/:id/timeline: a project's history, one UNION ALL over the tables that
// hold it (timeline-sources.ts), newest first, keyset-paged on (ts, source, key). Reads only: every
// source keeps its own writer (§9.5); nothing is materialized.
import {
  TimelineKindFilter,
  TimelineSource,
  err,
  ok,
  ticketKey,
  ticketRefOf,
  type Result,
} from "@bayon/core";
import { sql, type AliasedSelectQueryBuilder, type SqlBool } from "kysely";
import { z } from "zod";
import {
  all,
  first,
  qb,
  readSnapshot,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import {
  TIMELINE_PARTS,
  type SourceScope,
  type TimelineRaw,
} from "./timeline-sources.js";
import { keyPrefix } from "./ticket-key.js";

/** Where a page resumes: strictly after this row, in (ts, source, key) descending order. */
const TimelineAfterShape = z.object({
  ts: z.int().nonnegative(),
  source: TimelineSource,
  key: z.string().min(1).max(128),
});
export type TimelineAfter = z.infer<typeof TimelineAfterShape>;

const TimelineQueryShape = z.object({
  workspaceId: z.string().min(1),
  after: TimelineAfterShape.optional(),
  limit: z.int().min(1).max(1000),
  kinds: z.array(TimelineKindFilter).min(1).max(50).optional(),
  /** An agent's id. */
  agentId: z.string().min(1).optional(),
  /** A ticket's key, `#n`, `n` or id (core ticketRefOf). */
  ticket: z.string().min(1).optional(),
  /** ts >= from. */
  from: z.int().nonnegative().optional(),
  /** ts < to. */
  to: z.int().nonnegative().optional(),
  /** A case-insensitive text match on summary and actor; `%` and `_` match themselves. */
  q: z.string().min(1).max(200).optional(),
});
export type TimelineQuery = z.input<typeof TimelineQueryShape>;
type Parsed = z.output<typeof TimelineQueryShape>;

/** One timeline row: the normalized columns, with its ticket's key. */
export interface TimelineRow extends Omit<
  TimelineRaw,
  "ticket_num" | "source"
> {
  readonly source: TimelineSource;
  readonly ticket_key: string | null;
}

export interface TimelinePage {
  readonly workspace: { readonly id: string; readonly name: string };
  readonly rows: TimelineRow[];
  readonly hasMore: boolean;
}

/** Where the page after `row` starts. */
export const timelineAfter = (row: TimelineRow): TimelineAfter => ({
  ts: row.ts,
  source: row.source,
  key: row.key,
});

/** `%`, `_` and the escape itself match only themselves. */
const LIKE_ESCAPE = "!";
const likePattern = (text: string): string =>
  `%${text.replace(/[!%_]/g, (c) => `${LIKE_ESCAPE}${c}`)}%`;

interface Filters {
  readonly after?: TimelineAfter;
  readonly limit: number;
  readonly kinds?: readonly string[];
  readonly agentId?: string;
  readonly ticketId?: string;
  readonly from?: number;
  readonly to?: number;
  readonly q?: string;
}

/** A source's part as the UNION takes it: aliased, whatever tables it joins. */
interface Part {
  as<A extends string>(alias: A): AliasedSelectQueryBuilder<TimelineRaw, A>;
}

/**
 * One part, filtered on its normalized columns (SQLite flattens these into the base scan) and cut to
 * `limit + 1` rows. The cursor is specialized per source, whose name is a constant here: a source
 * that sorts below the cursor's keeps the cursor's millisecond, one above it does not, and the
 * cursor's own source compares keys within it.
 */
function member(source: TimelineSource, part: Part, f: Filters) {
  const after = f.after;
  const kinds = f.kinds;
  const pattern = f.q === undefined ? undefined : likePattern(f.q);
  const filtered = qb
    .selectFrom(part.as("p"))
    .selectAll()
    .$if(after !== undefined, (b) =>
      b.where((eb) => {
        const c = after ?? { ts: 0, source, key: "" };
        if (source < c.source) return eb("p.ts", "<=", c.ts);
        if (source > c.source) return eb("p.ts", "<", c.ts);
        return eb.or([
          eb("p.ts", "<", c.ts),
          eb.and([eb("p.ts", "=", c.ts), eb("p.key", "<", c.key)]),
        ]);
      }),
    )
    .$if(kinds !== undefined, (b) =>
      b.where((eb) =>
        eb.or(
          (kinds ?? []).map((k) =>
            k.endsWith("*")
              ? eb(
                  eb.fn<number>("instr", [
                    eb.ref("p.kind"),
                    eb.val(k.slice(0, -1)),
                  ]),
                  "=",
                  1,
                )
              : eb("p.kind", "=", k),
          ),
        ),
      ),
    )
    .$if(f.agentId !== undefined, (b) =>
      b.where("p.agent_id", "=", f.agentId ?? ""),
    )
    .$if(f.ticketId !== undefined, (b) =>
      b.where("p.ticket_id", "=", f.ticketId ?? ""),
    )
    .$if(f.from !== undefined, (b) => b.where("p.ts", ">=", f.from ?? 0))
    .$if(f.to !== undefined, (b) => b.where("p.ts", "<", f.to ?? 0))
    .$if(pattern !== undefined, (b) =>
      b.where(
        sql<SqlBool>`(p.summary LIKE ${pattern} ESCAPE ${LIKE_ESCAPE} OR p.actor LIKE ${pattern} ESCAPE ${LIKE_ESCAPE})`,
      ),
    )
    .orderBy("p.ts", "desc")
    .orderBy("p.key", "desc")
    .limit(f.limit + 1);
  // A compound member cannot carry its own ORDER BY/LIMIT: each is wrapped once more.
  return qb.selectFrom(filtered.as("m")).selectAll();
}

/** The whole page: every part, unioned, ordered by (ts, source, key) descending, `limit + 1` rows. */
function pageQuery(scope: SourceScope, f: Filters) {
  const [head, ...rest] = TIMELINE_PARTS;
  const union = rest.reduce(
    (acc, { source, build }) => acc.unionAll(member(source, build(scope), f)),
    member(head.source, head.build(scope), f),
  );
  return qb
    .selectFrom(union.as("u"))
    .selectAll()
    .orderBy("u.ts", "desc")
    .orderBy("u.source", "desc")
    .orderBy("u.key", "desc")
    .limit(f.limit + 1);
}

const invalid = (message: string): Result<never> =>
  err(failure("validation", message));

/** The ticket a filter names (key, #n, n or id), or a validation error naming the ref. */
function ticketFilter(
  ix: Internals,
  ref: string,
  prefix: string,
): Result<string> {
  const target = ticketRefOf(ref, prefix);
  const row = first(
    ix,
    "num" in target
      ? qb.selectFrom("tickets").select("id").where("num", "=", target.num)
      : qb.selectFrom("tickets").select("id").where("id", "=", target.id),
  );
  return row === undefined ? invalid(`no ticket ${ref}`) : ok(row.id);
}

/** Validates the query, then reads one page in one short snapshot. */
function readPage(q: Parsed) {
  return (ix: Internals): Result<TimelinePage> => {
    const workspace = first(
      ix,
      qb
        .selectFrom("workspaces")
        .select(["id", "name"])
        .where("id", "=", q.workspaceId),
    );
    if (workspace === undefined) {
      return err(
        failure("not_found", `project ${q.workspaceId} does not exist`),
      );
    }
    const prefix = keyPrefix(ix);
    let ticketId: string | undefined;
    if (q.ticket !== undefined) {
      const found = ticketFilter(ix, q.ticket, prefix);
      if (!found.ok) return found;
      ticketId = found.value;
    }
    if (q.agentId !== undefined) {
      const agent = first(
        ix,
        qb.selectFrom("agents").select("id").where("id", "=", q.agentId),
      );
      if (agent === undefined) return invalid(`no agent ${q.agentId}`);
    }
    const raw = all(
      ix,
      pageQuery(
        { workspaceId: q.workspaceId, keyPrefix: prefix },
        { ...q, ...(ticketId === undefined ? {} : { ticketId }) },
      ),
    );
    const rows = raw
      .slice(0, q.limit)
      .map(({ ticket_num, source, ...rest }): TimelineRow => ({
        ...rest,
        source: TimelineSource.parse(source),
        ticket_key: ticket_num === null ? null : ticketKey(prefix, ticket_num),
      }));
    return ok({ workspace, rows, hasMore: raw.length > q.limit });
  };
}

/**
 * One page of a project's timeline, newest first. An unknown project is `not_found`; an unknown
 * ticket or agent filter, or a malformed query, is `validation`. Each call is its own short read
 * snapshot, so an export walking many pages never holds one long read (the WAL checkpoint waits on
 * the oldest reader).
 */
export async function listTimeline(
  db: Db,
  query: TimelineQuery,
): R<TimelinePage> {
  const parsed = TimelineQueryShape.safeParse(query);
  if (!parsed.success) {
    return invalid(`bad timeline query: ${z.prettifyError(parsed.error)}`);
  }
  const q = parsed.data;
  if (q.from !== undefined && q.to !== undefined && q.from >= q.to) {
    return invalid("from must be before to");
  }
  const page = await readSnapshot(db, readPage(q));
  return page.ok ? page.value : page;
}
