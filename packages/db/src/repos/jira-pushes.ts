import {
  JIRA_PUSH_ERROR_MAX,
  NewJiraPush,
  capText,
  err,
  newId,
  ok,
  type Result,
} from "@bayon/core";
import { sql } from "kysely";
import { z } from "zod";
import {
  all,
  execute,
  first,
  qb,
  read,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import { JIRA_PUSH_SOURCES, type JiraPushSource } from "./jira-push-sources.js";

// The Jira pusher's outbox (§9.5 amendment: API-written), the notifier's shape (034): a
// tick files what it found and moves its watermarks in one transaction, so a crash between the two
// can neither lose a moment nor file it twice; `dedupe_key` is UNIQUE, so a restart that finds the
// same moment again files nothing. Each push is claimed (an attempt counted, its retry time set)
// before it is sent and settled after. Every stored error was scrubbed by the API before it got
// here, and is capped here.
//
// Filing a transition supersedes the ticket's older transitions still pending: they are skipped, so
// a `started` waiting on its backoff can never land in Jira after the ticket's `done`.

const Cursor = z.int().nonnegative();
export const JiraPushFilingInput = z.object({
  items: z.array(NewJiraPush),
  cursors: z.partialRecord(z.enum(JIRA_PUSH_SOURCES), Cursor),
});
export type JiraPushFiling = z.infer<typeof JiraPushFilingInput>;

/** Why a pending transition was skipped when a later one was filed. */
export const SUPERSEDED = "superseded by a later move";

const invalid = (what: string, e: z.ZodError) =>
  err(failure("validation", `${what}: ${z.prettifyError(e)}`));

const capped = (text: string): string => capText(text, JIRA_PUSH_ERROR_MAX);

function supersede(ix: Internals, ticketId: string, keep: string): void {
  execute(
    ix,
    qb
      .updateTable("jira_pushes")
      .set({ state: "skipped", last_error: SUPERSEDED, next_attempt_at: null })
      .where("ticket_id", "=", ticketId)
      .where("kind", "=", "transition")
      .where("state", "=", "pending")
      .where("id", "<>", keep),
  );
}

function fileOne(ix: Internals, p: NewJiraPush): string | null {
  const now = ix.clock.now();
  const { payload, ...columns } = p;
  const inserted = first(
    ix,
    qb
      .insertInto("jira_pushes")
      .values({
        id: newId(now),
        ...columns,
        payload_json: JSON.stringify(payload),
        next_attempt_at: now,
        created_at: now,
      })
      .onConflict((oc) => oc.column("dedupe_key").doNothing())
      .returning("id"),
  );
  if (inserted === undefined) return null;
  if (p.kind === "transition") supersede(ix, p.ticket_id, inserted.id);
  return inserted.id;
}

function moveCursor(ix: Internals, source: JiraPushSource, lastSeen: number) {
  const now = ix.clock.now();
  execute(
    ix,
    qb
      .insertInto("jira_push_cursors")
      .values({ source, last_seen: lastSeen, updated_at: now })
      .onConflict((oc) =>
        oc
          .column("source")
          .doUpdateSet({ last_seen: lastSeen, updated_at: now }),
      ),
  );
}

/** Files each push whose key is new, in order, and moves the watermarks. Returns the ids filed. */
export async function fileJiraPushes(
  db: Db,
  filing: JiraPushFiling,
): R<readonly string[]> {
  const parsed = JiraPushFilingInput.safeParse(filing);
  if (!parsed.success) return invalid("jira pushes", parsed.error);
  const { items, cursors } = parsed.data;
  return write(db, (ix) => {
    const created = items.flatMap((p) => {
      const id = fileOne(ix, p);
      return id === null ? [] : [id];
    });
    for (const source of JIRA_PUSH_SOURCES) {
      const at = cursors[source];
      if (at !== undefined) moveCursor(ix, source, at);
    }
    return ok(created);
  });
}

const Moment = z.int().nonnegative();
const Id = z.string().min(1);

function pendingOnly(ix: Internals, id: string): Result<void> {
  const row = first(
    ix,
    qb.selectFrom("jira_pushes").select("state").where("id", "=", id),
  );
  if (row === undefined) return err(failure("not_found", `jira push ${id}`));
  return row.state === "pending"
    ? ok(undefined)
    : err(failure("conflict", `jira push ${id} is ${row.state}, not pending`));
}

const Claim = z.object({ id: Id, retry_at: Moment });

/**
 * Before a send: one attempt counted, stamped now, and `next_attempt_at` set to when it is due again
 * should the process die mid-send. Returns the attempts made, this one included.
 */
export async function claimJiraPush(
  db: Db,
  claim: z.infer<typeof Claim>,
): R<{ readonly attempts: number }> {
  const parsed = Claim.safeParse(claim);
  if (!parsed.success) return invalid("claim", parsed.error);
  const c = parsed.data;
  return write(db, (ix) => {
    const pending = pendingOnly(ix, c.id);
    if (!pending.ok) return pending;
    const row = first(
      ix,
      qb
        .updateTable("jira_pushes")
        .set({
          attempts: sql<number>`attempts + 1`,
          last_attempt_at: ix.clock.now(),
          next_attempt_at: c.retry_at,
        })
        .where("id", "=", c.id)
        .returning("attempts"),
    );
    return row === undefined
      ? err(failure("internal", "the claimed push returned no row"))
      : ok({ attempts: row.attempts });
  });
}

export const JiraPushOutcome = z.discriminatedUnion("state", [
  z.object({ state: z.literal("sent") }),
  z.object({
    state: z.literal("pending"),
    next_attempt_at: Moment,
    error: z.string(),
  }),
  z.object({ state: z.literal("failed"), error: z.string() }),
  z.object({ state: z.literal("skipped"), error: z.string() }),
]);
export type JiraPushOutcome = z.infer<typeof JiraPushOutcome>;
const Settle = z.object({ id: Id, outcome: JiraPushOutcome });

/** After a send (or a check that skips it): the row's state, its error capped. */
export async function settleJiraPush(
  db: Db,
  settle: z.infer<typeof Settle>,
): R<void> {
  const parsed = Settle.safeParse(settle);
  if (!parsed.success) return invalid("settle", parsed.error);
  const { id, outcome } = parsed.data;
  return write(db, (ix) => {
    const pending = pendingOnly(ix, id);
    if (!pending.ok) return pending;
    const now = ix.clock.now();
    execute(
      ix,
      qb
        .updateTable("jira_pushes")
        .set(
          outcome.state === "sent"
            ? {
                state: "sent",
                sent_at: now,
                last_error: null,
                next_attempt_at: null,
              }
            : {
                state: outcome.state,
                last_error: capped(outcome.error),
                next_attempt_at:
                  outcome.state === "pending" ? outcome.next_attempt_at : null,
              },
        )
        .where("id", "=", id),
    );
    return ok(undefined);
  });
}

/** A pending push that is due, with its project's Jira site and account (null: source gone). */
export interface DueJiraPush {
  readonly id: string;
  readonly ticket_id: string;
  readonly workspace_id: string;
  readonly issue_key: string;
  readonly kind: string;
  readonly moment: string;
  readonly payload_json: string;
  readonly attempts: number;
  readonly jira_url: string | null;
  readonly jira_email: string | null;
  /** The ticket's fingerprint: whose site the issue key belongs to. */
  readonly origin_fingerprint: string | null;
}

/** Pending pushes due at `now`, oldest filed first, so a ticket's moves go in their order. */
export async function dueJiraPushes(
  db: Db,
  now: number,
  limit: number,
): R<DueJiraPush[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("jira_pushes as p")
        .innerJoin("workspaces as w", "w.id", "p.workspace_id")
        .innerJoin("tickets as t", "t.id", "p.ticket_id")
        .select([
          "t.origin_fingerprint",
          "p.id",
          "p.ticket_id",
          "p.workspace_id",
          "p.issue_key",
          "p.kind",
          "p.moment",
          "p.payload_json",
          "p.attempts",
          "w.jira_url",
          "w.jira_email",
        ])
        .where("p.state", "=", "pending")
        .where((eb) =>
          eb.or([
            eb("p.next_attempt_at", "is", null),
            eb("p.next_attempt_at", "<=", now),
          ]),
        )
        .orderBy(sql`p.rowid`)
        .limit(limit),
    ),
  );
}

/** A ticket's pushes, oldest first: what the tests and the ticket's history read. */
export async function jiraPushesOf(db: Db, ticketId: string) {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("jira_pushes")
        .selectAll()
        .where("ticket_id", "=", ticketId)
        .orderBy(sql`rowid`),
    ),
  );
}
