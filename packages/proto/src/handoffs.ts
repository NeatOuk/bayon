import { z } from "zod";
import { HandoffReason } from "./commands.js";
import { HandoffView, TicketRef } from "./tickets.js";

// Hand-offs over REST (§12.1): GET /handoffs?ticket=&pending=1, GET /handoffs/:id, and the
// operator's POST /sessions/:id/handoff. The supervisor writes a hand-off's facts, the API its
// judgement and its accept through /mcp; these routes read, and insert the
// command.

const nullableText = z.string().nullable();

export const HANDOFFS_PAGE_DEFAULT_LIMIT = 100;
export const HANDOFFS_PAGE_MAX_LIMIT = 500;

/** `GET /handoffs?ticket=&pending=1&limit=`: oldest first; `pending=1` keeps the takeable ones. */
export const HandoffsQuery = z.object({
  ticket: TicketRef.optional(),
  pending: z
    .enum(["0", "1"])
    .transform((flag) => flag === "1")
    .optional(),
  limit: z.coerce
    .number()
    .pipe(z.int().min(1).max(HANDOFFS_PAGE_MAX_LIMIT))
    .default(HANDOFFS_PAGE_DEFAULT_LIMIT),
});
export type HandoffsQuery = z.infer<typeof HandoffsQuery>;

/** One hand-off in a list: its chain entry, its ticket and its packet file. */
export const HandoffSummary = HandoffView.extend({
  ticket_id: z.string(),
  packet_path: z.string(),
});
export type HandoffSummary = z.infer<typeof HandoffSummary>;

export const HandoffsPage = z.object({
  items: z.array(HandoffSummary),
  has_more: z.boolean(),
});
export type HandoffsPage = z.infer<typeof HandoffsPage>;

/** `GET /handoffs/:id`: the whole row, its facts (facts_json, parsed) and its judgement. */
export const HandoffDetail = HandoffSummary.extend({
  phase_from: nullableText,
  phase_to: nullableText,
  packet_hash: z.string(),
  tokens_est: z.int().nonnegative().nullable(),
  decisions_md: nullableText,
  traps_md: nullableText,
  next_steps_md: nullableText,
  open_questions_md: nullableText,
  pointers: z.array(z.string()),
  facts: z.unknown(),
});
export type HandoffDetail = z.infer<typeof HandoffDetail>;

/**
 * `POST /sessions/:id/handoff` (§7.1): the operator hands a session off now. No body means
 * `operator`; a death, an agent's own request and a stale holder's release are the supervisor's,
 * the agent's and staffing's to report.
 */
export const SessionHandoffRequest = z
  .strictObject({
    reason: HandoffReason.exclude([
      "session_death",
      "agent_request",
      "stale_session",
    ]).default("operator"),
    note: z.string().min(1).max(500).optional(),
  })
  .prefault({});
export type SessionHandoffRequest = z.infer<typeof SessionHandoffRequest>;
