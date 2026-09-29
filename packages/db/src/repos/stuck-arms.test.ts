import { FakeClock } from "@bayon/core";
import type { Insertable } from "kysely";
import { afterAll, expect, test } from "vitest";
import type { Db } from "../connection.js";
import type { TicketsTable } from "../schema.js";
import type { FindingsTable, GatesTable } from "../schema-work.js";
import { seedRows, seedSpine, tempDb, ticketRow, unwrap } from "../testing.js";
import { listNeedsAttention } from "./work-views.js";

// The two arms that say why a ticket is stuck (035). `gate_stuck` lists a failed gate
// only while the ticket still waits behind it; `advance_pending` lists a round that passed with the
// ticket still in review. Ages run on the Db's clock (044), so the FakeClock's.

const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

const MINUTE = 60_000;
/** Longer ago than advance_pending's 5-minute grace, on the clock the arms read. */
const settledAt = () => clock.now() - 10 * MINUTE;

async function world(): Promise<Db> {
  const t = unwrap(await tempDb(clock));
  cleanups.push(t.cleanup);
  unwrap(await seedSpine(t.db, 35));
  return t.db;
}

const ticket = (num: number, o: Partial<Insertable<TicketsTable>> = {}) =>
  ticketRow(num, { updated_at: settledAt(), ...o });

const gate = (
  id: string,
  ticket_id: string,
  o: Partial<Insertable<GatesTable>> = {},
): Insertable<GatesTable> => ({
  id,
  ticket_id,
  kind: "code_review",
  state: "passed",
  attempt: 1,
  round: 1,
  subject_kind: "diff",
  subject_ref: "HEAD",
  decided_at: settledAt(),
  ...o,
});

const failedFor = (reason: string) => JSON.stringify({ reason });

const major = (id: string, gate_id: string): Insertable<FindingsTable> => ({
  id,
  gate_id,
  severity: "major",
  summary: id,
  created_at: 0,
});

async function arm(db: Db, why: string): Promise<string[]> {
  return unwrap(await listNeedsAttention(db))
    .filter((r) => r.why === why)
    .map((r) => r.ref);
}

test("gate_stuck: an old failure a newer attempt passed lists nothing", async () => {
  const db = await world();
  unwrap(
    await seedRows(db, {
      tickets: [
        ticket(1, { status: "qa_harness" }),
        ticket(2, { status: "code_review" }),
      ],
      gates: [
        gate("t1-a1", "ticket-1", {
          state: "failed",
          evidence_json: failedFor("no_reviewer"),
        }),
        gate("t1-a2", "ticket-1", { attempt: 2, round: 2 }),
        // The same shape on a ticket still in review: an older failure, a newer waive.
        gate("t2-a1", "ticket-2", {
          state: "failed",
          evidence_json: failedFor("timeout"),
        }),
        gate("t2-a2", "ticket-2", {
          attempt: 2,
          state: "waived",
          waive_reason: "checked",
        }),
      ],
    }),
  );
  expect(await arm(db, "gate_stuck")).toEqual([]);
});

test("gate_stuck: the latest failure is listed while the ticket waits behind it", async () => {
  const db = await world();
  unwrap(
    await seedRows(db, {
      tickets: [
        ticket(1, { status: "code_review" }),
        ticket(2, { status: "plan_review" }),
        ticket(3, { status: "code_review" }),
      ],
      gates: [
        gate("t1-a1", "ticket-1", { state: "passed" }),
        gate("t1-a2", "ticket-1", {
          attempt: 2,
          state: "failed",
          evidence_json: failedFor("no_reviewer"),
        }),
        gate("t2-a1", "ticket-2", {
          kind: "plan_review",
          subject_kind: "plan",
          state: "failed",
          evidence_json: failedFor("reviewer_error"),
        }),
        // A superseded review of a ticket reclaimed into code_review: nothing reopens it.
        gate("t3-a1", "ticket-3", {
          state: "failed",
          evidence_json: failedFor("superseded"),
        }),
      ],
    }),
  );
  expect((await arm(db, "gate_stuck")).sort()).toEqual([
    "t1-a2",
    "t2-a1",
    "t3-a1",
  ]);
});

