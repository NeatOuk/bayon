import type { GateEvidence } from "@bayon/core";
import {
  GateSummary,
  type GateTicket,
  type GateView,
  type GatesPage,
} from "@bayon/proto";
import { gateView } from "@/test/ticket-fixtures";

// Wire-shaped gate data (DTOs): every value here passes its proto schema.

/** A full §10.3 evidence (core's GateEvidence), as a decided gate keeps it. */
export const evidence = (o: Partial<GateEvidence> = {}): GateEvidence => ({
  command: "review --json",
  exit_code: 0,
  duration_ms: 1_200,
  cost_usd: 0.4,
  artifact_paths: ["gates/g/review.json"],
  run_id: "R-review",
  session_id: "S-review",
  runner_id: "reviewer-b",
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
  ...o,
});

export const gateTicket = (
  num = 812,
  o: Partial<GateTicket> = {},
): GateTicket => ({
  id: `ticket-${num}`,
  num,
  key: `FRM-${num}`,
  title: `ticket ${num}`,
  status: "code_review",
  ...o,
});

/** One row of GET /gates: a gate without its findings, and its ticket. */
export const gateSummary = (
  gate: Partial<GateView> & Pick<GateView, "kind">,
  ticket: GateTicket = gateTicket(),
): GateSummary =>
  GateSummary.parse({
    ...gateView({ state: "running", started_at: 1_800_000_000_000, ...gate }),
    ticket,
  });

export const gatesPage = (
  items: readonly GateSummary[],
  nextCursor: string | null = null,
): GatesPage => ({
  items: [...items],
  next_cursor: nextCursor,
  has_more: nextCursor !== null,
});
