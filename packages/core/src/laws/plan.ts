import { noEdge } from "./refusal.js";
import type { ActorKind, TicketStatus } from "./statuses.js";
import { resolveEdge, type EdgeAdvance, type EdgeGates } from "./table.js";
import type { LawTicket, Refusal, TransitionInput } from "./types.js";

// Built before the write transaction from a pre-read ticket: which facts to gather outside it,
// and the writer's patch (the edge's effects) and payload (evidence refs). Safe because the
// writer checks the version before deciding, and every transition bumps it.

/** Facts that need I/O outside the transaction: the plan file, the git diff. */
export type PreFact = "plan" | "diff";

export function requiredFacts(
  from: TicketStatus,
  to: TicketStatus,
  prior: TicketStatus | null,
): ReadonlySet<PreFact> {
  const requires = resolveEdge(from, to, prior)?.requires ?? [];
  return new Set(
    requires.flatMap((r): PreFact[] => {
      if (r.kind === "artifact") return ["plan"];
      return r.kind === "predicate" && r.name === "no_source_changes"
        ? ["diff"]
        : [];
    }),
  );
}

export interface WorktreeEvidence {
  readonly id: string;
  readonly base_sha: string;
  readonly files: number;
  /** At most 20, never git's whole output (Invariant 9). */
  readonly paths: readonly string[];
}

export interface EvidenceRefs {
  readonly plan_path?: string;
  readonly worktrees?: readonly WorktreeEvidence[];
}

/** Ticket columns that move with the status. */
export interface TicketEffects {
  readonly needs_human?: 1;
  readonly blocked_reason?: string | null;
  readonly unblock_condition?: string | null;
  readonly closed_at?: number;
}

export interface TransitionPayload {
  readonly rule: string;
  readonly evidence?: EvidenceRefs;
  readonly override_note?: string;
}

export interface TransitionPlan {
  readonly rule: string;
  readonly to: TicketStatus;
  readonly patch: TicketEffects;
  readonly payload: TransitionPayload;
  /** The edge's gate effects: rounds it opens, running gates it supersedes (M3). */
  readonly gates: EdgeGates;
  /** Where it lands instead when the review it would open is not required. */
  readonly advance?: EdgeAdvance;
}

export interface PlanInput {
  readonly ticket: LawTicket;
  readonly priorStatus: TicketStatus | null;
  readonly to: TicketStatus;
  readonly input: TransitionInput;
  readonly now: number;
  readonly evidence?: EvidenceRefs;
  /**
   * Who moves it: picks between rows that share a pair (`merge_close` beside `pass_human_qa`,
   *). Absent resolves the pair's first row, which is every caller's before that.
   */
  readonly actor?: ActorKind;
}

export function planTransition(p: PlanInput): TransitionPlan | Refusal {
  const edge = resolveEdge(p.ticket.status, p.to, p.priorStatus, p.actor);
  if (edge === undefined) return noEdge(p.ticket.status, p.to);
  const fx = edge.effects;
  const blocked = {
    blocked_reason: (p.input.blocked_reason ?? "").trim(),
    unblock_condition: (p.input.unblock_condition ?? "").trim(),
  };
  if (
    fx.setBlocked &&
    (blocked.blocked_reason === "" || blocked.unblock_condition === "")
  ) {
    return {
      allowed: false,
      rule: edge.rule,
      reason: "missing_note",
      detail: "blocking needs blocked_reason and unblock_condition",
    };
  }
  const patch: TicketEffects = {
    ...(fx.needsHuman ? { needs_human: 1 as const } : {}),
    ...(fx.setBlocked ? blocked : {}),
    ...(fx.clearBlocked
      ? { blocked_reason: null, unblock_condition: null }
      : {}),
    ...(fx.close ? { closed_at: p.now } : {}),
  };
  const note = (p.input.override_note ?? "").trim();
  const payload: TransitionPayload = {
    rule: edge.rule,
    ...(p.evidence === undefined ? {} : { evidence: p.evidence }),
    ...(note === "" ? {} : { override_note: note }),
  };
  return {
    rule: edge.rule,
    to: p.to,
    patch,
    payload,
    gates: edge.gates,
    ...(edge.advance === undefined ? {} : { advance: edge.advance }),
  };
}
