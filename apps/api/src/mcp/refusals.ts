// Tool results that are not data: a refusal carries a closed, machine-readable
// reason in structuredContent; a failure (bad arguments, a store error) is only an error text. The
// §3.2 laws refuse with finer reasons; one table maps them onto contract 4's set, and the
// law's own reason stays in the detail.
import type { RefusalReason as LawRefusalReason } from "@bayon/core";
import type { McpRefusalReason } from "@bayon/proto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface Refusal {
  readonly reason: McpRefusalReason;
  /** The law or rule that refused, when one did. */
  readonly rule?: string;
  readonly detail?: string;
  /** A stale compare-and-set: the version to retry with (contract 3). */
  readonly current_version?: number;
}

/** Every law reason onto contract 4's set. Exhaustive: a new law reason must be placed here. */
export const MCP_REASON_OF_LAW: Readonly<
  Record<LawRefusalReason, McpRefusalReason>
> = {
  illegal_transition: "illegal_transition",
  actor_not_allowed: "actor_not_allowed",
  cross_ticket_write: "cross_ticket_write",
  unresolved_findings: "unresolved_findings",
  missing_evidence: "missing_evidence",
  // Facts the transition needs and does not have.
  no_session: "missing_evidence",
  no_worktree: "missing_evidence",
  missing_artifact: "missing_evidence",
  source_changes: "missing_evidence",
  diff_unverifiable: "missing_evidence",
  facts_unavailable: "missing_evidence",
  facts_deferred: "missing_evidence",
  gate_not_passed: "missing_evidence",
  qa_not_passed: "missing_evidence",
  missing_note: "missing_evidence",
  // Not a move this ticket may make in its current shape.
  children_open: "illegal_transition",
  worktree_active: "illegal_transition",
  // The stale-review guard (M3): wait for the review, or ask the operator.
  gate_running: "illegal_transition",
  // Only a human's QA may do it.
  not_from_human_qa: "actor_not_allowed",
  // needs_human stays while a question is open: not a move the ticket may make now.
  questions_open: "illegal_transition",
  // merge_close's: the supervisor's alone, so an agent never meets it; a fact it lacks.
  prs_not_merged: "missing_evidence",
};

export function refusal(r: Refusal): CallToolResult {
  const rule = r.rule === undefined ? "" : ` (${r.rule})`;
  const detail = r.detail === undefined ? "" : `: ${r.detail}`;
  return {
    isError: true,
    content: [{ type: "text", text: `refused: ${r.reason}${rule}${detail}` }],
    structuredContent: {
      refused: true,
      reason: r.reason,
      ...(r.rule === undefined ? {} : { rule: r.rule }),
      ...(r.detail === undefined ? {} : { detail: r.detail }),
      ...(r.current_version === undefined
        ? {}
        : { current_version: r.current_version }),
    },
  };
}

export const failed = (message: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: message }],
});
