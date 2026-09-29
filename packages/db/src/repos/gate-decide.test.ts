import type { ReviewFinding } from "@bayon/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  gateDb,
  listCommands,
  newSessionInput,
  seedRows,
  unwrap,
} from "../testing.js";
import { EVIDENCE, exec, gateRow, rows } from "./fixtures.js";
import { FINDING_DETAIL_CAP, decideGate } from "./gate-decide.js";

// decideGate: the supervisor's one gate writer. The writer runs verdict()
// itself, so nothing passes without evidence; a timeout or restart reopens the gate once.

let t: Awaited<ReturnType<typeof gateDb>>;
beforeEach(async () => {
  t = await gateDb(["code_review", "plan_review", "building"]);
  unwrap(
    await seedRows(t.db, { gates: [gateRow("g1", { ticket_id: "ticket-1" })] }),
  );
  unwrap(
    await seedRows(t.db, {
      sessions: [
        {
          ...newSessionInput(),
          id: "S-review",
          state: "running",
          gate_id: "g1",
          created_at: 0,
        },
      ],
    }),
  );
});
afterEach(() => t.cleanup());

const finding = (o: Partial<ReviewFinding> = {}): ReviewFinding => ({
  severity: "major",
  summary: "the null check is gone",
  file: "src/a.ts",
  line: 12,
  category: "correctness",
  detail_md: null,
  ...o,
});

const decide = (o: Partial<Parameters<typeof decideGate>[1]> = {}) =>
  decideGate(t.db, {
    gate_id: "g1",
    session_id: "S-review",
    evidence: EVIDENCE,
    findings: [],
    ...o,
  });

const gate = (id: string) =>
  (
    rows(t.db, "SELECT * FROM gates WHERE id = ?", id) as Record<
      string,
      unknown
    >[]
  )[0];