test("gate_stuck: per repo, a round still deciding, a ticket that moved on and bad evidence", async () => {
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
        ticket(3, { status: "building" }),
        ticket(4, { status: "code_review" }),
      ],
      gates: [
        // Repo ra's latest failed, repo rb's passed at a later attempt: ra's is still the latest of
        // its own (kind, repo).
        gate("t1-ra", "ticket-1", {
          repo_id: "ra",
          state: "failed",
          evidence_json: failedFor("timeout"),
        }),
        gate("t1-rb", "ticket-1", { repo_id: "rb", attempt: 2 }),
        // A failure beside a gate still running: the round has not decided yet.
        gate("t2-cr", "ticket-2", {
          state: "failed",
          evidence_json: failedFor("no_reviewer"),
        }),
        gate("t2-ce", "ticket-2", {
          kind: "ce_review",
          state: "running",
          started_at: clock.now(),
        }),
        // The ticket moved on past a failed plan review: it holds nothing now.
        gate("t3-pr", "ticket-3", {
          kind: "plan_review",
          subject_kind: "plan",
          state: "failed",
        }),
        // Evidence that is not JSON never breaks the view.
        gate("t4-cr", "ticket-4", {
          state: "failed",
          evidence_json: "{not json",
        }),
      ],
    }),
  );
  expect((await arm(db, "gate_stuck")).sort()).toEqual(["t1-ra", "t4-cr"]);
});

test("gate_stuck: a gate running past the gate clock is listed as before", async () => {
  const db = await world();
  unwrap(
    await seedRows(db, {
      tickets: [ticket(1, { status: "code_review" })],
      gates: [
        gate("hung", "ticket-1", {
          state: "running",
          started_at: clock.now() - 20 * MINUTE,
        }),
        gate("fresh", "ticket-1", {
          kind: "ce_review",
          state: "running",
          started_at: clock.now(),
        }),
      ],
    }),
  );
  expect(await arm(db, "gate_stuck")).toEqual(["hung"]);
});

test("advance_pending: a round that passed with the ticket still in review", async () => {
  const db = await world();
  unwrap(
    await seedRows(db, {
      tickets: [
        ticket(1, { status: "code_review" }),
        ticket(2, { status: "plan_review", non_trivial: 1 }),
        ticket(3, { status: "code_review", non_trivial: 1 }),
      ],
      gates: [
        gate("t1-old", "ticket-1", {
          state: "failed",
          evidence_json: failedFor("no_reviewer"),
        }),
        gate("t1-cr", "ticket-1", { attempt: 2, round: 2 }),
        // A trivial ticket's ce_review of an older round is not this round's, and not owed.
        gate("t1-ce", "ticket-1", { kind: "ce_review", state: "failed" }),
        gate("t2-pr", "ticket-2", {
          kind: "plan_review",
          subject_kind: "plan",
          state: "waived",
        }),
        gate("t3-cr", "ticket-3"),
        gate("t3-ce", "ticket-3", { kind: "ce_review" }),
      ],
    }),
  );
  expect((await arm(db, "advance_pending")).sort()).toEqual([
    "ticket-1",
    "ticket-2",
    "ticket-3",
  ]);
});

test("advance_pending: not within the grace, not while a gate runs, not when the round is owed", async () => {
  const db = await world();
  unwrap(
    await seedRows(db, {
      tickets: [
        ticket(1, { status: "code_review" }),
        ticket(2, { status: "code_review" }),
        ticket(3, { status: "code_review", non_trivial: 1 }),
        ticket(4, { status: "code_review" }),
        ticket(5, { status: "qa_harness" }),
        ticket(6, { status: "building" }),
        ticket(7, { status: "code_review", updated_at: clock.now() }),
      ],
      gates: [
        // Just decided: foreman's own step has not had its chance yet.
        gate("t1-cr", "ticket-1", { decided_at: clock.now() }),
        gate("t2-cr", "ticket-2"),
        gate("t2-lint", "ticket-2", {
          kind: "lint_check",
          state: "running",
          started_at: clock.now(),
        }),
        // Non-trivial and no ce_review in the round: pass_review would refuse it.
        gate("t3-cr", "ticket-3"),
        // Failed on the code: that is request_fix's, and gate_stuck's, not this arm's.
        gate("t4-cr", "ticket-4", {
          state: "failed",
          evidence_json: failedFor("blocking_findings"),
        }),
        // qa_harness with no QA gate at all (M7.5): nothing to have passed.
        gate("t6-cr", "ticket-6"),
        // Updated since: the ticket itself moved within the grace (back from blocked).
        gate("t7-cr", "ticket-7"),
      ],
      findings: [major("f-4", "t4-cr")],
    }),
  );
  expect(await arm(db, "advance_pending")).toEqual([]);
});
