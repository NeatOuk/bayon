import { FakeClock } from "@bayon/core";
import { afterAll, describe, expect, test } from "vitest";
import {
  newRunInput,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
  type SeedRows,
} from "../testing.js";
import {
  hasOpenSystemRequest,
  lastPairOkRunAt,
  listCircuitFacts,
  listSplitAsks,
  listStormPairs,
} from "./watchdog-reads.js";

// The watchdog's reads: the closed lists only; the verdicts are core's.

const T0 = Date.UTC(2026, 8, 14, 12);
const clock = new FakeClock(T0);
const t = unwrap(await tempDb(clock));
unwrap(await seedSpine(t.db, 14));
afterAll(() => t.cleanup());

type SessionSeed = NonNullable<SeedRows["sessions"]>[number];
type RunSeed = NonNullable<SeedRows["runs"]>[number];

let seq = 0;
const session = (id: string, o: Partial<SessionSeed> = {}): SessionSeed => ({
  ...newSessionInput(),
  id,
  state: "exited",
  created_at: 0,
  ...o,
});
const run = (sessionId: string, o: Partial<RunSeed> = {}): RunSeed => {
  seq += 1;
  return {
    ...newRunInput(sessionId),
    id: `run-${seq}`,
    seq,
    state: "failed",
    started_at: T0 - 1,
    ended_at: T0,
    ...o,
  };
};

describe("storm reads", () => {
  test("pairs with at least minCount runner_error failures since `since`, and the last ok run", async () => {
    unwrap(
      await seedRows(t.db, {
        sessions: [session("st-1")],
        runs: [
          run("st-1", { error_class: "runner_error", ended_at: T0 - 10 }),
          run("st-1", { error_class: "runner_error", ended_at: T0 - 5 }),
          run("st-1", { error_class: "timeout", state: "timeout" }),
          run("st-1", { error_class: "runner_error", ended_at: T0 - 999_999 }),
        ],
      }),
    );
    expect(
      unwrap(await listStormPairs(t.db, { since: T0 - 100, minCount: 2 })),
    ).toEqual([{ runnerId: "fixture", executorId: "local", failures: 2 }]);
    expect(
      unwrap(await listStormPairs(t.db, { since: T0 - 100, minCount: 3 })),
    ).toEqual([]);
    const pair = { runnerId: "fixture", executorId: "local" };
    expect(unwrap(await lastPairOkRunAt(t.db, pair))).toBeNull();
    unwrap(
      await seedRows(t.db, {
        runs: [run("st-1", { state: "ok", ended_at: T0 - 3 })],
      }),
    );
    expect(unwrap(await lastPairOkRunAt(t.db, pair))).toBe(T0 - 3);
  });
});

describe("hasOpenSystemRequest", () => {
  test("matches the key's prefix exactly, never as a LIKE pattern, and only open rows", async () => {
    unwrap(
      await seedRows(t.db, {
        human_requests: [
          {
            id: "hr-open",
            kind: "retry_storm",
            question: "q",
            status: "open",
            asked_at: T0,
            dedupe_key: "retry_storm:run_a/local:0",
          },
          {
            id: "hr-answered",
            kind: "retry_storm",
            question: "q",
            status: "answered",
            asked_at: T0,
            dedupe_key: "retry_storm:run_b/local:0",
          },
        ],
      }),
    );
    expect(
      unwrap(await hasOpenSystemRequest(t.db, "retry_storm:run_a/local:")),
    ).toBe(true);
    // `_` would match any character under LIKE: this prefix names another pair.
    expect(
      unwrap(await hasOpenSystemRequest(t.db, "retry_storm:runXa/local:")),
    ).toBe(false);
    expect(
      unwrap(await hasOpenSystemRequest(t.db, "retry_storm:run_b/local:")),
    ).toBe(false);
  });
});

