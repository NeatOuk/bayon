import { isNonSource, type PlanPaths } from "../tickets/key.js";
import type { ReviewFinding } from "./findings.js";
import {
  GATE_FAILURE_DETAIL_MAX,
  GateEvidence,
  GateFailure,
  REVIEWER_SEARCH_MAX,
  type FindingsParse,
  type GateFailReason,
  type GateSubject,
  type QaEvidence,
  ReviewerSearch,
  type SeverityCounts,
  type SourceChanges,
  type StoredGateEvidence,
} from "./schemas.js";

// The gate engine's evidence (§10.3): assembled from what the supervisor
// observed, pure, so every field has one source. A reviewer with no observable exit status never
// gets a GateEvidence: it gets the reason alone (C1), and verdict() fails it.

/** POSIX signal numbers (fixed across platforms), for the shell's 128 + signo exit code (Q4). */
const SIGNO: Readonly<Record<string, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGSEGV: 11,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
};

/** A process's end as an executor observed it; either field may be missing. */
export interface ObservedExit {
  readonly code?: number | null;
  readonly signal?: string | null;
}

/**
 * The exit code evidence records: the code, else 128 + the signal's number. Null when neither was
 * observed (or the signal is not a POSIX one): then there is no evidence, only a GateFailure.
 */
export function exitCodeOf(exit: ObservedExit): number | null {
  if (typeof exit.code === "number" && Number.isInteger(exit.code)) {
    return exit.code;
  }
  const signo =
    typeof exit.signal === "string" && Object.hasOwn(SIGNO, exit.signal)
      ? SIGNO[exit.signal]
      : undefined;
  return signo === undefined ? null : 128 + signo;
}

/** plan_review's source changes (amendment i): paths outside laws.plan_paths, capped. */
export const SOURCE_CHANGE_PATHS_MAX = 20;

export function sourceChangesOf(
  paths: readonly string[],
  planPaths: PlanPaths,
): SourceChanges {
  const source = paths.filter((path) => !isNonSource(path, planPaths));
  return {
    paths: source.slice(0, SOURCE_CHANGE_PATHS_MAX),
    total: source.length,
  };
}

/** Findings per severity, every severity present. */
export function bySeverity(findings: readonly ReviewFinding[]): SeverityCounts {
  const counts = { blocker: 0, major: 0, minor: 0, nit: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

export interface EvidenceFacts {
  readonly kind: string;
  readonly exit: ObservedExit;
  readonly run: {
    readonly id: string;
    readonly started_at: number;
    readonly ended_at: number | null;
  };
  readonly session: {
    readonly id: string;
    readonly runner_id: string;
    readonly executor_id: string;
    readonly model: string | null;
  };
  readonly runnerVersion: string | null;
  readonly costUsd: number;
  readonly artifactPaths: readonly string[];
  readonly subject: GateSubject;
  readonly findings: readonly ReviewFinding[];
  readonly parse: FindingsParse;
  readonly flags: GateEvidence["flags"];
  readonly sourceChanges?: SourceChanges;
  /**
   * The command evidence records, when the gate ran one of its own: a `qa_harness`
   * gate's §10.3 `command` is the project's harness command, not the generic "kind base..head by
   * runner" line, because that is the command an operator reading the evidence needs to see.
   */
  readonly commandLine?: string;
  /** A `qa_harness` gate's run, in structure (§10.4). */
  readonly qa?: QaEvidence;
  /** The engine's own reason: timeout, or reviewer_error. verdict() finds the others. */
  readonly reason?: GateFailReason;
}

export interface FailureFacts {
  readonly reason: GateFailReason;
  readonly detail?: string;
  readonly considered?: ReviewerSearch;
  readonly drift?: GateFailure["drift"];
}

const capDetail = (text: string): string =>
  text.length <= GATE_FAILURE_DETAIL_MAX
    ? text
    : `${text.slice(0, GATE_FAILURE_DETAIL_MAX - 1)}…`;

/** A URL's userinfo (`https://user:token@host`, `ssh://git@host`): where a git error can echo a credential. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi;

/** A detail as a gate row, served over REST, may keep it: no URL userinfo (Invariant 11), trimmed, cut to fit. */
const rowDetail = (text: string): string =>
  capDetail(text.replace(URL_USERINFO, "$1***@").trim());

const DriftSchema = GateFailure.shape.drift.unwrap();

/**
 * The GateFailure a gate that failed before a review stores: the detail masked and cut
 * to fit, the considered runners capped. Each structured part that still does not parse (a pin that
 * is no full object id) is dropped on its own; the reason and the detail are never lost.
 */
export function gateFailure(f: FailureFacts): GateFailure {
  const detail = rowDetail(f.detail ?? "");
  const considered =
    f.considered === undefined
      ? undefined
      : ReviewerSearch.safeParse({
          ...f.considered,
          runners: f.considered.runners.slice(0, REVIEWER_SEARCH_MAX),
        });
  const drift =
    f.drift === undefined ? undefined : DriftSchema.safeParse(f.drift);
  return {
    reason: f.reason,
    ...(detail === "" ? {} : { detail }),
    ...(considered?.success === true ? { considered: considered.data } : {}),
    ...(drift?.success === true ? { drift: drift.data } : {}),
  };
}

/** GateEvidence from the observed facts, or GateFailure when no exit status was observed (C1). */
export function assembleEvidence(f: EvidenceFacts): StoredGateEvidence {
  const exitCode = exitCodeOf(f.exit);
  if (exitCode === null) {
    const failure: GateFailure = { reason: f.reason ?? "reviewer_error" };
    return failure;
  }
  const { base_sha, head_sha } = f.subject;
  const counts = bySeverity(f.findings);
  return GateEvidence.parse({
    command:
      f.commandLine ??
      `${f.kind} ${base_sha}..${head_sha} by ${f.session.runner_id}@${f.session.executor_id} session ${f.session.id}`,
    exit_code: exitCode,
    duration_ms: Math.max(
      0,
      (f.run.ended_at ?? f.run.started_at) - f.run.started_at,
    ),
    cost_usd: Math.max(0, f.costUsd),
    artifact_paths: [...f.artifactPaths],
    run_id: f.run.id,
    session_id: f.session.id,
    runner_id: f.session.runner_id,
    runner_version: f.runnerVersion,
    executor_id: f.session.executor_id,
    model: f.session.model,
    subject: f.subject,
    findings: { total: f.findings.length, by_severity: counts, parse: f.parse },
    flags: f.flags,
    ...(f.sourceChanges === undefined
      ? {}
      : { source_changes: f.sourceChanges }),
    ...(f.qa === undefined ? {} : { qa: f.qa }),
    ...(f.reason === undefined ? {} : { reason: f.reason }),
  });
}
