import { StaffProposal } from "@bayon/core";
import { z } from "zod";

// `GET /inbox` and `POST /inbox/:id/answer` (§12.1): the human requests agents open with human_ask
// (§11.1), open first, each with its ticket and session. An answer is final: a second one is 409.

const count = z.int().nonnegative();
const epochMs = z.int().nonnegative();
const nullableText = z.string().nullable();

export const INBOX_PAGE_DEFAULT_LIMIT = 50;
export const INBOX_PAGE_MAX_LIMIT = 100;
/** The longest answer: ticket_get hands it to the asking session whole. */
export const INBOX_ANSWER_MAX_CHARS = 4_000;

/** `dismissed`: withdrawn by the operator as no longer relevant, with no answer. */
export const InboxStatus = z.enum(["open", "answered", "dismissed"]);
export type InboxStatus = z.infer<typeof InboxStatus>;

/**
 * `GET /inbox?status=open|answered&kind=&project=&ticket=&cursor=&limit=`. No status lists both, open
 * first. `kind` keeps one kind (`staff_approval`); `project` one project's requests: its ticket's
 * workspace, else its session's; `ticket` one ticket's, by its number.
 */
export const InboxQuery = z.object({
  status: InboxStatus.optional(),
  kind: z.string().min(1).max(64).optional(),
  project: z.string().min(1).max(64).optional(),
  ticket: z.coerce.number().pipe(z.int().positive()).optional(),
  /** Opaque: the previous page's `next_cursor`. Absent starts at the top. */
  cursor: z.string().min(1).max(256).optional(),
  limit: z.coerce
    .number()
    .pipe(z.int().min(1).max(INBOX_PAGE_MAX_LIMIT))
    .default(INBOX_PAGE_DEFAULT_LIMIT),
});
export type InboxQuery = z.infer<typeof InboxQuery>;

export const InboxTicket = z.object({
  id: z.string(),
  num: count,
  title: z.string(),
  status: z.string(),
});
export type InboxTicket = z.infer<typeof InboxTicket>;

export const InboxSession = z.object({
  id: z.string(),
  agent: z.string(),
  role: z.string(),
  state: z.string(),
});
export type InboxSession = z.infer<typeof InboxSession>;

export const InboxItem = z.object({
  id: z.string(),
  status: z.string(),
  kind: z.string(),
  question: z.string(),
  context_md: nullableText,
  /** The choices offered, as the asker stored them; null when none were. */
  options: z.json(),
  batch_id: nullableText,
  asked_at: epochMs,
  expires_at: epochMs.nullable(),
  answer: nullableText,
  answered_by: nullableText,
  answered_at: epochMs.nullable(),
  ticket: InboxTicket.nullable(),
  session: InboxSession.nullable(),
  /**
   * A staffing proposal's own fields (`proposal_json`): the agent it would staff, on
   * which runner, as what, for which hand-off. Null on every other kind.
   */
  proposal: StaffProposal.nullable(),
});
export type InboxItem = z.infer<typeof InboxItem>;

/** `GET /inbox`, and the `data` of every `inbox` WS frame (its open requests). */
export const InboxPage = z.object({
  items: z.array(InboxItem),
  /** Opaque, for `?cursor=`: resumes after this page's last row. Null on the last page. */
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});
export type InboxPage = z.infer<typeof InboxPage>;

/** `POST /inbox/:id/answer`. Surrounding whitespace is trimmed; an empty answer is 400. */
export const AnswerRequest = z.strictObject({
  answer: z.string().trim().min(1).max(INBOX_ANSWER_MAX_CHARS),
});
export type AnswerRequest = z.infer<typeof AnswerRequest>;
