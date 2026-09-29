import { err, ok } from "@bayon/core";
import { sql } from "kysely";
import { z } from "zod";
import { all, first, qb, read, type Db, type R } from "../connection.js";
import { failure, orNotFound } from "../errors.js";
import { ftsQuery } from "../fts.js";
import type { TicketRow } from "../schema.js";
import { openQuestionOn } from "./open-questions.js";

// Ticket reads (@bayon/db). The writers are the API's: ticket-writes.ts, ticket-transition.ts.

export async function getTicket(db: Db, id: string): R<TicketRow> {
  const found = await read(db, (ix) =>
    first(ix, qb.selectFrom("tickets").selectAll().where("id", "=", id)),
  );
  return orNotFound(found, `ticket ${id}`);
}

export async function getTicketByNum(db: Db, num: number): R<TicketRow> {
  const found = await read(db, (ix) =>
    first(ix, qb.selectFrom("tickets").selectAll().where("num", "=", num)),
  );
  return orNotFound(found, `ticket #${num}`);
}

/** The ticket filed for a probe finding's fingerprint (§10.2, tickets_origin_fp_idx), or null. */
export function findTicketByFingerprint(
  db: Db,
  fingerprint: string,
): R<TicketRow | null> {
  return read(
    db,
    (ix) =>
      first(
        ix,
        qb
          .selectFrom("tickets")
          .selectAll()
          .where("origin_fingerprint", "=", fingerprint),
      ) ?? null,
  );
}

const TicketQueryShape = z.object({
  /** Any of these statuses. */
  status: z.array(z.string().min(1)).min(1).optional(),
  needs_human: z.boolean().optional(),
  complexity_tier: z.string().min(1).optional(),
  workspace_id: z.string().min(1).optional(),
  /** Words that must all appear in the title or body (tickets_fts). */
  q: z.string().trim().min(1).optional(),
  /** Exclusive cursor: the last num of the previous page. */
  after_num: z.int().nonnegative().optional(),
  limit: z.int().min(1).max(1000),
});
export type TicketQuery = z.input<typeof TicketQueryShape>;

export interface TicketPage {
  readonly rows: TicketRow[];
  readonly nextCursor: number;
  readonly hasMore: boolean;
}

/** A page of tickets in num order after `after_num`, filtered; `q` searches through tickets_fts. */
export async function listTickets(db: Db, query: TicketQuery): R<TicketPage> {
  const parsed = TicketQueryShape.safeParse(query);
  if (!parsed.success) {
    return err(
      failure(
        "validation",
        `bad ticket query: ${z.prettifyError(parsed.error)}`,
      ),
    );
  }
  const { status, needs_human, complexity_tier, workspace_id, q, limit } =
    parsed.data;
  const after = parsed.data.after_num ?? 0;
  const match = q === undefined ? undefined : ftsQuery(q);
  if (match === null)
    return ok({ rows: [], nextCursor: after, hasMore: false });
  return read(db, (ix) => {
    const rows = all(
      ix,
      qb
        .selectFrom("tickets")
        .selectAll()
        .where("num", ">", after)
        .$if(status !== undefined, (b) => b.where("status", "in", status ?? []))
        // "Needs human" is the flag or a live open question: the supervisor's own
        // requests (split, circuit breaker, retry storm) never write the flag, and still wait.
        .$if(needs_human !== undefined, (b) =>
          b.where((eb) => {
            const waiting = eb.or([
              eb("needs_human", "=", 1),
              eb.exists(openQuestionOn("tickets.id")),
            ]);
            return needs_human === true ? waiting : eb.not(waiting);
          }),
        )
        .$if(complexity_tier !== undefined, (b) =>
          b.where("complexity_tier", "=", complexity_tier ?? ""),
        )
        // tickets_workspace_status_idx (028) serves this filter.
        .$if(workspace_id !== undefined, (b) =>
          b.where("workspace_id", "=", workspace_id ?? ""),
        )
        .$if(match !== undefined, (b) =>
          b.where(
            "num",
            "in",
            qb
              .selectFrom("tickets_fts")
              .select(sql<number>`rowid`.as("num"))
              .where(sql.ref("tickets_fts"), "match", match ?? ""),
          ),
        )
        .orderBy("num")
        .limit(limit + 1),
    );
    const page = rows.slice(0, limit);
    return {
      rows: page,
      nextCursor: page.at(-1)?.num ?? after,
      hasMore: rows.length > limit,
    };
  });
}
