import { FakeClock, STAFF_APPROVAL_KIND, waitingOnYou } from "@bayon/core";
import type { Insertable } from "kysely";
import { afterAll, expect, test } from "vitest";
import type { Db } from "../connection.js";
import type { SessionsTable, TicketsTable } from "../schema.js";
import type {
  DeliveriesTable,
  GatesTable,
  HumanRequestsTable,
} from "../schema-work.js";
import {
  SPINE_SEED,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "../testing.js";
import { getNextStepFacts, listWaitFacts } from "./ticket-waits.js";

// The facts nextStep and the board's flag read beside the laws': one set-based pass for
// a page of tickets, and one ticket's next-step facts.

const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function world(): Promise<Db> {
  const t = unwrap(await tempDb(clock));
  cleanups.push(t.cleanup);
  unwrap(await seedSpine(t.db, 35));
  unwrap(
    await seedRows(t.db, {
      workspaces: [
        { id: "ws-a", name: "a", kind: "single" },
        { id: "ws-b", name: "b", kind: "single", paused: 1 },
      ],
      agents: [
        {
          id: "orch-a",
          name: "orch-a",
          kind: "orchestrator",
          runner_id: SPINE_SEED.runnerId,
          executor_id: SPINE_SEED.executorId,
          workspace_id: "ws-a",
          created_at: 0,
        },
      ],
    }),
  );
  return t.db;
}

const ticket = (num: number, o: Partial<Insertable<TicketsTable>> = {}) =>
  ticketRow(num, { workspace_id: "ws-a", ...o });

const gate = (
  id: string,
  ticket_id: string,
  o: Partial<Insertable<GatesTable>> = {},
): Insertable<GatesTable> => ({
  id,
  ticket_id,
  kind: "code_review",
  state: "passed",
  subject_kind: "diff",
  subject_ref: "HEAD",
  ...o,
});

const session = (
  id: string,
  o: Partial<Insertable<SessionsTable>>,
): Insertable<SessionsTable> => ({
  ...newSessionInput(),
  id,
  state: "running",
  created_at: 1,
  ...o,
});

const ask = (
  id: string,
  ticket_id: string,
  o: Partial<Insertable<HumanRequestsTable>> = {},
): Insertable<HumanRequestsTable> => ({
  id,
  ticket_id,
  kind: "decision",
  question: `${id}?`,
  status: "open",
  asked_at: 1,
  ...o,
});

const reason = (r: string) => JSON.stringify({ reason: r });

test("an empty page reads nothing", async () => {
  const db = await world();
  expect(unwrap(await listWaitFacts(db, []))).toEqual(new Map());
});

test("questions, a proposal, the holder, a hand-off, the orchestrator and the pauses", async () => {
  const db = await world();
  unwrap(
    await seedRows(db, {
      settings: [{ key: "fleet.paused", value_json: "1", updated_at: 1 }],
      tickets: [
        ticket(1, { status: "building", needs_human: 1, blocked_reason: null }),
        ticket(2, { status: "prioritized", workspace_id: "ws-b" }),
        ticket(3, { status: "backlog", workspace_id: null }),
      ],
      sessions: [
        session("old", {
          ticket_id: "ticket-1",
          state: "exited",
          created_at: 5,
        }),
        session("live", {
          ticket_id: "ticket-1",
          state: "idle",
          created_at: 2,
        }),
      ],
      handoffs: [
        {
          id: "h-writing",
          ticket_id: "ticket-2",
          reason: "ceiling",
          facts_json: "{}",
          quality: "writing",
          packet_path: "/p",
          packet_hash: "0",
          created_at: 1,
        },
      ],
      human_requests: [
        ask("q1", "ticket-1"),
        ask("q2", "ticket-1"),
        ask("q-done", "ticket-1", { status: "answered" }),
        ask("p1", "ticket-2", { kind: STAFF_APPROVAL_KIND }),
      ],
    }),
  );
  const facts = unwrap(
    await listWaitFacts(db, ["ticket-1", "ticket-2", "ticket-3", "gone"]),
  );
  expect([...facts.keys()].sort()).toEqual([
    "ticket-1",
    "ticket-2",
    "ticket-3",
  ]);
  expect(facts.get("ticket-1")).toMatchObject({
    status: "building",
    needs_human: true,
    open_questions: 2,
    proposal_open: false,
    holder_state: "idle",
    has_orchestrator: true,
    fleet_paused: true,
    project_paused: false,
    qa_configured: false,
  });
  expect(facts.get("ticket-2")).toMatchObject({
    open_questions: 0,
    proposal_open: true,
    holder_state: null,
    // A hand-off still being written is not pending (v_needs_attention's rule).
    handoff_pending: false,
    // ws-b has no orchestrator of its own, and the fleet has none.
    has_orchestrator: false,
    project_paused: true,
  });
  // No project: only a fleet orchestrator covers it, and there is none.
  expect(facts.get("ticket-3")).toMatchObject({
    has_orchestrator: false,
    project_paused: false,
  });
});

test("a fleet orchestrator covers a ticket with no project; a disabled one covers nothing", async () => {
  const db = await world();
  unwrap(
    await seedRows(db, {
      agents: [
        {
          id: "orch-fleet",
          name: "orch-fleet",
          kind: "orchestrator",
          runner_id: SPINE_SEED.runnerId,
          executor_id: SPINE_SEED.executorId,
          created_at: 0,
        },
        {
          id: "orch-b",
          name: "orch-b",
          kind: "orchestrator",
          runner_id: SPINE_SEED.runnerId,
          executor_id: SPINE_SEED.executorId,
          workspace_id: "ws-b",
          enabled: 0,
          created_at: 0,
        },
      ],
      tickets: [
        ticket(1, { workspace_id: null }),
        ticket(2, { workspace_id: "ws-b" }),
      ],
      handoffs: [
        {
          id: "h-1",
          ticket_id: "ticket-1",
          reason: "ceiling",
          facts_json: "{}",
          quality: "ok",
          packet_path: "/p",
          packet_hash: "0",
          created_at: 1,
        },
      ],
    }),
  );
  const facts = unwrap(await listWaitFacts(db, ["ticket-1", "ticket-2"]));
  expect(facts.get("ticket-1")).toMatchObject({
    has_orchestrator: true,
    handoff_pending: true,
  });
  // The fleet's orchestrator reads every project; the disabled project one reads nothing.
  expect(facts.get("ticket-2")?.has_orchestrator).toBe(true);
});

test("a split closes once every child is closed and no worktree is active", async () => {
  const db = await world();
  unwrap(
    await seedRows(db, {
      tickets: [
        ticket(1, { status: "split" }),
        ticket(2, { status: "split" }),
        ticket(11, { status: "done", parent_ticket_id: "ticket-1" }),
        ticket(12, { status: "parked", parent_ticket_id: "ticket-1" }),
        ticket(21, { status: "building", parent_ticket_id: "ticket-2" }),
      ],
    }),
  );
  const facts = unwrap(
    await listWaitFacts(db, ["ticket-1", "ticket-2", "ticket-11"]),
  );
  expect(facts.get("ticket-1")?.split_closable).toBe(true);
  expect(facts.get("ticket-2")?.split_closable).toBe(false);
  expect(facts.get("ticket-11")?.split_closable).toBe(false);
});

test("the round: running, a reviewer awaited, anchored, settled, a code failure, the worst reason", async () => {
  const db = await world();
  unwrap(
    await seedRows(db, {
      repos: [
        { id: "ra", name: "ra", mirror_path: "/m/ra" },
        { id: "rb", name: "rb", mirror_path: "/m/rb" },
      ],
      tickets: [
        ticket(1, { status: "code_review" }),
        ticket(2, { status: "code_review" }),
        ticket(3, { status: "code_review", non_trivial: 1 }),
        ticket(4, { status: "code_review" }),
        ticket(5, { status: "code_review" }),
        ticket(6, { status: "plan_review" }),
        ticket(7, { status: "building" }),
        ticket(8, { status: "code_review", non_trivial: 1 }),
        ticket(9, { status: "qa_harness" }),
      ],
      gates: [
        // 1: a review running with no reviewer session yet.
        gate("g1", "ticket-1", { state: "running" }),
        // 2: running with its reviewer live.
        gate("g2", "ticket-2", { state: "running" }),
        // 3: non-trivial, code_review passed, no ce_review in the round: not settled.
        gate("g3", "ticket-3"),
        // 4: an older no_reviewer answered by a newer failure on the code, a major open.
        gate("g4-a1", "ticket-4", {
          state: "failed",
          evidence_json: reason("no_reviewer"),
        }),
        gate("g4-a2", "ticket-4", {
          attempt: 2,
          round: 2,
          state: "failed",
          evidence_json: reason("blocking_findings"),
        }),
        // 5: two repos failed: the base moved on one, the reviewer timed out on the other.
        gate("g5-ra", "ticket-5", {
          repo_id: "ra",
          state: "failed",
          evidence_json: reason("base_drift"),
        }),
        gate("g5-rb", "ticket-5", {
          repo_id: "rb",
          state: "failed",
          evidence_json: reason("timeout"),
        }),
        // 6: a plan review failed on findings with only a minor open: not blocking.
        gate("g6", "ticket-6", {
          kind: "plan_review",
          subject_kind: "plan",
          state: "failed",
          evidence_json: reason("blocking_findings"),
        }),
        // 7: a building ticket's old review is not read at all.
        gate("g7", "ticket-7", { state: "running" }),
        // 8: code_review passed, ce_review drifted with only a minor open: a fix round.
        gate("g8", "ticket-8"),
        gate("g8-ce", "ticket-8", {
          kind: "ce_review",
          state: "failed",
          evidence_json: reason("base_drift"),
        }),
        // 9: a drifted QA harness is not a fix round: fail_harness is for the code alone.
        gate("g9", "ticket-9", {
          kind: "qa_harness",
          state: "failed",
          evidence_json: reason("base_drift"),
        }),
      ],
      findings: [
        {
          id: "f4",
          gate_id: "g4-a2",
          severity: "major",
          summary: "f4",
          created_at: 0,
        },
        {
          id: "f6",
          gate_id: "g6",
          severity: "minor",
          summary: "f6",
          created_at: 0,
        },
        {
          id: "f8",
          gate_id: "g8-ce",
          severity: "minor",
          summary: "f8",
          created_at: 0,
        },
      ],
    }),
  );
  // After its gate: a reviewer session references it.
  unwrap(
    await seedRows(db, {
      sessions: [session("rev-2", { gate_id: "g2", ticket_id: "ticket-2" })],
    }),
  );
  const ids = [
    "ticket-1",
    "ticket-2",
    "ticket-3",
    "ticket-4",
    "ticket-5",
    "ticket-6",
    "ticket-7",
    "ticket-8",
    "ticket-9",
  ];
  const facts = unwrap(await listWaitFacts(db, ids));
  const review = (id: string) => facts.get(id)?.review;
  expect(review("ticket-1")).toEqual({
    running: true,
    reviewerAwaited: true,
    anchored: true,
    settled: false,
    codeFailed: false,
    failure: null,
  });
  expect(review("ticket-2")).toMatchObject({
    running: true,
    reviewerAwaited: false,
  });
  // The reviewer session is a gate's, never the ticket's holder.
  expect(facts.get("ticket-2")?.holder_state).toBeNull();
  expect(review("ticket-3")).toMatchObject({
    anchored: true,
    settled: false,
    running: false,
  });
  expect(review("ticket-4")).toMatchObject({
    anchored: true,
    settled: false,
    codeFailed: true,
    failure: "blocking_findings",
  });
  // The base moved on one repo: that alone sends the round back to fix, and the new
  // round asks the timed-out review again. The worst reason is still the infra one.
  expect(review("ticket-5")).toMatchObject({
    failure: "timeout",
    codeFailed: true,
  });
  expect(review("ticket-8")).toMatchObject({
    settled: false,
    codeFailed: true,
    failure: "base_drift",
  });
  expect(review("ticket-9")).toMatchObject({
    codeFailed: false,
    failure: "base_drift",
  });
  expect(review("ticket-6")).toMatchObject({
    codeFailed: false,
    failure: "blocking_findings",
  });
  expect(review("ticket-7")).toEqual({
    running: false,
    reviewerAwaited: false,
    anchored: false,
    settled: false,
    codeFailed: false,
    failure: null,
  });
  // What the board then says: the page's own sentences.
  // foreman takes request_fix for 4, 5 and 8 on its own: none of them waits on the operator.
  expect(waitingOnYou(facts.get("ticket-5") ?? fail())).toBeNull();
  expect(waitingOnYou(facts.get("ticket-8") ?? fail())).toBeNull();
  expect(waitingOnYou(facts.get("ticket-4") ?? fail())).toBeNull();
});

// core's drift cap (gates.drift_rounds_max, 052 seeds 3), counted the same way.
test("drifted rounds running: under the cap a fix round, at it the operator's", async () => {
  const db = await world();
  const drifted = (id: string, ticketId: string, round: number) =>
    gate(id, ticketId, {
      attempt: round,
      round,
      state: "failed",
      evidence_json: reason("base_drift"),
    });
  unwrap(
    await seedRows(db, {
      tickets: [
        ticket(1, { status: "code_review" }),
        ticket(2, { status: "code_review" }),
        ticket(3, { status: "code_review" }),
      ],
      gates: [
        // 1: two drifted rounds running.
        drifted("g1-1", "ticket-1", 1),
        drifted("g1-2", "ticket-1", 2),
        // 2: three: the cap.
        drifted("g2-1", "ticket-2", 1),
        drifted("g2-2", "ticket-2", 2),
        drifted("g2-3", "ticket-2", 3),
        // 3: three drifts, but round 2 failed on the code: the streak is 1.
        drifted("g3-1", "ticket-3", 1),
        gate("g3-2", "ticket-3", {
          attempt: 2,
          round: 2,
          state: "failed",
          evidence_json: reason("blocking_findings"),
        }),
        drifted("g3-3", "ticket-3", 3),
      ],
    }),
  );
  const facts = unwrap(
    await listWaitFacts(db, ["ticket-1", "ticket-2", "ticket-3"]),
  );
  expect(facts.get("ticket-1")?.review.codeFailed).toBe(true);
  expect(facts.get("ticket-2")?.review.codeFailed).toBe(false);
  expect(facts.get("ticket-3")?.review.codeFailed).toBe(true);
  expect(waitingOnYou(facts.get("ticket-1") ?? fail())).toBeNull();
  expect(waitingOnYou(facts.get("ticket-2") ?? fail())).toMatchObject({
    code: "gate",
  });
});

test("a drifted ce_review a trivial ticket no longer owes sends nothing back", async () => {
  const db = await world();
  unwrap(
    await seedRows(db, {
      tickets: [ticket(1, { status: "code_review" })],
      gates: [
        gate("g1", "ticket-1"),
        gate("g1-ce", "ticket-1", {
          kind: "ce_review",
          state: "failed",
          evidence_json: reason("base_drift"),
        }),
      ],
    }),
  );
  const facts = unwrap(await listWaitFacts(db, ["ticket-1"]));
  expect(facts.get("ticket-1")?.review).toMatchObject({
    settled: true,
    codeFailed: false,
  });
});

test("a trivial ticket's round is settled without a ce_review; a waived gate counts", async () => {
  const db = await world();
  unwrap(
    await seedRows(db, {
      tickets: [
        ticket(1, { status: "code_review" }),
        ticket(2, { status: "code_review", non_trivial: 1 }),
      ],
      gates: [
        gate("g1", "ticket-1"),
        gate("g1-ce", "ticket-1", { kind: "ce_review", state: "failed" }),
        gate("g2", "ticket-2", {
          state: "waived",
          waive_reason: "checked by hand",
        }),
        gate("g2-ce", "ticket-2", { kind: "ce_review" }),
      ],
    }),
  );
  const facts = unwrap(await listWaitFacts(db, ["ticket-1", "ticket-2"]));
  expect(facts.get("ticket-1")?.review).toMatchObject({
    settled: true,
    anchored: true,
  });
  expect(facts.get("ticket-2")?.review).toMatchObject({
    settled: true,
    anchored: true,
  });
});

test("an unreadable blocking-severities setting blocks nothing here", async () => {
  const db = await world();
  unwrap(
    await seedRows(db, {
      settings: [
        {
          key: "gates.blocking_severities",
          value_json: "{oops",
          updated_at: 1,
        },
      ],
      tickets: [ticket(1, { status: "code_review" })],
      gates: [
        gate("g1", "ticket-1", {
          state: "failed",
          evidence_json: reason("blocking_findings"),
        }),
      ],
      findings: [
        {
          id: "f1",
          gate_id: "g1",
          severity: "blocker",
          summary: "f1",
          created_at: 0,
        },
      ],
    }),
  );
  const facts = unwrap(await listWaitFacts(db, ["ticket-1"]));
  expect(facts.get("ticket-1")?.review.codeFailed).toBe(false);
});

test("one ticket's next-step facts: its holder by name, its live reviewers, its park note", async () => {
  const db = await world();
  unwrap(
    await seedRows(db, {
      tickets: [
        ticket(1, { status: "code_review" }),
        ticket(2, { status: "parked" }),
      ],
      gates: [
        gate("g1", "ticket-1", { state: "running" }),
        gate("g1-ce", "ticket-1", { kind: "ce_review", state: "running" }),
      ],
      ticket_events: [
        {
          ticket_id: "ticket-2",
          ts: 1,
          actor_kind: "operator",
          kind: "transition",
          from_status: "building",
          to_status: "parked",
          reason: "waits on the design",
        },
      ],
      human_requests: [ask("q1", "ticket-1")],
    }),
  );
  unwrap(
    await seedRows(db, {
      sessions: [
        session("builder", {
          ticket_id: "ticket-1",
          state: "running",
          turns: 14,
        }),
        session("rev", { ticket_id: "ticket-1", gate_id: "g1" }),
        session("rev-gone", {
          ticket_id: "ticket-1",
          gate_id: "g1-ce",
          state: "exited",
        }),
      ],
    }),
  );
  expect(unwrap(await getNextStepFacts(db, "ticket-1"))).toEqual({
    openQuestions: 1,
    proposalOpen: false,
    holder: { agent: SPINE_SEED.agentName, state: "running", turns: 14 },
    liveGateIds: ["g1"],
    handoffPending: false,
    parkNote: null,
    pause: { fleet: false, project: false },
    hasOrchestrator: true,
    qaConfigured: false,
    ci: { pulls: 0, done: 0, total: 0 },
  });
  expect(unwrap(await getNextStepFacts(db, "ticket-2"))).toMatchObject({
    holder: null,
    parkNote: "waits on the design",
  });
  const missing = await getNextStepFacts(db, "nope");
  expect(missing.ok ? null : missing.error.class).toBe("not_found");
});

test("a broken fleet.paused row is a config error, as it is to admission", async () => {
  const db = await world();
  unwrap(
    await seedRows(db, {
      settings: [{ key: "fleet.paused", value_json: "7", updated_at: 1 }],
      tickets: [ticket(1)],
    }),
  );
  const listed = await listWaitFacts(db, ["ticket-1"]);
  expect(listed.ok).toBe(false);
  const one = await getNextStepFacts(db, "ticket-1");
  expect(one.ok).toBe(false);
});

// `qa_configured` was hard-coded false, so the board and the next step told the operator
// to pass QA with a note while a harness ran. It is now the laws' own fact: the project's qa_mode.
test("qa_configured is the project's own QA mode: command and ci wait on the gate, none and pending do not", async () => {
  const db = await world();
  unwrap(
    await seedRows(db, {
      workspaces: [
        {
          id: "ws-cmd",
          name: "cmd",
          kind: "single",
          qa_mode: "command",
          qa_cmd: "make check",
        },
        {
          id: "ws-ci",
          name: "ci",
          kind: "single",
          qa_mode: "ci",
          delivery_mode: "pull_request",
          delivery_when: "review_passed",
        },
        {
          id: "ws-pending",
          name: "pending",
          kind: "single",
          qa_mode: "pending",
        },
      ],
      tickets: [
        ticket(1, { status: "qa_harness", workspace_id: "ws-cmd" }),
        ticket(2, { status: "qa_harness", workspace_id: "ws-ci" }),
        ticket(3, { status: "qa_harness", workspace_id: "ws-pending" }),
        ticket(4, { status: "qa_harness" }),
        ticket(5, { status: "qa_harness", workspace_id: null }),
      ],
    }),
  );
  const ids = [1, 2, 3, 4, 5].map((n) => `ticket-${String(n)}`);
  const facts = unwrap(await listWaitFacts(db, ids));
  expect(ids.map((id) => facts.get(id)?.qa_configured)).toEqual([
    true,
    true,
    false,
    false,
    false,
  ]);
  const next = await Promise.all(
    ids.map(async (id) => unwrap(await getNextStepFacts(db, id)).qaConfigured),
  );
  expect(next).toEqual([true, true, false, false, false]);
});

test("a CI gate's progress counts its own reads at the current head only", async () => {
  const db = await world();
  const HEAD = "a".repeat(40);
  unwrap(
    await seedRows(db, {
      repos: ["r1", "r2", "r3"].map((id) => ({
        id,
        name: id,
        mirror_path: `/m/${id}.git`,
      })),
      tickets: [ticket(1, { status: "qa_harness" })],
      gates: [
        gate("g-old", "ticket-1", {
          kind: "qa_harness",
          state: "failed",
          subject_kind: "pull_request",
        }),
        gate("g-ci", "ticket-1", {
          kind: "qa_harness",
          state: "running",
          subject_kind: "pull_request",
          attempt: 2,
        }),
      ],
      deliveries: [
        // Read by the running gate at the head: counted.
        delivery("d1", "r1", {
          ci_gate_id: "g-ci",
          ci_sha: HEAD,
          ci_done: 2,
          ci_total: 5,
        }),
        // Read by the running gate, but a newer commit has been pushed since: not counted.
        delivery("d2", "r2", {
          ci_gate_id: "g-ci",
          ci_sha: "b".repeat(40),
          ci_done: 1,
          ci_total: 1,
        }),
        // Read by the last round's gate: not counted.
        delivery("d3", "r3", {
          ci_gate_id: "g-old",
          ci_sha: HEAD,
          ci_done: 3,
          ci_total: 3,
        }),
      ],
    }),
  );
  expect(unwrap(await getNextStepFacts(db, "ticket-1")).ci).toEqual({
    pulls: 1,
    done: 2,
    total: 5,
  });
});

const delivery = (
  id: string,
  repo_id: string,
  o: Partial<Insertable<DeliveriesTable>> = {},
): Insertable<DeliveriesTable> => ({
  id,
  ticket_id: "ticket-1",
  repo_id,
  branch: "frm/s",
  head_sha: "a".repeat(40),
  state: "pr_open",
  pr_url: `https://forge.test/pull/${id}`,
  pr_number: 1,
  started_at: 1,
  ...o,
});

function fail(): never {
  throw new Error("missing facts");
}

test("what its pull requests say: awaiting, merged, or none", async () => {
  const db = await world();
  unwrap(
    await seedRows(db, {
      repos: ["r1", "r2"].map((id) => ({
        id,
        name: id,
        mirror_path: `/m/${id}.git`,
      })),
      workspaces: [
        { id: "ws-off", name: "off", kind: "single", close_on_merge: 0 },
      ],
      tickets: [
        ticket(1, { id: "t-open", status: "qa_human" }),
        ticket(2, { id: "t-merged", status: "rework" }),
        ticket(3, { id: "t-part", status: "qa_harness" }),
        ticket(4, { id: "t-closed", status: "qa_human" }),
        ticket(5, { id: "t-off", status: "qa_human", workspace_id: "ws-off" }),
        ticket(6, { id: "t-review", status: "code_review" }),
        ticket(7, { id: "t-none", status: "qa_human" }),
        ticket(8, { id: "t-failed", status: "qa_human" }),
      ],
      deliveries: [
        ["t-open", "r1", "pr_open", true],
        ["t-open", "r2", "pushed", false],
        ["t-merged", "r1", "merged", true],
        ["t-part", "r1", "merged", true],
        ["t-part", "r2", "pr_open", true],
        ["t-closed", "r1", "closed", true],
        ["t-off", "r1", "pr_open", true],
        ["t-review", "r1", "pr_open", true],
        ["t-none", "r1", "pushed", false],
        ["t-failed", "r1", "merged", true],
        ["t-failed", "r2", "failed", false],
      ].map(([ticket_id, repo_id, state, pr], i) => ({
        id: `d-${i}`,
        ticket_id: String(ticket_id),
        repo_id: String(repo_id),
        branch: "frm/s",
        state: state as "pr_open",
        pr_url: pr === true ? `https://forge.test/pull/${i}` : null,
        pr_number: pr === true ? i : null,
        started_at: 1,
      })),
    }),
  );
  const ids = [
    "t-open",
    "t-merged",
    "t-part",
    "t-closed",
    "t-off",
    "t-review",
    "t-none",
    "t-failed",
  ];
  const facts = unwrap(await listWaitFacts(db, ids));
  expect(
    Object.fromEntries(ids.map((id) => [id, facts.get(id)?.merge])),
  ).toEqual({
    "t-open": "awaiting",
    "t-merged": "merged",
    "t-part": "none",
    "t-closed": "none",
    "t-off": "none",
    "t-review": "none",
    "t-none": "none",
    "t-failed": "none",
  });
  // The board says what the page says: an open request is what the ticket waits on.
  const open = facts.get("t-open");
  expect(open === undefined ? null : waitingOnYou(open)).toEqual({
    code: "merge",
    reason: "Waiting for the PR to be merged",
  });
  const merged = facts.get("t-merged");
  expect(merged === undefined ? "missing" : waitingOnYou(merged)).toBeNull();
});