describe("the verdict is the writer's", () => {
  test("evidence missing a field is stored failed/missing_evidence, never passed", async () => {
    const partial = Object.fromEntries(
      Object.entries(EVIDENCE).filter(([key]) => key !== "exit_code"),
    );
    const decided = unwrap(await decide({ evidence: partial }));
    expect(decided.gate).toMatchObject({
      state: "failed",
      evidence_json: '{"reason":"missing_evidence"}',
      subject_ref: "unpinned",
    });
    expect(decided.retry).toBeNull();
  });

  test("valid evidence and an open major fail the gate; the finding is stored open; the subject is pinned", async () => {
    const decided = unwrap(await decide({ findings: [finding()] }));
    expect(decided.gate).toMatchObject({
      state: "failed",
      findings_total: 1,
      findings_unresolved: 1,
      reviewer_session_id: "S-review",
      subject_ref: `${"a".repeat(40)}..${"b".repeat(40)}`,
      decided_at: t.clock.now(),
    });
    expect(JSON.parse(String(decided.gate.evidence_json))).toMatchObject({
      command: EVIDENCE.command,
      reason: "blocking_findings",
    });
    expect(decided.findings).toMatchObject([
      { severity: "major", status: "open", file: "src/a.ts", line: 12 },
    ]);
  });

  test("valid evidence with a minor finding only passes", async () => {
    const decided = unwrap(
      await decide({ findings: [finding({ severity: "minor" })] }),
    );
    expect(decided.gate).toMatchObject({
      state: "passed",
      findings_unresolved: 1,
    });
    expect(JSON.parse(String(decided.gate.evidence_json))).toEqual(EVIDENCE);
  });

  test("a long detail is capped; the full review stays in the artifacts", async () => {
    const decided = unwrap(
      await decide({
        findings: [
          finding({
            severity: "nit",
            detail_md: "x".repeat(10_000),
            summary: "y".repeat(900),
          }),
        ],
      }),
    );
    const [stored] = decided.findings;
    expect(stored?.detail_md?.length).toBe(FINDING_DETAIL_CAP);
    expect(stored?.detail_md).toContain("truncated");
    expect(stored?.summary.length).toBe(500);
  });

  test("the audit event is the supervisor's, and names the session", async () => {
    unwrap(await decide());
    const [event] = rows(
      t.db,
      "SELECT actor_kind, actor_id, payload_json FROM ticket_events WHERE kind = 'gate'",
    ) as {
      actor_kind: string;
      actor_id: string;
      payload_json: string;
    }[];
    expect(event).toMatchObject({
      actor_kind: "supervisor",
      actor_id: "S-review",
    });
    expect(JSON.parse(event?.payload_json ?? "{}")).toMatchObject({
      step: "decide",
      state: "passed",
      attempt: 1,
    });
  });

  test("a failure before a review keeps its detail and considered runners", async () => {
    const failure = {
      reason: "no_reviewer",
      detail:
        "code_reviewer on local (unbound: every runner): fixture: code_review needs structured output",
      considered: {
        role: "code_reviewer",
        executor_id: "local",
        bound: false,
        runners: [{ runner_id: "fixture", why: ["needs_output_schema"] }],
      },
    };
    unwrap(await decide({ session_id: null, evidence: failure }));
    expect(gate("g1")).toMatchObject({ state: "failed" });
    expect(JSON.parse(String(gate("g1")?.["evidence_json"]))).toEqual(failure);
  });

  test("a base_drift keeps the pinned base and the tip", async () => {
    const failure = {
      reason: "base_drift",
      detail: "the pinned base is not the tip",
      drift: { base_sha: "a".repeat(40), tip_sha: "c".repeat(40) },
    };
    unwrap(await decide({ session_id: null, evidence: failure }));
    expect(JSON.parse(String(gate("g1")?.["evidence_json"]))).toEqual(failure);
  });

  // a moved base is a fix round, and the fixer is told what to fix.
  test("a base_drift at pin files one open informational finding and sends the ticket to review_fix, together", async () => {
    const failure = {
      reason: "base_drift",
      detail: "the pinned base is not the tip",
      drift: { base_sha: "a".repeat(40), tip_sha: "c".repeat(40) },
    };
    const decided = unwrap(
      await decide({ session_id: null, evidence: failure }),
    );
    expect(decided.gate).toMatchObject({
      state: "failed",
      findings_total: 1,
      findings_unresolved: 1,
    });
    expect(decided.findings).toMatchObject([
      {
        gate_id: "g1",
        severity: "minor",
        category: "base_drift",
        status: "open",
        file: null,
        line: null,
      },
    ]);
    expect(decided.findings[0]?.summary).toContain(
      `merge ${"c".repeat(12)} into this branch`,
    );
    expect(decided.findings[0]?.detail_md).toContain(
      `git merge ${"c".repeat(40)}`,
    );
    expect(decided.advance).toMatchObject({
      advanced: true,
      rule: "request_fix",
      from: "code_review",
      to: "review_fix",
    });
    expect(
      rows(t.db, "SELECT status FROM tickets WHERE id = 'ticket-1'"),
    ).toEqual([{ status: "review_fix" }]);
  });

  test("a review failed on its drift flag with only a minor finding: both findings, then review_fix", async () => {
    // gates.base_drift is seeded "fail" (007).
    const decided = unwrap(
      await decide({
        evidence: { ...EVIDENCE, flags: { base_drift: true } },
        findings: [finding({ severity: "minor" })],
      }),
    );
    expect(JSON.parse(String(decided.gate.evidence_json))).toMatchObject({
      reason: "base_drift",
    });
    expect(decided.findings.map((f) => [f.severity, f.category])).toEqual([
      ["minor", "correctness"],
      ["minor", "base_drift"],
    ]);
    expect(decided.advance).toMatchObject({
      advanced: true,
      rule: "request_fix",
    });
  });

  test("a per-repo gate's drift finding names the repo from the database", async () => {
    unwrap(
      await seedRows(t.db, {
        repos: [{ id: "ra", name: "api", mirror_path: "/m/ra" }],
      }),
    );
    unwrap(
      await seedRows(t.db, {
        gates: [gateRow("gr", { ticket_id: "ticket-1", repo_id: "ra" })],
      }),
    );
    const decided = unwrap(
      await decideGate(t.db, {
        gate_id: "gr",
        session_id: null,
        evidence: { reason: "base_drift" },
        findings: [],
      }),
    );
    expect(decided.findings[0]?.summary).toBe(
      "Repo api: The base branch moved: merge its tip into this branch, rerun the checks, then resubmit",
    );
  });

  test("a plan_review is never given a drift finding", async () => {
    unwrap(
      await seedRows(t.db, {
        gates: [
          gateRow("gp", {
            ticket_id: "ticket-2",
            kind: "plan_review",
            subject_kind: "plan",
            subject_ref: "docs/plan.md",
          }),
        ],
      }),
    );
    const decided = unwrap(
      await decideGate(t.db, {
        gate_id: "gp",
        session_id: null,
        evidence: { reason: "base_drift" },
        findings: [],
      }),
    );
    expect(decided.findings).toEqual([]);
  });

  test("a failure on blocking findings gets no drift finding", async () => {
    const decided = unwrap(await decide({ findings: [finding()] }));
    expect(decided.findings.map((f) => f.category)).toEqual(["correctness"]);
  });

  test("a held reviewer's timeout keeps its queued_reason", async () => {
    const decided = unwrap(
      await decide({ evidence: { reason: "timeout", queued_reason: "slot" } }),
    );
    expect(JSON.parse(String(decided.gate.evidence_json))).toEqual({
      reason: "timeout",
      queued_reason: "slot",
    });
  });

  test("with no session, the actor is 'supervisor'", async () => {
    unwrap(
      await decide({ session_id: null, evidence: { reason: "no_reviewer" } }),
    );
    const [event] = rows(
      t.db,
      "SELECT actor_kind, actor_id FROM ticket_events WHERE kind = 'gate'",
    );
    expect(event).toEqual({ actor_kind: "supervisor", actor_id: "supervisor" });
    expect(gate("g1")).toMatchObject({
      state: "failed",
      evidence_json: '{"reason":"no_reviewer"}',
    });
  });
});

