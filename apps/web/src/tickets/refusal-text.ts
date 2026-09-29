import { StaffRefusalReason, type RefusalReason } from "@bayon/core";
import { ApiRequestError } from "@/api/http";

// How a refused move reads: what happened and one thing to do, in plain words, for every
// reason the laws give. The rule, the reason code and the law's own detail stay the button's title,
// so an operator who wants them still has them; the note under the button is for everyone else.

/** Each refusal's sentence: exhaustive, so a new reason must be worded here before it ships. */
export const PLAIN_REFUSAL: Readonly<Record<RefusalReason, string>> = {
  illegal_transition: "This move isn't allowed from here.",
  actor_not_allowed: "Only an agent working the ticket can make this move.",
  cross_ticket_write: "A session can only move its own ticket.",
  no_session: "Nobody is working on it yet: start work first.",
  no_worktree: "Its session has no checkout yet: wait for it to start.",
  missing_artifact: "The plan file isn't there: set the plan path.",
  source_changes: "The plan changed source files: revert them first.",
  diff_unverifiable: "Its changes couldn't be checked: try again.",
  facts_unavailable: "What this move needs couldn't be read: try again.",
  facts_deferred: "Checked when you make the move.",
  gate_not_passed: "A review hasn't passed yet: wait for it.",
  unresolved_findings: "Blocking findings are still open: resolve them first.",
  missing_evidence: "A review has no evidence yet: run it first.",
  qa_not_passed: "QA hasn't passed yet: pass it first.",
  children_open: "Its child tickets are still open: close them first.",
  worktree_active: "It still holds a checkout: wait for its session to end.",
  not_from_human_qa: "Only a failed human QA sends it back here.",
  missing_note: "This move needs a note: add one.",
  gate_running: "A review is still running: wait for it.",
  questions_open: "It has open questions: answer them first.",
  prs_not_merged: "Its pull requests haven't all merged yet.",
};

/** Reasons whose law detail is plain already and says what to fix (a file list): kept after the sentence. */
const DETAIL_SHOWN: ReadonlySet<RefusalReason> = new Set(["source_changes"]);

export interface Refusal {
  readonly rule: string;
  readonly reason?: RefusalReason | undefined;
  readonly detail?: string | undefined;
}

/** A refusal as the operator reads it: the sentence; the rule's name stays in the button's title. */
export function plainRefusal({ reason, detail }: Refusal): string {
  if (reason === undefined) return "This move isn't allowed right now.";
  const sentence = PLAIN_REFUSAL[reason];
  return DETAIL_SHOWN.has(reason) && detail !== undefined
    ? `${sentence} ${detail}`
    : sentence;
}

/** The full refusal for the button's title: the rule, the reason code and the law's detail. */
export const technicalRefusal = ({ rule, reason, detail }: Refusal): string =>
  `${rule}${reason === undefined ? "" : ` (${reason})`}${detail === undefined ? "" : `: ${detail}`}`;

/**
 * A refusal of a staffing or a move, as the operator reads it. A move's 422 (law_refused) carries its
 * rule and reason; a staffing refusal's message is `<reason>: <detail>` (apps/api's
 * staffRefusalError), whose detail is written for a reader already, so it loses only its code. Any
 * other error reads as its message.
 */
export function plainError(error: Error): string {
  if (!(error instanceof ApiRequestError)) return error.message;
  const wire = error.error;
  if (wire.rule !== undefined)
    return plainRefusal({
      rule: wire.rule,
      reason: wire.reason,
      detail: wire.detail,
    });
  const colon = wire.message.indexOf(": ");
  const code = StaffRefusalReason.safeParse(wire.message.slice(0, colon));
  if (colon < 0 || !code.success) return wire.message;
  const detail = wire.message.slice(colon + 2);
  const sentence = `${detail.charAt(0).toUpperCase()}${detail.slice(1)}`;
  return sentence.endsWith(".") ? sentence : `${sentence}.`;
}
