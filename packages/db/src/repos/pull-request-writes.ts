import { MERGE_STATUSES, err, excerpt, ok, type Result } from "@bayon/core";
import { z } from "zod";
import {
  all,
  execute,
  first,
  qb,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import type { DeliveryRow, DeliveriesTable } from "../schema-work.js";
import {
  MERGE_ACTOR_ID,
  advanceTicketIn,
  type AdvanceOutcome,
} from "./advance-ticket.js";
import { insertAudit } from "./audit.js";
import { DELIVERY_ERROR_MAX } from "./delivery-writes.js";
import {
  SUPERVISOR_ACTOR,
  insertSystemHumanRequestIn,
} from "./system-requests.js";
import { insertTicketEvent } from "./ticket-common.js";

// settlePullRequests (§9.5 amendment beside commitDelivery): what the pull-request sweep
// read from the forge, recorded in one transaction per ticket — and, when that made every request
// merged, `merge_close` taken through advanceTicketIn in the same transaction, so a recorded merge
// and the ticket it closes commit together or not at all.
//
// Each end is a compare-and-set on `state = 'pr_open'`: a row the sweep already settled is left as
// it is, so a second call with the same observation writes nothing and files nothing. `merged_by` is
// a forge login and `error` is scrubbed by the caller and capped here — nothing here holds a
// credential (§14, Invariant 11).

export const PULL_REQUESTS_ACTION = "supervisor.pull_requests";
/** `merged_by` when the forge named no one: the payload's field is always a string. */
export const UNKNOWN_MERGER = "unknown";
/** How long a pull request's human request stays open before it expires: a week. */
const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

type DeliveryPatch = Partial<
  Pick<
    DeliveriesTable,
    "state" | "merged_at" | "merged_by" | "error" | "ended_at"
  >
>;

/** What one open request turned out to be, on this poll. */
export type PullRequestSeen =
  | { readonly repo_id: string; readonly kind: "open" }
  | {
      readonly repo_id: string;
      readonly kind: "merged";
      readonly merged_at: number | null;
      readonly merged_by: string | null;
    }
  | { readonly repo_id: string; readonly kind: "closed" }
  | {
      readonly repo_id: string;
      readonly kind: "error";
      /** Already scrubbed of every secret by the caller; capped here. */
      readonly error: string;
      /** False: only the operator can fix it (a refused token, a request the forge cannot show). */
      readonly retryable: boolean;
    };

const RepoId = z.string().min(1).max(200);
const Seen = z.discriminatedUnion("kind", [
  z.object({ repo_id: RepoId, kind: z.literal("open") }),
  z.object({
    repo_id: RepoId,
    kind: z.literal("merged"),
    merged_at: z.int().nonnegative().nullable(),
    merged_by: z.string().min(1).max(100).nullable(),
  }),
  z.object({ repo_id: RepoId, kind: z.literal("closed") }),
  z.object({
    repo_id: RepoId,
    kind: z.literal("error"),
    error: z.string().min(1),
    retryable: z.boolean(),
  }),
]);
const Settle = z.object({
  ticket_id: z.string().min(1),
  ticket_key: z.string().min(1),
  seen: z.array(Seen).max(1_000),
});

export interface PullRequestSettle {
  readonly ticket_id: string;
  /** Its key, as the requests it files name it. */
  readonly ticket_key: string;
  /** One entry per open request polled; empty asks only whether the ticket can now close. */
  readonly seen: readonly PullRequestSeen[];
}

export interface PullRequestsSettled {
  /** Requests recorded merged by this call, by url. */
  readonly merged: readonly string[];
  /** Requests recorded closed without merging by this call, by url. */
  readonly closed: readonly string[];
  /** Human requests this call filed. */
  readonly filed: number;
  /** The machine step taken after, or why none was: null when the status is not one a merge closes. */
  readonly advance: AdvanceOutcome | null;
}

/** A key part: no colon, no whitespace (core's SystemHumanRequest). */
const keyPart = (text: string): string => text.replace(/[\s:]+/g, "_");

interface Changes {
  readonly merged: { url: string; repo_id: string; merged_by: string | null }[];
  readonly closed: { url: string; repo_id: string }[];
  filed: number;
}

/** The `delivery` human request for `row`, once per condition: the key refuses a second. */
function ask(
  ix: Internals,
  s: z.infer<typeof Settle>,
  row: DeliveryRow,
  window: string,
  question: string,
  context: string,
  c: Changes,
): Result<void> {
  const filed = insertSystemHumanRequestIn(ix, {
    rule: "delivery",
    subject: keyPart(s.ticket_id),
    window: keyPart(`${window}/${row.repo_id}#${row.pr_number ?? 0}`),
    question: excerpt(question, 500),
    context_md: excerpt(context, 2_000),
    options: ["I dealt with it", "Stop delivering this project"],
    ticket_id: s.ticket_id,
    expires_at: ix.clock.now() + REQUEST_TTL_MS,
  });
  if (!filed.ok) return filed;
  if (filed.value.created) c.filed += 1;
  return ok(undefined);
}

/**
 * What a request closed unmerged asks, by the ticket's status: nothing on a rejected
 * ticket — closing its request is what rejecting means — a warning that the work never landed on a
 * done one, and otherwise that the ticket stays where it is.
 */
function closedQuestion(
  s: z.infer<typeof Settle>,
  status: string,
  row: DeliveryRow,
  url: string,
): { question: string; context: string } | null {
  if (status === "rejected") return null;
  if (status === "done") {
    return {
      question: `PR closed without merging on a done ticket: ${url}`,
      context: `${s.ticket_key} is done, but its pull request on \`${row.repo_id}\` was closed unmerged — the work has not landed. Reopen the PR, or reopen the ticket.`,
    };
  }
  return {
    question: `PR closed without merging: ${url}`,
    context: `${s.ticket_key}'s pull request on \`${row.repo_id}\` was closed without being merged, so the ticket stays where it is. Reopen or replace it on the forge, or move the ticket yourself.`,
  };
}

/**
 * One observation against its row. A row no longer `pr_open` was settled already: nothing. A
 * rejected ticket's request is still recorded to its end, but asks the operator nothing.
 */
function settleOne(
  ix: Internals,
  s: z.infer<typeof Settle>,
  seen: z.infer<typeof Seen>,
  row: DeliveryRow,
  c: Changes,
  status: string,
): Result<void> {
  const now = ix.clock.now();
  /** The CAS: this row, only while it is still `pr_open`. */
  const update = (set: DeliveryPatch): void => {
    execute(
      ix,
      qb
        .updateTable("deliveries")
        .set(set)
        .where("id", "=", row.id)
        .where("state", "=", "pr_open"),
    );
  };
  const url = row.pr_url ?? "";
  switch (seen.kind) {
    case "merged":
      update({
        state: "merged",
        merged_at: seen.merged_at ?? now,
        merged_by: seen.merged_by,
        error: null,
        ended_at: now,
      });
      c.merged.push({ url, repo_id: row.repo_id, merged_by: seen.merged_by });
      return ok(undefined);
    case "closed": {
      update({ state: "closed", error: null, ended_at: now });
      c.closed.push({ url, repo_id: row.repo_id });
      const closed = closedQuestion(s, status, row, url);
      return closed === null
        ? ok(undefined)
        : ask(ix, s, row, "closed", closed.question, closed.context, c);
    }
    case "error": {
      const error = excerpt(seen.error, DELIVERY_ERROR_MAX);
      if (row.error !== error) {
        update({ error });
      }
      return seen.retryable || status === "rejected"
        ? ok(undefined)
        : ask(
            ix,
            s,
            row,
            "poll",
            `${s.ticket_key}'s pull request could not be read: ${url}`,
            `\`${row.repo_id}\`: ${error}`,
            c,
          );
    }
    case "open":
      if (row.error !== null) {
        update({ error: null });
      }
      return ok(undefined);
  }
}

/** The ticket's timeline and the audit log, for what this call changed: who merged, and where. */
function record(ix: Internals, ticketId: string, c: Changes): Result<void> {
  if (c.merged.length === 0 && c.closed.length === 0) return ok(undefined);
  const payload = {
    merged: c.merged.map((m) => ({
      repo_id: m.repo_id,
      url: m.url,
      merged_by: m.merged_by,
    })),
    closed: c.closed.map((m) => ({ repo_id: m.repo_id, url: m.url })),
  };
  const audit = insertAudit(ix, {
    actor: SUPERVISOR_ACTOR,
    action: PULL_REQUESTS_ACTION,
    target_kind: "ticket",
    target_id: ticketId,
    payload,
  });
  if (!audit.ok) return audit;
  const note = [
    ...c.merged.map(
      (m) =>
        `merged${m.merged_by === null ? "" : ` by ${m.merged_by}`}: ${m.url}`,
    ),
    ...c.closed.map((m) => `closed without merging: ${m.url}`),
  ].join(" · ");
  insertTicketEvent(ix, {
    ticket_id: ticketId,
    ts: ix.clock.now(),
    actor_kind: SUPERVISOR_ACTOR,
    actor_id: MERGE_ACTOR_ID,
    kind: "delivery",
    from_status: null,
    to_status: null,
    reason: null,
    payload_json: JSON.stringify({
      note: excerpt(note, DELIVERY_ERROR_MAX),
      ...payload,
    }),
  });
  return ok(undefined);
}

const MERGING: ReadonlySet<string> = new Set(MERGE_STATUSES);

function settleIn(
  ix: Internals,
  s: z.infer<typeof Settle>,
): Result<PullRequestsSettled> {
  const ticket = first(
    ix,
    qb.selectFrom("tickets").select(["status"]).where("id", "=", s.ticket_id),
  );
  if (ticket === undefined) {
    return err(failure("not_found", `ticket ${s.ticket_id}`));
  }
  const rows = new Map(
    all(
      ix,
      qb
        .selectFrom("deliveries")
        .selectAll()
        .where("ticket_id", "=", s.ticket_id)
        .where("state", "=", "pr_open"),
    ).map((row) => [row.repo_id, row]),
  );
  const c: Changes = { merged: [], closed: [], filed: 0 };
  for (const seen of s.seen) {
    const row = rows.get(seen.repo_id);
    if (row === undefined) continue;
    const settled = settleOne(ix, s, seen, row, c, ticket.status);
    if (!settled.ok) return settled;
  }
  const recorded = record(ix, s.ticket_id, c);
  if (!recorded.ok) return recorded;
  const done = {
    merged: c.merged.map((m) => m.url),
    closed: c.closed.map((m) => m.url),
    filed: c.filed,
  };
  // A done or rejected ticket is never in a merging status: its request's end moves nothing.
  if (!MERGING.has(ticket.status)) return ok({ ...done, advance: null });
  // Every merged request of the ticket, oldest merge first: what the move to done records — its
  // urls, and the login of the last merge, the one that closed it.
  const mergedRows = all(
    ix,
    qb
      .selectFrom("deliveries")
      .select(["pr_url", "merged_by"])
      .where("ticket_id", "=", s.ticket_id)
      .where("state", "=", "merged")
      .orderBy("merged_at")
      .orderBy("repo_id"),
  );
  const advance = advanceTicketIn(ix, s.ticket_id, {
    merged_by: mergedRows.at(-1)?.merged_by ?? UNKNOWN_MERGER,
    pr_urls: mergedRows.flatMap((d) => (d.pr_url === null ? [] : [d.pr_url])),
  });
  return advance.ok ? ok({ ...done, advance: advance.value }) : advance;
}

/**
 * Records what one ticket's poll saw and, in the same transaction, closes the ticket when that made
 * every pull request merged in a project that closes on merge (core's `merge_close`). A second call
 * with the same observations writes nothing and files nothing.
 */
export async function settlePullRequests(
  db: Db,
  s: PullRequestSettle,
): R<PullRequestsSettled> {
  const parsed = Settle.safeParse(s);
  if (!parsed.success) {
    return err(
      failure(
        "validation",
        `settlePullRequests: ${z.prettifyError(parsed.error)}`,
      ),
    );
  }
  return write(db, (ix) => settleIn(ix, parsed.data));
}
