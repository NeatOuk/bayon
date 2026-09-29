import { z } from "zod";
import type { FrmError } from "../errors.js";
import { RefusalReason, type TicketStatus } from "./statuses.js";
import type { Refusal } from "./types.js";

// A refusal as the writer and the API carry it: an FrmError of class law_refused whose cause is
// the rule, the reason and the detail (422 at the REST boundary).

export const LawRefusalCause = z.object({
  rule: z.string().min(1),
  reason: RefusalReason,
  detail: z.string(),
});
export type LawRefusalCause = z.infer<typeof LawRefusalCause>;

/** The refusal for a (from, to) pair with no row in the table. */
export const noEdge = (from: TicketStatus, to: TicketStatus): Refusal => ({
  allowed: false,
  rule: "no_edge",
  reason: "illegal_transition",
  detail: `${from} → ${to} is not a transition`,
});

export const lawRefused = (r: Refusal): FrmError => ({
  class: "law_refused",
  message: `${r.rule}: ${r.detail}`,
  retryable: false,
  cause: { rule: r.rule, reason: r.reason, detail: r.detail },
});
