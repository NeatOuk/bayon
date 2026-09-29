import { z } from "zod";
import {
  StoredGateEvidence,
  type CiGateEvidence,
  type FindingSeverity,
  type FindingStatus,
  type GateEvidence,
  type GateFailReason,
} from "./schemas.js";
import type { GateSettings } from "./settings.js";

// A running gate's decision (§10.3, M3 contracts): passed only with schema-valid evidence and no
// open finding at a blocking severity; otherwise failed, with a reason. Waiving is not a verdict:
// it is the operator's, with a reason, through the API.

export type Verdict =
  | {
      readonly state: "passed";
      readonly evidence: GateEvidence | CiGateEvidence;
    }
  | {
      readonly state: "failed";
      readonly reason: GateFailReason;
      readonly detail: string;
    };

export interface VerdictFinding {
  readonly severity: FindingSeverity;
  readonly status: FindingStatus;
}

export interface VerdictInput {
  /** What the gate would store in `gates.evidence_json`. */
  readonly evidence: unknown;
  /** The gate's findings as they stand; freshly parsed ones are open. */
  readonly findings: readonly VerdictFinding[];
  readonly settings: Pick<GateSettings, "blocking_severities" | "base_drift">;
}

const failed = (reason: GateFailReason, detail: string): Verdict => ({
  state: "failed",
  reason,
  detail,
});

/** The open findings at a blocking severity. */
const blockingOf = (i: VerdictInput): readonly VerdictFinding[] =>
  i.findings.filter(
    (f) =>
      f.status === "open" &&
      i.settings.blocking_severities.includes(f.severity),
  );

const blockingFailure = (count: number, i: VerdictInput): Verdict =>
  failed(
    "blocking_findings",
    `${count} open finding(s) at ${i.settings.blocking_severities.join(", ")}`,
  );

/**
 * A `ci` gate's evidence: a failed check is a blocking finding, so findings decide
 * first. An exit code of 1 with no finding naming what failed is not a pass and not the code's
 * failure either — nothing says what broke — so it is `reviewer_error`.
 */
function judgeCi(e: CiGateEvidence, i: VerdictInput): Verdict {
  const blocking = blockingOf(i);
  if (blocking.length > 0) return blockingFailure(blocking.length, i);
  if (e.exit_code !== 0) {
    return failed(
      "reviewer_error",
      `the CI evidence records exit ${e.exit_code} and no finding names a failed check`,
    );
  }
  return { state: "passed", evidence: e };
}

/** Checked in order; the first that fails decides. */
export function verdict(i: VerdictInput): Verdict {
  const parsed = StoredGateEvidence.safeParse(i.evidence);
  if (!parsed.success) {
    return failed("missing_evidence", z.prettifyError(parsed.error));
  }
  const e = parsed.data;
  if (!("command" in e)) {
    return failed(
      e.reason,
      e.detail ?? "the gate failed before it had evidence",
    );
  }
  if (e.reason !== undefined) {
    return failed(e.reason, "the evidence records a failure");
  }
  if ("ci" in e) return judgeCi(e, i);
  // The reviewer's observed exit status (C1): a reviewer killed after a clean
  // terminal (137) or cut off by a dropped link never passes on the findings it happened to leave.
  if (e.exit_code !== 0) {
    return failed(
      "reviewer_error",
      `the reviewer process exited ${e.exit_code}`,
    );
  }
  if (e.source_changes !== undefined && e.source_changes.total > 0) {
    const { paths, total } = e.source_changes;
    return failed(
      "source_changes",
      `${total} source file(s) changed: ${paths.join(", ")}`,
    );
  }
  if (e.flags.base_drift === true && i.settings.base_drift === "fail") {
    return failed("base_drift", "the base moved while the review ran");
  }
  const blocking = blockingOf(i);
  if (blocking.length > 0) return blockingFailure(blocking.length, i);
  return { state: "passed", evidence: e };
}
