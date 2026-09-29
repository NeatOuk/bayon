import {
  ok,
  planGateEffects,
  resolveEdge,
  type GateEvidence,
  type TicketStatus,
} from "@bayon/core";
import type { Insertable } from "kysely";
import { internalsOf, type Db, type Internals } from "../connection.js";
import type { FindingsTable, GatesTable } from "../schema-work.js";
import type { PlanGates } from "./gate-writes.js";
import type { Decide } from "./ticket-transition.js";

// Shared by the gate writer tests: builders for gates, findings and evidence, the core
// plan an edge's gate effects take, and raw reads. Test support only: excluded from coverage. The
// database itself comes from @bayon/db/testing's gateDb (only tests import the test helpers).

export const NOW = Date.UTC(2026, 8, 13, 12);
export const allow: Decide = () => ok(undefined);

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

export const gateRow = (
  id: string,
  o: Partial<Insertable<GatesTable>> = {},
): Insertable<GatesTable> => ({
  id,
  ticket_id: "ticket-1",
  kind: "code_review",
  state: "running",
  attempt: 1,
  subject_kind: "diff",
  subject_ref: "unpinned",
  started_at: NOW - 1_000,
  ...o,
});

export const findingRow = (
  id: string,
  gate_id: string,
  o: Partial<Insertable<FindingsTable>> = {},
): Insertable<FindingsTable> => ({
  id,
  gate_id,
  severity: "major",
  summary: `finding ${id}`,
  created_at: NOW - 500,
  ...o,
});

/** The core plan for an edge's gate effects, as the API builds it. */
export const planFor =
  (from: TicketStatus, to: TicketStatus): PlanGates =>
  (facts) => {
    const edge = resolveEdge(from, to, null);
    if (edge === undefined) throw new Error(`no edge ${from} → ${to}`);
    return ok(
      planGateEffects({
        edge: edge.gates,
        ticket: {
          non_trivial: facts.ticket.non_trivial === 1,
          plan_path: facts.ticket.plan_path,
        },
        gates: facts.gates(),
        repos: facts.repos(),
        multiRepo: false,
        lintRepos: [],
        qaConfigured: false,
        qaCi: false,
      }),
    );
  };

function internals(db: Db): Internals {
  const ix = internalsOf(db);
  if (!ix.ok) throw new Error(ix.error.message);
  return ix.value;
}

/** Rows by raw SQL: tests only, to check what a writer left behind. */
export const rows = (db: Db, sql: string, ...params: unknown[]): unknown[] =>
  internals(db)
    .raw.prepare(sql)
    .all(...params);

export const exec = (db: Db, sql: string): void => {
  internals(db).raw.exec(sql);
};
