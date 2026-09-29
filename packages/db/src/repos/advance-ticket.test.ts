import type { ReviewFinding } from "@bayon/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { OPERATOR, gateDb, seedRows, unwrap } from "../testing.js";
import { advanceTicket } from "./advance-ticket.js";
import {
  EVIDENCE,
  allow,
  exec,
  findingRow,
  gateRow,
  planFor,
  rows,
} from "./fixtures.js";
import { decideGate } from "./gate-decide.js";
import { rerunGate } from "./gate-writes.js";
import { transitionTicket } from "./ticket-transition.js";
import { getTicket } from "./tickets.js";

// advanceTicket: after a gate decides, the one machine step its stored facts settle,
// taken as the supervisor through core's laws inside decideGate's own transaction, on a real temp
// SQLite file. Anything else — a gate still running, a failure that did not judge the code, a
// ticket already moved on — writes nothing.

let t: Awaited<ReturnType<typeof gateDb>>;
beforeEach(async () => {
  // ticket-1 code_review, ticket-2 plan_review, ticket-3 and ticket-4 qa_harness; all trivial.
  t = await gateDb(["code_review", "plan_review", "qa_harness", "qa_harness"]);
});
afterEach(() => t.cleanup());

const MAJOR: ReviewFinding = {
  severity: "major",
  summary: "the null check is gone",
  file: "src/a.ts",
  line: 3,
  category: null,
  detail_md: null,
};
const BLOCKER: ReviewFinding = { ...MAJOR, severity: "blocker" };

type GateSeed = Parameters<typeof gateRow>[1];

const open = async (id: string, o: GateSeed = {}) =>
  unwrap(await seedRows(t.db, { gates: [gateRow(id, o)] }));

const decide = (
  gate_id: string,
  o: { evidence?: unknown; findings?: readonly ReviewFinding[] } = {},
) =>
  decideGate(t.db, {
    gate_id,
    session_id: null,
    evidence: o.evidence ?? EVIDENCE,
    findings: o.findings ?? [],
  });

const ticketOf = (id: string) =>
  rows(t.db, "SELECT status, version FROM tickets WHERE id = ?", id)[0];

const transitions = (id: string) =>
  (
    rows(
      t.db,
      "SELECT actor_kind, actor_id, from_status, to_status, payload_json FROM ticket_events WHERE ticket_id = ? AND kind = 'transition' ORDER BY id",
      id,
    ) as { payload_json: string }[]
  ).map((e) => ({ ...e, payload_json: JSON.parse(e.payload_json) as unknown }));

const audits = (id: string) =>
  (
    rows(
      t.db,
      "SELECT actor, action, payload_json FROM audit_log WHERE target_id = ? AND action = 'supervisor.advance_ticket' ORDER BY id",
      id,
    ) as { payload_json: string }[]
  ).map((a) => ({ ...a, payload_json: JSON.parse(a.payload_json) as unknown }));

const nonTrivial = (id: string) =>
  exec(t.db, `UPDATE tickets SET non_trivial = 1 WHERE id = '${id}'`);

