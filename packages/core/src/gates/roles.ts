import { z } from "zod";
import type { GateKind, TicketStatus } from "../laws/statuses.js";

// Role names and the gate kinds a round reviews (§9.8, §10.3). Roles are names, not runners: the
// runner of each is a role_bindings row (Invariant 1).

/** `role_bindings.role` (003's list). */
export const BindingRole = z.enum([
  "orchestrator",
  "builder",
  "plan_reviewer",
  "code_reviewer",
  "investigator",
  "qa",
  "util",
]);
export type BindingRole = z.infer<typeof BindingRole>;

/** The gate kinds an LLM reviewer reviews (M3: no qa or human_qa gates, amendment d). */
export const REVIEW_GATE_KINDS = [
  "plan_review",
  "code_review",
  "ce_review",
] as const satisfies readonly GateKind[];
export type ReviewGateKind = (typeof REVIEW_GATE_KINDS)[number];

export const isReviewGateKind = (kind: string): kind is ReviewGateKind =>
  (REVIEW_GATE_KINDS as readonly string[]).includes(kind);

/**
 * The gate kinds an edge opens a round of, and so the ones a round may reopen: the reviewed kinds,
 * the two script-job gates `parity_check` and `lint_check` that `REVIEW_ROUND`
 * opens beside them, and `qa_harness`, which `pass_review` opens as the ticket enters
 * `qa_harness`.
 *
 * This, not `isReviewGateKind`, decides whether a gate is retried after a timeout or a supervisor
 * restart (`planRetry`) and whether `POST /gates/:id/run` may open its next attempt (`rerunGate`).
 * A `parity_check` left permanently `failed` by a restart has no way back but an operator waive or
 * a fresh round that throws away the passed `code_review` evidence with it — and being run by a
 * script rather than by a reviewer is no reason for that. The same holds for a QA harness.
 *
 * It is **not** `ROUND_KINDS` (laws/table.ts), which is the *code review* round's own list: the one
 * `request_fix` and `resubmit` supersede and `pass_review` requires. `qa_harness` is decided a
 * status later and belongs to neither.
 */
export const ROUND_GATE_KINDS = [
  ...REVIEW_GATE_KINDS,
  "parity_check",
  "lint_check",
  "qa_harness",
] as const satisfies readonly GateKind[];
export type RoundGateKind = (typeof ROUND_GATE_KINDS)[number];

export const isRoundGateKind = (kind: string): kind is RoundGateKind =>
  (ROUND_GATE_KINDS as readonly string[]).includes(kind);

/** The ticket status a gate of each kind is decided in: a rerun or retry needs the ticket there. */
export const GATE_REVIEW_STATUS: Readonly<Record<RoundGateKind, TicketStatus>> =
  {
    plan_review: "plan_review",
    code_review: "code_review",
    ce_review: "code_review",
    // The code review round opens it (REVIEW_ROUND), so it is decided in that same status.
    parity_check: "code_review",
    lint_check: "code_review",
    // `pass_review` opens it as the ticket arrives, so it is decided where it was opened.
    qa_harness: "qa_harness",
  };
