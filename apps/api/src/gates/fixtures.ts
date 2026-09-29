import type {
  FindingSeverity,
  FindingStatus,
  GateEvidence,
  GateKind,
  GateState,
} from "@bayon/core";

// Gate test support for the API: evidence, and gate and finding rows for seedRows. The
// sessions and runs holding the tickets come from @bayon/db/testing's seedHolders (only tests
// import the test helpers). Test support only: excluded from coverage (vitest.config.ts).

/** The gates columns the API tests seed. */
export interface GateSeed {
  readonly id: string;
  readonly ticket_id: string;
  readonly kind: GateKind;
  readonly state: GateState;
  readonly attempt: number;
  readonly subject_kind: string;
  readonly subject_ref: string;
  readonly started_at: number | null;
  readonly repo_id?: string | null;
  readonly evidence_json?: string | null;
  readonly decided_at?: number | null;
  readonly waived_by?: string | null;
  readonly waive_reason?: string | null;
}

/** The findings columns the API tests seed. */
export interface FindingSeed {
  readonly id: string;
  readonly gate_id: string;
  readonly severity: FindingSeverity;
  readonly summary: string;
  readonly created_at: number;
  readonly status?: FindingStatus;
}

/** A full §10.3 evidence (core's GateEvidence). */
export const EVIDENCE: GateEvidence = {
  command: "review --json",
  exit_code: 0,
  duration_ms: 1_200,
  cost_usd: 0.4,
  artifact_paths: ["gates/g/review.json"],
  run_id: "R-review",
  session_id: "S-review",
  runner_id: "fixture",
  runner_version: "1.0.0",
  executor_id: "local",
  model: null,
  subject: {
    repo_id: null,
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    files: 2,
  },
  findings: {
    total: 0,
    by_severity: { blocker: 0, major: 0, minor: 0, nit: 0 },
    parse: "schema",
  },
  flags: {},
};

export const gate = (
  id: string,
  ticketNum: number,
  o: Partial<GateSeed> = {},
): GateSeed => ({
  id,
  ticket_id: `ticket-${ticketNum}`,
  kind: "code_review",
  state: "running",
  attempt: 1,
  subject_kind: "diff",
  subject_ref: "unpinned",
  started_at: 1,
  ...o,
});

/** A decided gate that passed with full evidence. */
export const passed = (
  id: string,
  ticketNum: number,
  o: Partial<GateSeed> = {},
): GateSeed =>
  gate(id, ticketNum, {
    state: "passed",
    evidence_json: JSON.stringify(EVIDENCE),
    decided_at: 2,
    ...o,
  });

export const finding = (
  id: string,
  gateId: string,
  o: Partial<FindingSeed> = {},
): FindingSeed => ({
  id,
  gate_id: gateId,
  severity: "major",
  summary: `finding ${id}`,
  created_at: 1,
  ...o,
});