describe("a passed round", () => {
  test("a single-gate round moves the ticket to qa_harness with the decision, audited as the supervisor", async () => {
    await open("g1");
    const decided = unwrap(await decide("g1"));
    expect(decided.gate.state).toBe("passed");
    expect(decided.advance).toMatchObject({
      advanced: true,
      rule: "pass_review",
      from: "code_review",
      to: "qa_harness",
      ticket: { status: "qa_harness", version: 2 },
    });
    expect(ticketOf("ticket-1")).toEqual({ status: "qa_harness", version: 2 });
    expect(transitions("ticket-1")).toEqual([
      {
        actor_kind: "supervisor",
        actor_id: "gate_engine",
        from_status: "code_review",
        to_status: "qa_harness",
        payload_json: { rule: "pass_review", gate_id: "g1" },
      },
    ]);
    expect(audits("ticket-1")).toEqual([
      {
        actor: "supervisor",
        action: "supervisor.advance_ticket",
        payload_json: {
          from: "code_review",
          to: "qa_harness",
          rule: "pass_review",
          gate_id: "g1",
        },
      },
    ]);
    // The decision's gate event comes first, then the move it unlocked.
    const kinds = rows(
      t.db,
      "SELECT kind FROM ticket_events WHERE ticket_id = 'ticket-1' ORDER BY id",
    );
    expect(kinds).toEqual([{ kind: "gate" }, { kind: "transition" }]);
  });

  test("the decision and the move are one transaction: a refused move rolls the decision back", async () => {
    await open("g1");
    exec(
      t.db,
      `CREATE TRIGGER refuse_advance BEFORE UPDATE OF status ON tickets
       WHEN NEW.status = 'qa_harness' BEGIN SELECT RAISE(ABORT, 'refused'); END`,
    );
    try {
      const out = await decide("g1");
      expect(out.ok).toBe(false);
      expect(rows(t.db, "SELECT state FROM gates WHERE id = 'g1'")).toEqual([
        { state: "running" },
      ]);
      expect(
        rows(t.db, "SELECT id FROM ticket_events WHERE ticket_id = 'ticket-1'"),
      ).toEqual([]);
      expect(ticketOf("ticket-1")).toEqual({
        status: "code_review",
        version: 1,
      });
    } finally {
      exec(t.db, "DROP TRIGGER refuse_advance");
    }
  });

  test("with ce_review also required, nothing moves until the last gate passes", async () => {
    nonTrivial("ticket-1");
    await open("g1");
    await open("g2", { kind: "ce_review" });
    const first = unwrap(await decide("g1"));
    expect(first.advance).toEqual({
      advanced: false,
      status: "code_review",
      rule: null,
      why: "ce_review still running",
    });
    expect(ticketOf("ticket-1")).toEqual({ status: "code_review", version: 1 });
    expect(audits("ticket-1")).toEqual([]);
    const last = unwrap(await decide("g2"));
    expect(last.advance).toMatchObject({ advanced: true, rule: "pass_review" });
    expect(ticketOf("ticket-1")).toEqual({ status: "qa_harness", version: 2 });
  });

  test("with lint_check also required, nothing moves until it passes too", async () => {
    unwrap(
      await seedRows(t.db, {
        settings: [
          { key: "gates.lint_check", value_json: "true", updated_at: 0 },
        ],
        repos: [
          { id: "r", name: "r", mirror_path: "/m/r", lint_cmd: "pnpm lint" },
        ],
        workspaces: [{ id: "ws", name: "ws", kind: "single" }],
        workspace_repos: [
          { workspace_id: "ws", repo_id: "r", rel_path: ".", role: "primary" },
        ],
      }),
    );
    exec(t.db, "UPDATE tickets SET workspace_id = 'ws' WHERE id = 'ticket-1'");
    await open("g1");
    await open("g3", { kind: "lint_check" });
    expect(unwrap(await decide("g1")).advance).toMatchObject({
      advanced: false,
      why: "lint_check still running",
    });
    expect(unwrap(await decide("g3")).advance).toMatchObject({
      advanced: true,
      rule: "pass_review",
      to: "qa_harness",
    });
  });
});