describe("listCircuitFacts", () => {
  test("open, unheld tickets with their reset point, and every raw failure of their holders", async () => {
    unwrap(
      await seedRows(t.db, {
        tickets: [
          ticketRow(101, { status: "building", created_at: T0 - 1_000 }),
          ticketRow(102, { status: "parked" }),
          ticketRow(103, { status: "done" }),
        ],
        sessions: [
          session("c-1", { ticket_id: "ticket-101" }),
          session("c-rv", { ticket_id: "ticket-101", role: "reviewer" }),
          // A failed start: no run, not queued.
          session("c-start", {
            ticket_id: "ticket-101",
            exit_reason: "error",
            error_class: "spawn_failed",
            ended_at: T0 - 50,
          }),
          // Died while queued: the hold's, not the ticket's.
          session("c-queued", {
            ticket_id: "ticket-101",
            exit_reason: "error",
            error_class: "timeout",
            queued_reason: "fleet_paused",
            ended_at: T0 - 40,
          }),
          session("c-parked", { ticket_id: "ticket-102" }),
        ],
        runs: [
          run("c-1", { state: "ok", ended_at: T0 - 500 }),
          run("c-1", { state: "ok", trigger: "handoff", ended_at: T0 - 100 }),
          run("c-1", { error_class: "runner_error", ended_at: T0 - 90 }),
          run("c-1", {
            state: "timeout",
            error_class: "timeout",
            ended_at: T0 - 80,
          }),
          run("c-1", { trigger: "handoff", ended_at: T0 - 70 }),
          run("c-1", { state: "interrupted", ended_at: T0 - 60 }),
          run("c-rv", { ended_at: T0 - 65 }),
          run("c-parked", { ended_at: T0 - 30 }),
        ],
        ticket_events: [
          {
            ticket_id: "ticket-101",
            ts: T0 - 700,
            actor_kind: "operator",
            actor_id: "operator",
            kind: "transition",
            from_status: "blocked",
            to_status: "building",
          },
        ],
      }),
    );
    const facts = unwrap(await listCircuitFacts(t.db));
    const mine = facts.tickets.filter((x) => x.num >= 101 && x.num <= 103);
    // An ok hand-off run is no recovery: the reset is the ok work run at T0-500.
    expect(mine).toEqual([
      { id: "ticket-101", num: 101, status: "building", resetAt: T0 - 500 },
    ]);
    const failures = facts.failures.filter((f) => f.ticketId === "ticket-101");
    expect(
      failures.map((f) => [f.kind, f.state, f.errorClass]).toSorted(),
    ).toEqual([
      ["run", "failed", "runner_error"],
      ["run", "timeout", "timeout"],
      ["start", "exited", "spawn_failed"],
    ]);
    expect(unwrap(await listCircuitFacts(t.db, "ticket-102")).tickets).toEqual(
      [],
    );
  });
});

describe("listSplitAsks", () => {
  test("the split_candidate arm, without held tickets, with each chain's size and degraded count", async () => {
    const handoff = (id: string, ticket: string, quality = "full") => ({
      id,
      ticket_id: ticket,
      reason: "context_ceiling",
      facts_json: "{}",
      quality,
      packet_path: ".foreman/handoff.md",
      packet_hash: "0".repeat(64),
      created_at: T0,
    });
    unwrap(
      await seedRows(t.db, {
        tickets: [
          ticketRow(201, { status: "building" }),
          ticketRow(202, { status: "blocked" }),
        ],
        handoffs: [
          handoff("h1", "ticket-201"),
          handoff("h2", "ticket-201", "degraded"),
          handoff("h3", "ticket-201"),
          handoff("h4", "ticket-201", "degraded"),
          ...["h5", "h6", "h7", "h8"].map((id) => handoff(id, "ticket-202")),
        ],
      }),
    );
    expect(unwrap(await listSplitAsks(t.db))).toEqual([
      {
        ticketId: "ticket-201",
        num: 201,
        status: "building",
        handoffs: 4,
        degraded: 2,
      },
    ]);
  });
});