describe("what decideGate refuses", () => {
  test("a gate that is not running is a conflict naming its state, and nothing is written", async () => {
    unwrap(await decide());
    const before = rows(t.db, "SELECT count(*) AS n FROM ticket_events");
    expect(await decide({ findings: [finding()] })).toMatchObject({
      ok: false,
      error: { class: "conflict", cause: { state: "passed" } },
    });
    expect(rows(t.db, "SELECT count(*) AS n FROM ticket_events")).toEqual(
      before,
    );
    expect(rows(t.db, "SELECT id FROM findings")).toEqual([]);
  });

  test("a session that is not the gate's reviewer, an unknown gate, invalid settings", async () => {
    expect(await decide({ session_id: "S-1" })).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
    expect(await decide({ gate_id: "nope" })).toMatchObject({
      ok: false,
      error: { class: "not_found" },
    });
    exec(t.db, "DELETE FROM settings WHERE key = 'gates.timeout_retries'");
    expect(await decide()).toMatchObject({
      ok: false,
      error: {
        class: "validation",
        message: expect.stringContaining("gate settings"),
      },
    });
    expect(gate("g1")).toMatchObject({ state: "running" });
  });
});

describe("a timeout or restart reopens the gate once, in the same transaction", () => {
  test("a timeout fails the gate and returns attempt 2, running, with no command", async () => {
    const before = unwrap(await listCommands(t.db)).length;
    const decided = unwrap(await decide({ evidence: { reason: "timeout" } }));
    expect(decided.gate).toMatchObject({
      state: "failed",
      evidence_json: '{"reason":"timeout"}',
    });
    expect(decided.retry).toMatchObject({
      ticket_id: "ticket-1",
      kind: "code_review",
      attempt: 2,
      state: "running",
      repo_id: null,
      started_at: t.clock.now(),
    });
    expect(unwrap(await listCommands(t.db))).toHaveLength(before);
    const steps = (
      rows(
        t.db,
        "SELECT payload_json FROM ticket_events WHERE kind = 'gate' ORDER BY id",
      ) as {
        payload_json: string;
      }[]
    ).map((e) => JSON.parse(e.payload_json) as { step: string });
    expect(steps.map((s) => s.step)).toEqual(["decide", "retry"]);
  });

  test("the retry's own timeout is not retried with the default budget of 1", async () => {
    const first = unwrap(await decide({ evidence: { reason: "timeout" } }));
    const retry = first.retry?.id ?? "";
    const second = unwrap(
      await decideGate(t.db, {
        gate_id: retry,
        session_id: null,
        evidence: { reason: "timeout" },
        findings: [],
      }),
    );
    expect(second.retry).toBeNull();
  });

  test("a supervisor restart is retried; a full evidence carrying timeout is too", async () => {
    expect(
      unwrap(await decide({ evidence: { reason: "supervisor_restart" } }))
        .retry,
    ).not.toBeNull();
    unwrap(
      await seedRows(t.db, {
        gates: [gateRow("g2", { ticket_id: "ticket-2", kind: "plan_review" })],
      }),
    );
    const decided = unwrap(
      await decideGate(t.db, {
        gate_id: "g2",
        session_id: null,
        evidence: { ...EVIDENCE, exit_code: 137, reason: "timeout" },
        findings: [],
      }),
    );
    expect(decided.retry).toMatchObject({
      kind: "plan_review",
      attempt: 2,
      subject_kind: "plan",
    });
  });

  test("no retry once the ticket left the review status", async () => {
    exec(t.db, "UPDATE tickets SET status = 'blocked' WHERE id = 'ticket-1'");
    expect(
      unwrap(await decide({ evidence: { reason: "timeout" } })).retry,
    ).toBeNull();
  });

  test("no retry when timeout_retries is 0", async () => {
    exec(
      t.db,
      "UPDATE settings SET value_json = '0' WHERE key = 'gates.timeout_retries'",
    );
    expect(
      unwrap(await decide({ evidence: { reason: "timeout" } })).retry,
    ).toBeNull();
  });
});