describe("a failed round", () => {
  test("no_reviewer and reviewer_error move nothing, even carrying a blocker finding; each stays on the attention list", async () => {
    const infra = [
      {
        reason: "no_reviewer",
        evidence: { reason: "no_reviewer", detail: "no gate-eligible runner" },
      },
      {
        reason: "reviewer_error",
        evidence: { ...EVIDENCE, exit_code: 137 },
      },
    ] as const;
    for (const [i, c] of infra.entries()) {
      const id = `g-${c.reason}`;
      await open(id, { attempt: i + 1 });
      const decided = unwrap(
        await decide(id, { evidence: c.evidence, findings: [BLOCKER] }),
      );
      expect(decided.gate.state, c.reason).toBe("failed");
      expect(
        JSON.parse(String(decided.gate.evidence_json)),
        c.reason,
      ).toMatchObject({ reason: c.reason });
      expect(decided.advance, c.reason).toMatchObject({
        advanced: false,
        rule: null,
      });
      expect(
        rows(t.db, "SELECT why FROM v_needs_attention WHERE ref = ?", id),
        c.reason,
      ).toContainEqual({ why: "gate_stuck" });
    }
    expect(ticketOf("ticket-1")).toEqual({ status: "code_review", version: 1 });
    expect(transitions("ticket-1")).toEqual([]);
    expect(audits("ticket-1")).toEqual([]);
  });

  // a moved base used to strand the ticket here, with no finding and no machine step.
  test("base_drift takes request_fix to review_fix with its rebase finding, and leaves no stuck gate", async () => {
    await open("g1");
    const decided = unwrap(
      await decide("g1", {
        evidence: {
          reason: "base_drift",
          drift: { base_sha: "a".repeat(40), tip_sha: "c".repeat(40) },
        },
      }),
    );
    expect(decided.advance).toMatchObject({
      advanced: true,
      rule: "request_fix",
      from: "code_review",
      to: "review_fix",
    });
    expect(ticketOf("ticket-1")).toEqual({ status: "review_fix", version: 2 });
    expect(transitions("ticket-1")).toMatchObject([
      {
        actor_kind: "supervisor",
        to_status: "review_fix",
        payload_json: { rule: "request_fix", gate_id: "g1" },
      },
    ]);
    // Not stuck, and its finding is informational: not on the findings_open arm (blocker, major).
    expect(
      rows(t.db, "SELECT why FROM v_needs_attention WHERE ref = ?", "g1"),
    ).toEqual([]);
  });

  test("two gates drifted in one round: one request_fix, once both decided, and a finding each", async () => {
    nonTrivial("ticket-1");
    await open("g1");
    await open("g2", { kind: "ce_review" });
    const drift = {
      reason: "base_drift",
      drift: { base_sha: "a".repeat(40), tip_sha: "c".repeat(40) },
    };
    const code = unwrap(await decide("g1", { evidence: drift }));
    expect(code.advance).toMatchObject({
      advanced: false,
      why: "ce_review still running",
    });
    const ce = unwrap(await decide("g2", { evidence: drift }));
    expect(ce.advance).toMatchObject({
      advanced: true,
      rule: "request_fix",
      to: "review_fix",
    });
    expect(transitions("ticket-1")).toHaveLength(1);
    expect(
      rows(
        t.db,
        "SELECT gate_id, severity FROM findings WHERE category = 'base_drift' ORDER BY gate_id",
      ),
    ).toEqual([
      { gate_id: "g1", severity: "minor" },
      { gate_id: "g2", severity: "minor" },
    ]);
  });

  test("drift, fix, resubmit: round 2 passes and pass_review is taken, the drift finding still open", async () => {
    await open("g1");
    unwrap(
      await decide("g1", {
        evidence: {
          reason: "base_drift",
          drift: { base_sha: "a".repeat(40), tip_sha: "c".repeat(40) },
        },
      }),
    );
    expect(ticketOf("ticket-1")).toEqual({ status: "review_fix", version: 2 });
    // The fixer merged the tip and resubmits, without resolving the finding.
    const ticket = unwrap(await getTicket(t.db, "ticket-1"));
    unwrap(
      await transitionTicket(
        t.db,
        {
          id: ticket.id,
          version: ticket.version,
          to: "code_review",
          by: { actor_kind: "session", actor_id: "S-fix" },
        },
        allow,
        undefined,
        planFor("review_fix", "code_review"),
      ),
    );
    const [round2] = rows(
      t.db,
      "SELECT id, round FROM gates WHERE ticket_id = 'ticket-1' AND state = 'running'",
    ) as { id: string; round: number }[];
    expect(round2?.round).toBe(2);
    const passed = unwrap(await decide(round2?.id ?? ""));
    expect(passed.advance).toMatchObject({
      advanced: true,
      rule: "pass_review",
      to: "qa_harness",
    });
    expect(
      rows(
        t.db,
        "SELECT severity, status FROM findings WHERE category = 'base_drift'",
      ),
    ).toEqual([{ severity: "minor", status: "open" }]);
  });

  test("a ticket stranded by a drift decided before an earlier change (no finding) moves on the sweep", async () => {
    await open("g1", {
      state: "failed",
      evidence_json: JSON.stringify({ reason: "base_drift" }),
      decided_at: 0,
    });
    expect(unwrap(await advanceTicket(t.db, "ticket-1"))).toMatchObject({
      advanced: true,
      rule: "request_fix",
      to: "review_fix",
    });
    expect(ticketOf("ticket-1")).toEqual({ status: "review_fix", version: 2 });
  });

  test("at gates.drift_rounds_max (052's 3) drifted rounds running, nothing moves: the operator decides", async () => {
    for (const round of [1, 2, 3]) {
      await open(`g${round}`, {
        attempt: round,
        round,
        state: "failed",
        evidence_json: JSON.stringify({ reason: "base_drift" }),
        decided_at: 0,
      });
    }
    expect(unwrap(await advanceTicket(t.db, "ticket-1"))).toMatchObject({
      advanced: false,
      rule: null,
      why: "the base moved in 3 rounds running; the operator decides",
    });
    expect(ticketOf("ticket-1")).toEqual({ status: "code_review", version: 1 });
  });

  test("a timeout moves nothing: its retry runs, and the round waits for it", async () => {
    await open("g1");
    const decided = unwrap(
      await decide("g1", {
        evidence: { reason: "timeout" },
        findings: [MAJOR],
      }),
    );
    expect(decided.retry).toMatchObject({ state: "running", attempt: 2 });
    expect(decided.advance).toMatchObject({
      advanced: false,
      why: "code_review still running",
    });
    expect(ticketOf("ticket-1")).toEqual({ status: "code_review", version: 1 });
  });

  test("blocking findings take request_fix to review_fix, but only once the round's other gate is decided", async () => {
    nonTrivial("ticket-1");
    await open("g1");
    await open("g2", { kind: "ce_review" });
    const code = unwrap(await decide("g1", { findings: [MAJOR] }));
    expect(JSON.parse(String(code.gate.evidence_json))).toMatchObject({
      reason: "blocking_findings",
    });
    expect(code.advance).toMatchObject({
      advanced: false,
      why: "ce_review still running",
    });
    expect(ticketOf("ticket-1")).toEqual({ status: "code_review", version: 1 });
    const ce = unwrap(await decide("g2"));
    expect(ce.advance).toMatchObject({
      advanced: true,
      rule: "request_fix",
      from: "code_review",
      to: "review_fix",
    });
    expect(ticketOf("ticket-1")).toEqual({ status: "review_fix", version: 2 });
    expect(transitions("ticket-1")).toMatchObject([
      {
        actor_kind: "supervisor",
        to_status: "review_fix",
        payload_json: { rule: "request_fix", gate_id: "g2" },
      },
    ]);
    // It inserted no command: nothing ran to supersede, and the supervisor never inserts one.
    expect(rows(t.db, "SELECT id FROM commands")).toEqual([]);
  });

  test("an open blocker on an earlier round's attempt: the law refuses pass_review, and nothing moves", async () => {
    await open("g0", {
      state: "failed",
      evidence_json: JSON.stringify({
        ...EVIDENCE,
        reason: "blocking_findings",
      }),
      decided_at: 0,
    });
    unwrap(await seedRows(t.db, { findings: [findingRow("f0", "g0")] }));
    await open("g1", { attempt: 2, round: 2 });
    const decided = unwrap(await decide("g1"));
    expect(decided.gate.state).toBe("passed");
    expect(decided.advance).toMatchObject({
      advanced: false,
      rule: "pass_review",
    });
    expect(decided.advance.advanced ? "" : decided.advance.why).toContain(
      "unresolved_findings",
    );
    expect(ticketOf("ticket-1")).toEqual({ status: "code_review", version: 1 });
    expect(audits("ticket-1")).toEqual([]);
  });
});

