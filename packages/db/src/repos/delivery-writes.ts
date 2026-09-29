import {
  err,
  excerpt,
  newId,
  ok,
  stripPushUrlCredentials,
  type Result,
} from "@bayon/core";
import { z } from "zod";
import {
  execute,
  first,
  qb,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import type { DeliveryRow, DeliveryState } from "../schema-work.js";
import { insertAudit } from "./audit.js";
import { SUPERVISOR_ACTOR } from "./system-requests.js";
import { insertTicketEvent } from "./ticket-common.js";

// The delivery writer (§9.5 amendment, the third supervisor ticket write beside
// blockTicket and advanceTicket — the design §1.6).
//
// `deliveries` is the supervisor's own table: one row per (ticket, repo) under a unique index, so
// recording what a run reached is an upsert and a re-run reads it back. Two of the columns this
// module touches are a **ticket's** (`tickets.pr_url` and a `ticket_links` row), which §9.5
// otherwise gives the API. They are here because the supervisor is the only process that learns
// them — it made the network call — and because they must commit with the `deliveries` rows that
// describe them, or a restart between the two would leave a pull request nothing remembers.
//
// Nothing here holds a credential: `remote_host` is a host, `remote_url` (039) is refused while it
// still carries userinfo that could be a secret (core `stripPushUrlCredentials`), and `error` is scrubbed by its caller before it arrives and capped again here (§14, Invariant 11).

/** Which of the supervisor's parts acts: its ticket_events rows carry it as actor_id. */
export const DELIVERY_ACTOR_ID = "delivery";
export const DELIVERY_ACTION = "supervisor.delivery";
/** `ticket_links.kind` of a pull request this job opened. */
export const PR_LINK_KIND = "pr";
/** How much of a failure's message a row keeps: a reason, never a transcript (Invariant 9). */
export const DELIVERY_ERROR_MAX = 500;

const Record_ = z.object({
  ticket_id: z.string().min(1),
  repo_id: z.string().min(1),
  branch: z.string().min(1),
  head_sha: z.string().min(1).nullable(),
  remote_host: z.string().min(1).nullable(),
  remote_url: z
    .string()
    .min(1)
    .refine(
      (url) => !stripPushUrlCredentials(url).stripped,
      "remote_url must carry no credentials",
    )
    .nullable(),
  state: z.enum(["pushed", "pr_open", "failed"]),
  pr_url: z.string().min(1).nullable(),
  pr_number: z.int().positive().nullable(),
  error: z.string().nullable(),
  started_at: z.int().nonnegative(),
});

/** What one repo's delivery reached, as the job hands it over. */
export interface DeliveryRecord {
  readonly ticket_id: string;
  readonly repo_id: string;
  readonly branch: string;
  readonly head_sha: string | null;
  readonly remote_host: string | null;
  /** The target pushed to, credentials already removed by the caller (039). */
  readonly remote_url: string | null;
  readonly state: DeliveryState;
  readonly pr_url: string | null;
  readonly pr_number: number | null;
  /** Already scrubbed of every secret by the caller; capped here. */
  readonly error: string | null;
  readonly started_at: number;
}

function recordIn(ix: Internals, r: DeliveryRecord): Result<DeliveryRow> {
  const parsed = Record_.safeParse(r);
  if (!parsed.success) {
    return err(
      failure("validation", `delivery: ${z.prettifyError(parsed.error)}`),
    );
  }
  const p = parsed.data;
  const now = ix.clock.now();
  const values = {
    ticket_id: p.ticket_id,
    repo_id: p.repo_id,
    branch: p.branch,
    head_sha: p.head_sha,
    remote_host: p.remote_host,
    remote_url: p.remote_url,
    state: p.state,
    pr_url: p.pr_url,
    pr_number: p.pr_number,
    error: p.error === null ? null : excerpt(p.error, DELIVERY_ERROR_MAX),
    started_at: p.started_at,
    ended_at: now,
    // A new delivery of the (ticket, repo) — a new commit, a new request — is no longer the merge
    // an earlier poll recorded (040).
    merged_at: null,
    merged_by: null,
  };
  const row = first(
    ix,
    qb
      .insertInto("deliveries")
      .values({ id: newId(now), ...values })
      .onConflict((oc) =>
        oc.columns(["ticket_id", "repo_id"]).doUpdateSet(values),
      )
      .returningAll(),
  );
  return row === undefined
    ? err(failure("internal", `delivery ${p.ticket_id}/${p.repo_id}: no row`))
    : ok(row);
}

/** One repo's outcome, recorded. A second call for the same (ticket, repo) replaces the row. */
export async function recordDelivery(
  db: Db,
  r: DeliveryRecord,
): R<DeliveryRow> {
  return write(db, (ix) => recordIn(ix, r));
}

/** A pull request this job opened or reused, for `ticket_links`. */
export interface DeliveredPr {
  readonly repo_id: string;
  readonly url: string;
}

export interface DeliveryCommit {
  readonly ticket_id: string;
  /** One row per repo delivered, in the order they were pushed. */
  readonly records: readonly DeliveryRecord[];
  /** The pull requests to link; empty in `push` mode. */
  readonly prs: readonly DeliveredPr[];
  /**
   * The ticket's canonical pull request — the parent's in a submodule or multi-repo project, the
   * lone repo's otherwise. Null leaves `tickets.pr_url` alone: a delivery never clears it.
   */
  readonly pr_url: string | null;
  /** One line for the ticket's timeline; empty writes no event. */
  readonly note: string;
}

export interface DeliveryCommitted {
  readonly rows: readonly DeliveryRow[];
  /** Links actually inserted: one already there is left alone, so a retry adds nothing. */
  readonly linked: number;
  readonly pr_url: string | null;
}

/**
 * Everything one ticket's delivery learned, in one transaction: a row per repo, a `ticket_links`
 * row per pull request that has none yet, `tickets.pr_url`, a `supervisor.delivery` audit row and
 * one `delivery` ticket_event.
 *
 * Idempotent by construction: the rows upsert, a link already present is skipped, and `pr_url` is
 * written only when it changes. A re-run of a finished delivery writes nothing but its audit row —
 * and the job does not call this at all when it found nothing left to do.
 */
export async function commitDelivery(
  db: Db,
  c: DeliveryCommit,
): R<DeliveryCommitted> {
  if (c.ticket_id.trim() === "") {
    return err(failure("validation", "commitDelivery: no ticket"));
  }
  return write(db, (ix) => {
    const rows: DeliveryRow[] = [];
    for (const record of c.records) {
      const row = recordIn(ix, record);
      if (!row.ok) return row;
      rows.push(row.value);
    }
    const now = ix.clock.now();
    let linked = 0;
    for (const pr of c.prs) {
      const already = first(
        ix,
        qb
          .selectFrom("ticket_links")
          .select("url")
          .where("ticket_id", "=", c.ticket_id)
          .where("kind", "=", PR_LINK_KIND)
          .where("url", "=", pr.url),
      );
      if (already !== undefined) continue;
      execute(
        ix,
        qb.insertInto("ticket_links").values({
          ticket_id: c.ticket_id,
          kind: PR_LINK_KIND,
          url: pr.url,
          target_ticket_id: null,
          created_at: now,
        }),
      );
      linked += 1;
    }
    const ticket = first(
      ix,
      qb.selectFrom("tickets").select(["pr_url"]).where("id", "=", c.ticket_id),
    );
    if (ticket === undefined) {
      return err(failure("not_found", `ticket ${c.ticket_id}`));
    }
    // Never cleared, and never overwritten with the same value: `updated_at` moving would put the
    // ticket back at the head of the sweep's page for no reason.
    const setsUrl = c.pr_url !== null && c.pr_url !== ticket.pr_url;
    if (setsUrl) {
      execute(
        ix,
        qb
          .updateTable("tickets")
          .set({ pr_url: c.pr_url, updated_at: now })
          .where("id", "=", c.ticket_id),
      );
    }
    const audit = insertAudit(ix, {
      actor: SUPERVISOR_ACTOR,
      action: DELIVERY_ACTION,
      target_kind: "ticket",
      target_id: c.ticket_id,
      payload: {
        repos: rows.map((r) => ({
          repo_id: r.repo_id,
          state: r.state,
          branch: r.branch,
        })),
        prs: c.prs.length,
        pr_url: setsUrl ? c.pr_url : null,
      },
    });
    if (!audit.ok) return audit;
    if (c.note.trim() !== "") {
      insertTicketEvent(ix, {
        ticket_id: c.ticket_id,
        ts: now,
        actor_kind: SUPERVISOR_ACTOR,
        actor_id: DELIVERY_ACTOR_ID,
        kind: "delivery",
        from_status: null,
        to_status: null,
        reason: null,
        payload_json: JSON.stringify({
          note: excerpt(c.note.trim(), DELIVERY_ERROR_MAX),
          repos: rows.map((r) => r.repo_id),
        }),
      });
    }
    return ok({ rows, linked, pr_url: setsUrl ? c.pr_url : ticket.pr_url });
  });
}
