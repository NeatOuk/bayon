import {
  STAFF_APPROVAL_KIND,
  closedQuestionKey,
  err,
  ok,
  type QuestionClose,
  type Result,
} from "@bayon/core";
import { sql, type SqlBool } from "kysely";
import { z } from "zod";
import { requireText } from "../checks.js";
import {
  all,
  first,
  qb,
  read,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { casMiss, failure, orNotFound } from "../errors.js";
import { toJsonText } from "../json.js";
import type { HumanRequestRow } from "../schema-work.js";
import { audited, type AuditEntry } from "./audit.js";
import { clearNeedsHumanIfAnsweredIn } from "./open-questions.js";
import type { TicketActor } from "./ticket-common.js";

// The operator's Inbox (§11.1, §12.1 `GET /inbox · POST /inbox/:id/answer`): human requests with
// the ticket and session they came from, and the one answer each gets. human_requests is the
// API's to write (§9.5).

const OPEN = "open";
const ANSWERED = "answered";
/** A question the operator withdrew as no longer relevant: closed, with no answer. */
const DISMISSED = "dismissed";

/** A human request with its ticket's and session's context; NULL where the request has none. */
export interface InboxRow extends HumanRequestRow {
  readonly ticket_num: number | null;
  readonly ticket_title: string | null;
  readonly ticket_status: string | null;
  readonly session_role: string | null;
  readonly session_state: string | null;
  readonly agent_name: string | null;
}

const inboxSelect = () =>
  qb
    .selectFrom("human_requests as h")
    .leftJoin("tickets as t", "t.id", "h.ticket_id")
    .leftJoin("sessions as s", "s.id", "h.session_id")
    .leftJoin("agents as a", "a.id", "s.agent_id")
    .selectAll("h")
    .select([
      "t.num as ticket_num",
      "t.title as ticket_title",
      "t.status as ticket_status",
      "s.role as session_role",
      "s.state as session_state",
      "a.name as agent_name",
    ]);

/** The listing's first sort key: 1 for an open request, 0 for any other (`h` is human_requests). */
const OPEN_RANK = sql<number>`CASE WHEN h.status = ${OPEN} THEN 1 ELSE 0 END`;

/**
 * A row's place in the listing, which orders by (rank, asked_at, id), all descending. A page
 * resumes strictly after the previous page's last row (keyset, never an offset), so a request
 * answered between two fetches moves to the answered part and no open request is skipped.
 */
const InboxAfterShape = z.object({
  rank: z.union([z.literal(0), z.literal(1)]),
  asked_at: z.int().nonnegative(),
  id: z.string().min(1),
});
export type InboxAfter = z.infer<typeof InboxAfterShape>;

/** Where the page after `row` starts. */
export const inboxAfter = (row: HumanRequestRow): InboxAfter => ({
  rank: row.status === OPEN ? 1 : 0,
  asked_at: row.asked_at,
  id: row.id,
});

const InboxRequestsQueryShape = z.object({
  /** One status only; absent lists every request, open ones first. */
  status: z.string().min(1).optional(),
  /** One kind only (`staff_approval`); absent lists every kind. */
  kind: z.string().min(1).optional(),
  /**
   * One project's requests: its ticket's workspace, else its session's, else that
   * session's agent's, as the timeline scopes a request.
   */
  workspaceId: z.string().min(1).optional(),
  /** One ticket's requests, by its number (the ticket view's open questions). */
  ticketNum: z.int().positive().optional(),
  /** The previous page's last row; absent starts at the top. */
  after: InboxAfterShape.optional(),
  limit: z.int().min(1).max(1000),
});
export type InboxRequestsQuery = z.input<typeof InboxRequestsQueryShape>;

export interface InboxRequestsPage {
  readonly rows: InboxRow[];
  readonly hasMore: boolean;
}

/** A page of human requests: open first, then newest asked first. */
export async function listInboxRequests(
  db: Db,
  query: InboxRequestsQuery,
): R<InboxRequestsPage> {
  const parsed = InboxRequestsQueryShape.safeParse(query);
  if (!parsed.success) {
    return err(
      failure(
        "validation",
        `bad inbox query: ${z.prettifyError(parsed.error)}`,
      ),
    );
  }
  const { status, kind, workspaceId, ticketNum, after, limit } = parsed.data;
  return read(db, (ix) => {
    const rows = all(
      ix,
      inboxSelect()
        .$if(status !== undefined, (b) =>
          b.where("h.status", "=", status ?? ""),
        )
        .$if(kind !== undefined, (b) => b.where("h.kind", "=", kind ?? ""))
        .$if(workspaceId !== undefined, (b) =>
          b.where(
            (eb) =>
              eb.fn.coalesce(
                "t.workspace_id",
                "s.workspace_id",
                "a.workspace_id",
              ),
            "=",
            workspaceId ?? "",
          ),
        )
        .$if(ticketNum !== undefined, (b) =>
          b.where("t.num", "=", ticketNum ?? 0),
        )
        .$if(after !== undefined, (b) =>
          b.where(
            sql<SqlBool>`(${OPEN_RANK}, h.asked_at, h.id) < (${after?.rank}, ${after?.asked_at}, ${after?.id})`,
          ),
        )
        .orderBy(OPEN_RANK, "desc")
        .orderBy("h.asked_at", "desc")
        .orderBy("h.id", "desc")
        .limit(limit + 1),
    );
    return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
  });
}

export async function getInboxRequest(db: Db, id: string): R<InboxRow> {
  const found = await read(db, (ix) =>
    first(ix, inboxSelect().where("h.id", "=", id)),
  );
  return orNotFound(found, `human request ${id}`);
}

export interface HumanAnswer {
  readonly id: string;
  /** Stored as JSON text in answer_json: what ticket_get hands the asking session. */
  readonly answer: string;
  readonly answered_by: string;
}

/**
 * What a closed question does besides itself, in the closing transaction: its dedupe key
 * stops naming it open, so the same question may be asked again; and when it was the ticket's last
 * open question, needs_human clears (a version bump and an `updated` event, the operator as actor).
 * Closing one of two leaves the flag set. Its `answered_at`, set by the caller, is the completion
 * that wakes the orchestrator when it was the last (pulse-reads.ts, lastAnswer).
 */
function settleQuestion(
  ix: Internals,
  row: HumanRequestRow,
  by: string,
  how: QuestionClose,
): HumanRequestRow {
  const key = closedQuestionKey(row.dedupe_key, row.id, how);
  const settled =
    key === null
      ? row
      : (first(
          ix,
          qb
            .updateTable("human_requests")
            .set({ dedupe_key: key })
            .where("id", "=", row.id)
            .returningAll(),
        ) ?? row);
  if (row.ticket_id !== null) {
    clearNeedsHumanIfAnsweredIn(ix, row.ticket_id, {
      actor_kind: "operator",
      actor_id: by,
      reason: `last open question ${how}`,
    });
  }
  return settled;
}

/**
 * Closes open request `id` as `how` with `patch`, then settles it; a miss says why: a staffing
 * proposal is `validation` (only answerStaffProposal acts on one), a closed request
 * `conflict`, an unknown one `not_found`.
 */
function closeIn(
  ix: Internals,
  id: string,
  how: QuestionClose,
  by: string,
  patch: { readonly answer_json: string | null },
): Result<HumanRequestRow> {
  const closed = first(
    ix,
    qb
      .updateTable("human_requests")
      .set({
        status: how,
        ...patch,
        answered_by: by,
        answered_at: ix.clock.now(),
      })
      .where("id", "=", id)
      .where("status", "=", OPEN)
      .where("kind", "<>", STAFF_APPROVAL_KIND)
      .returningAll(),
  );
  if (closed !== undefined) return ok(settleQuestion(ix, closed, by, how));
  const current = first(
    ix,
    qb
      .selectFrom("human_requests")
      .select(["status", "kind"])
      .where("id", "=", id),
  );
  if (current?.kind === STAFF_APPROVAL_KIND) {
    return err(
      failure(
        "validation",
        how === "answered"
          ? `human request ${id} is a staffing proposal: answer it approve or reject`
          : `human request ${id} is a staffing proposal: reject it instead`,
      ),
    );
  }
  return casMiss(
    `human request ${id}`,
    current === undefined ? undefined : { state: current.status },
    [OPEN],
  );
}

/**
 * Answers an open human request (status, answer, who, when), with the caller's audit entry in the
 * same transaction. An answer is final: an answered request is `conflict`, an unknown one
 * `not_found`. `answered_at` is what wakes the asker's pulse (M2-e). A staffing proposal is refused
 * (`validation`): its answer acts, and only answerStaffProposal acts on it.
 */
export async function answerHumanRequest(
  db: Db,
  a: HumanAnswer,
  audit: AuditEntry,
): R<HumanRequestRow> {
  const checked = requireText({
    id: a.id,
    answer: a.answer,
    answered_by: a.answered_by,
  });
  if (!checked.ok) return checked;
  const answer = toJsonText(a.answer, "answer");
  if (!answer.ok) return answer;
  return write(db, (ix) =>
    audited(
      ix,
      closeIn(ix, a.id, ANSWERED, a.answered_by, { answer_json: answer.value }),
      audit,
    ),
  );
}

export interface HumanDismissal {
  readonly id: string;
  /** Who dismissed it, as the request records it (answered_by). */
  readonly dismissed_by: string;
  /** The actor: only the operator dismisses. */
  readonly by: TicketActor;
}

/**
 * Dismisses an open question as no longer relevant: status `dismissed`, no answer, who
 * and when (answered_by, answered_at), audited in the same transaction. It stops holding its ticket,
 * and closes it as an answer would: the key is rewritten, and the last open question's dismissal
 * clears needs_human and is the one completion that wakes the orchestrator. A session's staffing of
 * the ticket goes ahead again; nothing tells a later session to act on it. Only the operator
 * dismisses (validation otherwise), and never a staffing proposal, which is rejected instead.
 */
export async function dismissHumanRequest(
  db: Db,
  d: HumanDismissal,
  audit: AuditEntry,
): R<HumanRequestRow> {
  const checked = requireText({ id: d.id, dismissed_by: d.dismissed_by });
  if (!checked.ok) return checked;
  if (d.by.actor_kind !== "operator") {
    return err(failure("validation", "only the operator dismisses a question"));
  }
  return write(db, (ix) =>
    audited(
      ix,
      closeIn(ix, d.id, DISMISSED, d.dismissed_by, { answer_json: null }),
      audit,
    ),
  );
}