describe("plan_review", () => {
  test("a passed plan_review takes approve_plan to planned", async () => {
    nonTrivial("ticket-2");
    await open("gp", {
      ticket_id: "ticket-2",
      kind: "plan_review",
      subject_kind: "plan",
      subject_ref: "docs/plan.md",
    });
    const decided = unwrap(await decide("gp"));
    expect(decided.advance).toMatchObject({
      advanced: true,
      rule: "approve_plan",
      from: "plan_review",
      to: "planned",
    });
    expect(ticketOf("ticket-2")).toEqual({ status: "planned", version: 2 });
    expect(audits("ticket-2")).toMatchObject([
      { actor: "supervisor", payload_json: { rule: "approve_plan" } },
    ]);
  });
});

describe("idempotent", () => {
  test("re-deciding is a conflict and advancing again finds the ticket moved: one move, one audit", async () => {
    await open("g1");
    unwrap(await decide("g1"));
    const again = await decide("g1");
    expect(again).toMatchObject({
      ok: false,
      error: { class: "conflict", cause: { state: "passed" } },
    });
    expect(unwrap(await advanceTicket(t.db, "ticket-1"))).toEqual({
      advanced: false,
      status: "qa_harness",
      rule: null,
      why: "no QA verdict in the round (none yet, or a failure that is not the code's)",
    });
    expect(ticketOf("ticket-1")).toEqual({ status: "qa_harness", version: 2 });
    expect(transitions("ticket-1")).toHaveLength(1);
    expect(audits("ticket-1")).toHaveLength(1);
  });

  test("a rerun after no_reviewer waits while it runs, then passes and advances once", async () => {
    await open("g1");
    unwrap(await decide("g1", { evidence: { reason: "no_reviewer" } }));
    const rerun = unwrap(
      await rerunGate(t.db, { gate_id: "g1", by: OPERATOR }),
    );
    expect(rerun.gate).toMatchObject({ attempt: 2, round: 1 });
    expect(unwrap(await advanceTicket(t.db, "ticket-1"))).toMatchObject({
      advanced: false,
      why: "code_review still running",
    });
    expect(unwrap(await decide(rerun.gate.id)).advance).toMatchObject({
      advanced: true,
      rule: "pass_review",
    });
    expect(unwrap(await advanceTicket(t.db, "ticket-1")).advanced).toBe(false);
    expect(audits("ticket-1")).toHaveLength(1);
  });

  test("a ticket no gate decides writes nothing; an unknown or empty id is refused", async () => {
    exec(t.db, "UPDATE tickets SET status = 'building' WHERE id = 'ticket-1'");
    expect(unwrap(await advanceTicket(t.db, "ticket-1"))).toEqual({
      advanced: false,
      status: "building",
      rule: null,
      why: "building is not a status a gate decides",
    });
    expect(await advanceTicket(t.db, "no-such-ticket")).toMatchObject({
      ok: false,
      error: { class: "not_found" },
    });
    expect(await advanceTicket(t.db, " ")).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
  });
});

