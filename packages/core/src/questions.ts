import { STAFF_APPROVAL_KIND } from "./staff-proposal.js";

// A ticket's questions to the operator: its open human requests of any kind but a
// staffing proposal. `human.ask` never blocks the session that asks (§11.1); the ticket waits for
// the answer instead. Pure: the db's writers and reads use these, and the rows are theirs.

/** The one human_requests kind that is not a question: a staffing proposal keeps rules. */
export const NOT_A_QUESTION_KIND = STAFF_APPROVAL_KIND;

/**
 * A question as its dedupe compares it: NFC, lower case, whitespace collapsed, and no trailing
 * `?`, `.` or `!`. Two asks that differ only in those are one question.
 */
export function normalizeQuestion(question: string): string {
  return question
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[?.!\s]+$/u, "");
}

const OPEN_SUFFIX = ":open";

/**
 * `human_requests.dedupe_key` of an open question: `ask:<ticket>:<digest>:open`, where the digest is
 * of the normalized question. The unique index (014) holds forever, so the key names its status:
 * closing it rewrites it (`closedQuestionKey`), and the same question may be asked again later.
 */
export const openQuestionKey = (ticketId: string, digest: string): string =>
  `ask:${ticketId}:${digest}${OPEN_SUFFIX}`;

/** How an open question closes: the operator answers it, or dismisses it as no longer relevant. */
export type QuestionClose = "answered" | "dismissed";

/**
 * The key a closed question keeps, `ask:<ticket>:<digest>:<how>:<request id>`: unique by the id.
 * Null: not an open ask key (a system request's, or none), which stays as it is.
 */
export function closedQuestionKey(
  key: string | null,
  requestId: string,
  how: QuestionClose,
): string | null {
  if (key === null || !key.startsWith("ask:") || !key.endsWith(OPEN_SUFFIX)) {
    return null;
  }
  return `${key.slice(0, -OPEN_SUFFIX.length)}:${how}:${requestId}`;
}
