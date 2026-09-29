import {
  MERGE_STATUSES,
  err,
  ok,
  pushTargetOf,
  ticketKey,
  type Result,
} from "@bayon/core";
import { sql } from "kysely";
import { z } from "zod";
import {
  all,
  first,
  qb,
  read,
  readSnapshot,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import type { DeliveryCursor } from "./delivery-reads.js";
import { keyPrefix } from "./ticket-key.js";

// What the supervisor's pull-request sweep reads (spike §1.6). Two queries, shaped as the
// delivery sweep's: the tickets with something to watch, keyset-paged on (updated_at, id), and one
// ticket's open requests with where each lives. Nothing here writes or decides.

/** A ticket the sweep looks at, and whether it has anything to ask the forge. */
export interface PullRequestCandidate extends DeliveryCursor {
  readonly status: string;
}

const Query = z.object({
  limit: z.int().min(1).max(1_000),
  after: z.object({ updated_at: z.int(), id: z.string().min(1) }).nullable(),
});

/**
 * Up to `limit` tickets after `after`, by updated_at then id, that either have a pull request still
 * open (`pr_open`, a forge to poll) — whatever the ticket's status, so a request delivered after its
 * ticket was done or rejected is still followed until it settles — or sit in a status a
 * merge closes, in a project that closes on merge, with a merged request and none still open — the
 * switch turned on after the merge was recorded, which needs `advanceTicket` and no HTTP at all.
 */
export async function listPullRequestCandidates(
  db: Db,
  q: { readonly limit: number; readonly after: DeliveryCursor | null },
): R<PullRequestCandidate[]> {
  const parsed = Query.safeParse(q);
  if (!parsed.success) {
    return err(
      failure(
        "validation",
        `listPullRequestCandidates: ${z.prettifyError(parsed.error)}`,
      ),
    );
  }
  const { limit, after } = parsed.data;
  const merging = sql.join(MERGE_STATUSES.map((s) => sql.lit(s)));
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("tickets as t")
        .select(["t.id", "t.status", "t.updated_at"])
        .where(
          sql<boolean>`(EXISTS (SELECT 1 FROM deliveries d WHERE d.ticket_id = t.id AND d.state = 'pr_open')
            OR (t.status IN (${merging})
                AND coalesce((SELECT w.close_on_merge FROM workspaces w WHERE w.id = t.workspace_id), 0) = 1
                AND EXISTS (SELECT 1 FROM deliveries d WHERE d.ticket_id = t.id AND d.state = 'merged')))`,
        )
        .$call((b) =>
          after === null
            ? b
            : b.where((eb) =>
                eb.or([
                  eb("t.updated_at", ">", after.updated_at),
                  eb.and([
                    eb("t.updated_at", "=", after.updated_at),
                    eb("t.id", ">", after.id),
                  ]),
                ]),
              ),
        )
        .orderBy("t.updated_at")
        .orderBy("t.id")
        .limit(limit),
    ),
  );
}

/** One open pull request of a ticket, and the remote it lives on. */
export interface WatchedPullRequest {
  readonly repo_id: string;
  readonly pr_url: string;
  readonly pr_number: number;
  /**
   * The target it was delivered to: the row's `remote_url` (039, credentials already removed), or
   * for a row from before 039 the repo's push target (`push_url ?? origin_url`). What decides the
   * forge, its owner and repository — never git's own config.
   */
  readonly target_url: string | null;
  /** The last poll's error, scrubbed; null when the last poll read it. */
  readonly error: string | null;
}

export interface PullRequestWatch {
  readonly ticket_id: string;
  readonly ticket_key: string;
  readonly status: string;
  /** Its requests still `pr_open`, by repo; empty when there is nothing to poll. */
  readonly open: readonly WatchedPullRequest[];
}

/** Everything one ticket's poll needs, in one snapshot. A missing ticket is `not_found`. */
export async function pullRequestWatch(
  db: Db,
  ticketId: string,
): R<PullRequestWatch> {
  const found = await readSnapshot(db, (ix) => watchIn(ix, ticketId));
  return found.ok ? found.value : found;
}

function watchIn(ix: Internals, ticketId: string): Result<PullRequestWatch> {
  const ticket = first(
    ix,
    qb
      .selectFrom("tickets")
      .select(["id", "num", "status"])
      .where("id", "=", ticketId),
  );
  if (ticket === undefined) {
    return err(failure("not_found", `ticket ${ticketId}`));
  }
  const rows = all(
    ix,
    qb
      .selectFrom("deliveries as d")
      .innerJoin("repos as r", "r.id", "d.repo_id")
      .select([
        "d.repo_id as repo_id",
        "d.pr_url as pr_url",
        "d.pr_number as pr_number",
        "d.remote_url as remote_url",
        "d.error as error",
        "r.push_url as push_url",
        "r.origin_url as origin_url",
      ])
      .where("d.ticket_id", "=", ticketId)
      .where("d.state", "=", "pr_open")
      .orderBy("d.repo_id"),
  );
  const open = rows.flatMap((row): WatchedPullRequest[] =>
    row.pr_url === null || row.pr_number === null
      ? []
      : [
          {
            repo_id: row.repo_id,
            pr_url: row.pr_url,
            pr_number: row.pr_number,
            target_url: row.remote_url ?? pushTargetOf(row),
            error: row.error,
          },
        ],
  );
  return ok({
    ticket_id: ticket.id,
    ticket_key: ticketKey(keyPrefix(ix), ticket.num),
    status: ticket.status,
    open,
  });
}