describe("the QA gate", () => {
  const qaRuns = (ticket: string) =>
    rows(
      t.db,
      "SELECT gate_id, state, command, exit_code, report_paths_json FROM qa_runs WHERE ticket_id = ? ORDER BY rowid",
      ticket,
    );

  test("a qa gate that fails on a blocker writes a failed run and takes fail_harness to rework", async () => {
    await open("q1", { ticket_id: "ticket-3", kind: "qa_harness" });
    const decided = unwrap(await decide("q1", { findings: [BLOCKER] }));
    expect(decided.advance).toMatchObject({
      advanced: true,
      rule: "fail_harness",
      to: "rework",
    });
    expect(ticketOf("ticket-3")).toEqual({ status: "rework", version: 2 });
    expect(qaRuns("ticket-3")).toMatchObject([
      { gate_id: "q1", state: "failed" },
    ]);
  });

  // The whole point of the ticket: a real QA pass moves the ticket on with no operator override.
  test("a qa gate that passes writes a passed run, and pass_harness takes it to qa_human", async () => {
    await open("q2", { ticket_id: "ticket-4", kind: "qa_harness" });
    const decided = unwrap(
      await decide("q2", {
        evidence: {
          ...EVIDENCE,
          qa: {
            command: "make check",
            exit_code: 0,
            started_at: 10,
            ended_at: 20,
            reports: ["/a/qa-reports/out.xml"],
          },
        },
      }),
    );
    expect(decided.advance).toMatchObject({
      advanced: true,
      rule: "pass_harness",
      to: "qa_human",
    });
    expect(ticketOf("ticket-4")).toEqual({ status: "qa_human", version: 2 });
    expect(decided.qaRun).toMatchObject({
      state: "passed",
      command: "make check",
    });
    expect(qaRuns("ticket-4")).toEqual([
      {
        gate_id: "q2",
        state: "passed",
        command: "make check",
        exit_code: 0,
        report_paths_json: '["/a/qa-reports/out.xml"]',
      },
    ]);
  });

  // A harness that could not run judged nothing, so nothing moves and the row says `error` — which
  // is what stops a later attempt's failure being carried past `qa_passed` by a stale `passed`.
  test("a reviewer error writes an error run and moves nothing", async () => {
    await open("q3", { ticket_id: "ticket-3", kind: "qa_harness" });
    const decided = unwrap(
      await decide("q3", { evidence: { reason: "reviewer_error" } }),
    );
    expect(decided.gate.state).toBe("failed");
    expect(decided.advance).toMatchObject({ advanced: false });
    expect(ticketOf("ticket-3")).toEqual({ status: "qa_harness", version: 1 });
    expect(qaRuns("ticket-3")).toMatchObject([
      { gate_id: "q3", state: "error", command: null, exit_code: null },
    ]);
  });

  test("the newest run speaks for the ticket: a failed attempt after a passed one does not pass", async () => {
    await open("q4", { ticket_id: "ticket-4", kind: "qa_harness" });
    unwrap(
      await decide("q4", {
        evidence: {
          ...EVIDENCE,
          qa: {
            command: "make check",
            exit_code: 0,
            started_at: 10,
            ended_at: 20,
            reports: [],
          },
        },
      }),
    );
    // Back in qa_harness (the operator sent it back), a second attempt fails on the code.
    exec(
      t.db,
      "UPDATE tickets SET status = 'qa_harness' WHERE id = 'ticket-4'",
    );
    await open("q5", { ticket_id: "ticket-4", kind: "qa_harness", attempt: 2 });
    const second = unwrap(await decide("q5", { findings: [BLOCKER] }));
    expect(second.advance).toMatchObject({ rule: "fail_harness" });
    expect(
      qaRuns("ticket-4").map((r) => (r as { state: string }).state),
    ).toEqual(["passed", "failed"]);
  });

  // The round that opens the gate, from the other side: `pass_review`, taken by the supervisor,
  // opens the QA gate of the status it enters — with **no** `gate.run` command, because the
  // supervisor never inserts one (§9.5). The engine launches what `opened` names.
  test("pass_review on a project with a harness opens the QA gate, with no command", async () => {
    unwrap(
      await seedRows(t.db, {
        workspaces: [
          {
            id: "ws-qa",
            name: "ws-qa",
            kind: "single",
            qa_mode: "command",
            qa_cmd: "./scripts/check",
          },
        ],
      }),
    );
    exec(
      t.db,
      "UPDATE tickets SET workspace_id = 'ws-qa' WHERE id = 'ticket-1'",
    );
    await open("g-cr");
    const decided = unwrap(await decide("g-cr"));
    expect(decided.advance).toMatchObject({
      advanced: true,
      rule: "pass_review",
      to: "qa_harness",
    });
    const opened = decided.advance.advanced ? decided.advance.opened : [];
    expect(opened.map((g) => [g.kind, g.repo_id, g.subject_kind])).toEqual([
      ["qa_harness", null, "workspace"],
    ]);
    expect(
      rows(
        t.db,
        "SELECT count(*) AS n FROM commands WHERE type = 'gate.run' AND payload_json LIKE ?",
        `%${opened[0]?.id ?? ""}%`,
      ),
    ).toEqual([{ n: 0 }]);
  });

  // a CI project's QA gate opens waiting on its pull request, and keeps that mark — a
  // rerun waits on CI again even after the project's mode moved on.
  test("pass_review on a CI project opens the QA gate over the pull request; a rerun keeps the mark", async () => {
    unwrap(
      await seedRows(t.db, {
        workspaces: [
          {
            id: "ws-ci",
            name: "ws-ci",
            kind: "single",
            qa_mode: "ci",
            delivery_mode: "pull_request",
            delivery_when: "review_passed",
          },
        ],
      }),
    );
    exec(
      t.db,
      "UPDATE tickets SET workspace_id = 'ws-ci' WHERE id = 'ticket-1'",
    );
    await open("g-cr-ci");
    const decided = unwrap(await decide("g-cr-ci"));
    const opened = decided.advance.advanced ? decided.advance.opened : [];
    expect(opened.map((g) => [g.kind, g.subject_kind])).toEqual([
      ["qa_harness", "pull_request"],
    ]);
    const [ci] = opened;
    if (ci === undefined) throw new Error("no CI gate opened");
    unwrap(await decide(ci.id, { evidence: { reason: "reviewer_error" } }));
    expect(
      rows(t.db, "SELECT source, state FROM qa_runs WHERE gate_id = ?", ci.id),
    ).toEqual([{ source: "ci", state: "error" }]);
    // The project stops using CI; the gate's rerun is still a CI gate.
    exec(t.db, "UPDATE workspaces SET qa_mode = 'none' WHERE id = 'ws-ci'");
    const rerun = unwrap(
      await rerunGate(t.db, { gate_id: ci.id, by: OPERATOR }),
    );
    expect([rerun.gate.kind, rerun.gate.subject_kind]).toEqual([
      "qa_harness",
      "pull_request",
    ]);
  });

  test("pass_review on a project with no harness opens nothing", async () => {
    await open("g-cr2");
    const decided = unwrap(await decide("g-cr2"));
    expect(decided.advance).toMatchObject({
      advanced: true,
      rule: "pass_review",
    });
    expect(decided.advance.advanced ? decided.advance.opened : null).toEqual(
      [],
    );
  });

  // No gate at all: a project with `qa_mode` none or pending. The law is what it always was.
  test("with no qa gate the ticket waits for the operator's override", async () => {
    const decided = unwrap(await advanceTicket(t.db, "ticket-3"));
    expect(decided).toMatchObject({ advanced: false });
    expect(decided.advanced ? "" : decided.why).toContain("no QA verdict");
    expect(qaRuns("ticket-3")).toEqual([]);
  });
});
