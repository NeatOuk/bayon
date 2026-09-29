import {
  TicketStatus,
  err,
  ok,
  type GateFact,
  type GateFacts,
  type GateSettings,
  type Known,
  type LawFacts,
  type LawTicket,
  type Result,
  type SessionFact,
} from "@bayon/core";
import type { SessionRow, TicketRow } from "../schema.js";
import type { GateRow } from "../schema-work.js";
import { ENDED_STATES } from "./sessions.js";
import type { OpenFinding, TicketFactsSnapshot } from "./ticket-facts.js";

// DB rows as the laws read them: pure mappers, no SQL. The API's transitions and the supervisor's
// blockTicket and advanceTicket share them, so all build the same LawInput (design,
// LOW-5). M3: gate facts are the ticket's gates, every attempt, with their
// open findings and the blocking severities. M7.5 replaces M3 amendment d's permanently
// unavailable QA fact with the real one: the ticket's newest `qa_runs` row, which a `qa_harness`
// gate's decision writes. A project that runs no harness has none, and `pass_harness` is then the
// operator's override with a note, exactly as it was.

/** `evidence_json`, parsed; null when absent or not JSON (the law then sees no evidence). */
function evidenceOf(json: string | null): unknown {
  if (json === null) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null; // unreadable evidence counts as none: the law refuses missing_evidence
  }
}

const gateFact = (g: GateRow, open: readonly OpenFinding[]): GateFact => ({
  id: g.id,
  kind: g.kind,
  repoId: g.repo_id,
  attempt: g.attempt,
  round: g.round,
  state: g.state,
  evidence: evidenceOf(g.evidence_json),
  waiveReason: g.waive_reason,
  openSeverities: open.filter((f) => f.gate_id === g.id).map((f) => f.severity),
  subjectKind: g.subject_kind,
});

/**
 * Whether `when: "multi_repo"` holds for this ticket: its workspace has more than one
 * repo **and** the operator has turned `gates.parity_check` on (020 seeds it off). One place, used
 * for both the round that opens the gate and the edge that requires it, so the two cannot disagree.
 * A ticket with no workspace is not multi-repo: there is nothing to check parity between.
 */
export const isMultiRepo = (
  workspaceKind: string | null,
  settings: GateSettings,
): boolean =>
  settings.parity_check && workspaceKind !== null && workspaceKind !== "single";

/**
 * The repos a `lint_check` opens for: the ticket's repos that declare a
 * `repos.lint_cmd`, but only while the operator has `gates.lint_check` on (024 seeds it off). One
 * place, used for both the round that opens the gate and the edge that requires it, so the two
 * cannot disagree — and the switch stays safe to flip, since a fleet that has configured no lint
 * command has an empty list either way.
 *
 * Empty is exactly `when: "lint_configured"` not holding; `[null]` is the repo-less gate a ticket
 * with no `ticket_repos` opens.
 */
export const lintGateRepos = (
  lintRepos: readonly (string | null)[],
  settings: GateSettings,
): readonly (string | null)[] => (settings.lint_check ? lintRepos : []);

/** The gate laws' facts: every attempt of every gate, the ticket's repos, the blocking severities. */
export function gateFacts(
  s: TicketFactsSnapshot,
  settings: Result<GateSettings>,
): Known<GateFacts> {
  if (!settings.ok) {
    return { state: "unavailable", detail: settings.error.message };
  }
  return {
    state: "known",
    value: {
      gates: s.gates.map((g) => gateFact(g, s.openFindings)),
      repos: s.repos,
      blockingSeverities: settings.value.blocking_severities,
      multiRepo: isMultiRepo(s.workspaceKind, settings.value),
      lintRepos: lintGateRepos(s.lintRepos, settings.value),
      qaConfigured: s.qaConfigured,
      driftRoundsMax: settings.value.drift_rounds_max,
    },
  };
}

const ENDED = new Set<string>(ENDED_STATES);

export const sessionFact = (s: SessionRow): SessionFact => ({
  id: s.id,
  ticketId: s.ticket_id,
  live: !ENDED.has(s.state),
});

/** A stored status, or null if it is not one of §3.2's. */
export const parseStatus = (status: string | null): TicketStatus | null => {
  const parsed = TicketStatus.safeParse(status);
  return parsed.success ? parsed.data : null;
};

export function lawTicket(row: TicketRow): Result<LawTicket> {
  const status = parseStatus(row.status);
  if (status === null) {
    return err({
      class: "internal",
      message: `ticket ${row.id} has an unknown status: ${row.status}`,
      retryable: false,
    });
  }
  return ok({
    id: row.id,
    status,
    non_trivial: row.non_trivial === 1,
    plan_path: row.plan_path,
  });
}

/** The laws' view of a snapshot, with its gate facts already taken. */
export const lawFactsWith = (
  s: TicketFactsSnapshot,
  gates: Known<GateFacts>,
): LawFacts => ({
  actorSession: s.actorSession === null ? null : sessionFact(s.actorSession),
  ticketSessions: s.ticketSessions.map(sessionFact),
  worktrees: s.worktrees.map((w) => ({
    id: w.id,
    sessionId: w.session_id,
    active: w.state === "active",
  })),
  children: s.children.map((c) => ({ id: c.id, status: c.status })),
  priorStatus: parseStatus(s.priorStatus),
  gates,
  qa: { state: "known", value: { latest: s.qaLatest } },
  merge: s.merge,
});

/** The laws' view of a snapshot (plan and diff come from git-facts, when an edge needs them). */
export const lawFacts = (
  s: TicketFactsSnapshot,
  settings: Result<GateSettings>,
): LawFacts => lawFactsWith(s, gateFacts(s, settings));
