import { TICKET_STATUSES, type TicketStatus } from "@bayon/core";
import type {
  TicketDetail,
  TicketSummary,
  TransitionOption,
  TransitionRequest,
} from "@bayon/proto";

// The ticket screens' pure half: board columns, how a refusal reads, the notes a move needs, and
// the sessions (hence agents) behind a ticket.

/** `ticket_events.actor_kind` of a session's write (law facts); the operator's is "operator". */
const SESSION_ACTOR = "session";

/** The round count (v_ticket_economics.review_rounds: one per code_review attempt), as it reads. */
export const reviewRoundsLabel = (rounds: number): string =>
  `${rounds} review round${rounds === 1 ? "" : "s"}`;

export interface Column {
  readonly status: TicketStatus;
  readonly tickets: readonly TicketSummary[];
}

/** A board column as it is drawn: wide with its cards, or narrow (its label and count only). */
export interface BoardColumn extends Column {
  /** Narrow: an empty flow column, or a closed one kept folded until the operator opens it. */
  readonly collapsed: boolean;
  /** A closed status (done, parked, rejected, split): folded by default, opened on demand. */
  readonly folded: boolean;
}

const byPriorityThenNum = (a: TicketSummary, b: TicketSummary): number =>
  a.priority - b.priority || a.num - b.num;

/**
 * The statuses a ticket leaves (§3.2) or rests in: kept at the board's right edge, folded to a narrow
 * column that opens on demand, so the flow's columns keep the width.
 */
export const FOLDED_STATUSES: readonly TicketStatus[] = [
  "done",
  "parked",
  "rejected",
  "split",
];

/**
 * The board's columns (§12.3): every status, always, in the laws' order (§3.2) with the
 * closed ones last, so a column never moves when its last ticket leaves. A flow column is wide while
 * it holds a ticket; a closed one only once opened (`open`).
 */
export function boardColumns(
  tickets: readonly TicketSummary[],
  open: ReadonlySet<TicketStatus> = new Set(),
): BoardColumn[] {
  const flow = TICKET_STATUSES.filter((s) => !FOLDED_STATUSES.includes(s));
  return [...flow, ...FOLDED_STATUSES].map((status) => {
    const held = tickets
      .filter((ticket) => ticket.status === status)
      .toSorted(byPriorityThenNum);
    const folded = FOLDED_STATUSES.includes(status);
    return {
      status,
      tickets: held,
      folded,
      collapsed: held.length === 0 || (folded && !open.has(status)),
    };
  });
}

/** A refusal as the operator reads it: the rule, why, and the detail (M1 contract 2). */
export const refusalText = ({
  rule,
  reason,
  detail,
}: {
  readonly rule: string;
  readonly reason?: string | undefined;
  readonly detail?: string | undefined;
}): string =>
  `refused by ${rule}${reason === undefined ? "" : ` (${reason})`}${detail === undefined ? "" : `: ${detail}`}`;

export type NoteField =
  "reason" | "override_note" | "blocked_reason" | "unblock_condition";
export type Notes = Readonly<Record<NoteField, string>>;

export const NO_NOTES: Notes = {
  reason: "",
  override_note: "",
  blocked_reason: "",
  unblock_condition: "",
};

export const NOTE_LABELS: Readonly<Record<NoteField, string>> = {
  reason: "Reason",
  override_note: "Override note",
  blocked_reason: "Blocked reason",
  unblock_condition: "Unblock condition",
};

const BLOCKING: readonly NoteField[] = ["blocked_reason", "unblock_condition"];

/** The notes a move needs: those its law lists, and both blocked fields to block (§3.2). */
export const notesFor = (option: TransitionOption): readonly NoteField[] => [
  ...(option.input ?? []),
  ...(option.to === "blocked" ? BLOCKING : []),
];

/** The request for a move with each needed note trimmed, or null while one is blank. */
export function transitionRequest(
  to: TicketStatus,
  fields: readonly NoteField[],
  notes: Notes,
): TransitionRequest | null {
  if (fields.some((field) => notes[field].trim() === "")) return null;
  const note = (field: NoteField) =>
    fields.includes(field) ? notes[field].trim() : undefined;
  return {
    to,
    reason: note("reason"),
    override_note: note("override_note"),
    blocked_reason: note("blocked_reason"),
    unblock_condition: note("unblock_condition"),
  };
}

/** The sessions behind a ticket, first seen first: its owner, its hand-offs, every session that wrote to it. */
export function ticketSessionIds(detail: TicketDetail): string[] {
  const ids = [
    detail.ticket.owner_session_id,
    ...detail.handoffs.flatMap((h) => [h.from_session_id, h.to_session_id]),
    ...detail.events.items.map((event) =>
      event.actor_kind === SESSION_ACTOR ? event.actor_id : null,
    ),
  ].filter((id): id is string => id !== null);
  return [...new Set(ids)];
}
