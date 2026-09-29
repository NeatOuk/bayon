import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import type { Db } from "../connection.js";
import {
  SPINE_SEED,
  newRunInput,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "../testing.js";
import { setBudgetCap } from "./budget.js";
import { PROBE_QUERY_IDS, runProbeQuery } from "./probe-queries.js";
import { appendRun } from "./runs.js";
import { insertSpend } from "./spend.js";
import { getTicket } from "./tickets.js";
import { listNeedsAttention } from "./work-views.js";

// The named queries sql probes run. The attention queries' age thresholds are the
// view's, read at the Db's clock (044), so their rows are aged against the FakeClock.
const clock = new FakeClock(1_700_000_000_000);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

const HOUR = 3_600_000;
const HASH = "0".repeat(64);

async function seeded(): Promise<Db> {
  const t = unwrap(await tempDb(clock));
  cleanups.push(t.cleanup);
  unwrap(await seedSpine(t.db, 4));
  unwrap(await seedRows(t.db, { tickets: [ticketRow(1)] }));
  return t.db;
}

const subjects = async (db: Db, id: string) =>
  unwrap(await runProbeQuery(db, id)).map((f) => f.subject);

test("the four seeded sql probes each name a query", () => {
  expect(PROBE_QUERY_IDS).toEqual([
    "stale_sessions",
    "handoff_pending",
    "gate_health",
    "budget",
  ]);
});

test("an id that names no query is refused, and SQL passed as an id never runs", async () => {
  const db = await seeded();
  for (const id of [
    "DELETE FROM tickets",
    "stale_sessions; DROP TABLE tickets",
    "toString",
    "",
  ]) {
    expect(await runProbeQuery(db, id)).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
  }
  expect(unwrap(await getTicket(db, "ticket-1")).title).toBe("ticket 1");
});

test("stale_sessions: live sessions silent for 30 min, from the view's stale arm", async () => {
  const db = await seeded();
  const now = clock.now();
  const session = (
    id: string,
    state: "idle" | "running" | "exited",
    ago: number,
  ) => ({
    ...newSessionInput(),
    id,
    state,
    last_event_at: now - ago,
    created_at: 0,
  });
  unwrap(
    await seedRows(db, {
      sessions: [
        session("s-stale", "idle", 2 * HOUR),
        session("s-fresh", "running", 60_000),
        session("s-ended", "exited", 2 * HOUR),
      ],
    }),
  );
  const [only, ...rest] = unwrap(await runProbeQuery(db, "stale_sessions"));
  expect(rest).toEqual([]);
  expect(only).toEqual({
    subject: "s-stale",
    facts: {
      session_id: "s-stale",
      agent_id: SPINE_SEED.agentId,
      ticket_id: null,
      role: "builder",
      state: "idle",
      last_event_at: now - 2 * HOUR,
    },
  });
});

test("handoff_pending: unaccepted hand-offs, exactly the view's arm", async () => {
  const db = await seeded();
  const handoff = (
    id: string,
    o: { accepted_at?: number; quality?: string },
  ) => ({
    id,
    ticket_id: "ticket-1",
    reason: "turn_ceiling",
    facts_json: "{}",
    packet_path: `.foreman/${id}.md`,
    packet_hash: HASH,
    created_at: 10,
    ...o,
  });
  unwrap(
    await seedRows(db, {
      handoffs: [
        handoff("h-pending", {}),
        handoff("h-accepted", { accepted_at: 20 }),
        // A packet still being written: migration 005 drops it from the view's arm,
        // and the query follows the view, so the parity below holds before and after 005.
        handoff("h-writing", { quality: "writing" }),
      ],
    }),
  );
  const found = await subjects(db, "handoff_pending");
  expect(found).toContain("h-pending");
  expect(found).not.toContain("h-accepted");
  const arm = unwrap(await listNeedsAttention(db))
    .filter((row) => row.why === "handoff_pending")
    .map((row) => row.ref);
  expect(found.toSorted()).toEqual(arm.toSorted());
});

test("gate_health: gates running past 15 min, and a failed gate its ticket still waits behind (035)", async () => {
  const db = await seeded();
  expect(await subjects(db, "gate_health")).toEqual([]);
  // A ticket in review whose latest attempt failed, nothing of it running.
  unwrap(
    await seedRows(db, {
      tickets: [ticketRow(2, { status: "code_review" })],
      gates: [
        {
          id: "g-failed",
          ticket_id: "ticket-2",
          kind: "code_review",
          attempt: 1,
          state: "failed",
          subject_kind: "diff",
          subject_ref: "main..head",
          started_at: clock.now() - 60_000,
        },
      ],
    }),
  );
  const now = clock.now();
  const gate = (
    id: string,
    attempt: number,
    state: "running" | "passed" | "failed",
    started_at: number,
  ) => ({
    id,
    ticket_id: "ticket-1",
    kind: "code_review" as const,
    attempt,
    state,
    subject_kind: "diff",
    subject_ref: "main..head",
    started_at,
  });
  unwrap(
    await seedRows(db, {
      gates: [
        // An older failure a newer attempt answered is history, not a stall.
        gate("g-old", 1, "failed", now - 60_000),
        gate("g-slow", 2, "running", now - HOUR),
        gate("g-running", 3, "running", now - 60_000),
        gate("g-passed", 4, "passed", now - HOUR),
      ],
    }),
  );
  expect(await subjects(db, "gate_health")).toEqual(["g-slow", "g-failed"]);
});

test("budget: a finding once today's spend reaches the daily cap, keyed by the UTC day", async () => {
  const db = await seeded();
  expect(await subjects(db, "budget")).toEqual([]); // no cap, no spend
  const run = unwrap(await appendRun(db, newRunInput(SPINE_SEED.sessionId)));
  unwrap(
    await insertSpend(db, {
      run_id: run.id,
      session_id: SPINE_SEED.sessionId,
      phase: "build",
      runner_id: SPINE_SEED.runnerId,
      model: "fixture",
      cost_usd: 1.5,
      cost_source: "reported",
    }),
  );
  unwrap(await setBudgetCap(db, 2, "operator"));
  expect(await subjects(db, "budget")).toEqual([]); // under the cap
  unwrap(await setBudgetCap(db, 1, "operator"));
  const [finding, ...rest] = unwrap(await runProbeQuery(db, "budget"));
  expect(rest).toEqual([]);
  expect(finding).toMatchObject({
    subject: "over_cap:2023-11-14",
    facts: { today_usd: 1.5, daily_cap_usd: 1 },
  });
});

test("budget: the burn alarm files on a rise only, never on a drop", async () => {
  const DAY = 24 * HOUR;
  const now = clock.now();
  const at = async (db: Db, cost_usd: number, ts: number) => {
    const run = unwrap(await appendRun(db, newRunInput(SPINE_SEED.sessionId)));
    unwrap(
      await insertSpend(db, {
        run_id: run.id,
        session_id: SPINE_SEED.sessionId,
        phase: "build",
        runner_id: SPINE_SEED.runnerId,
        model: "fixture",
        cost_usd,
        cost_source: "reported",
        ts,
      }),
    );
  };
  /** $10 a day for the 30 days before the last one, then `lastDayUsd` in the last hour. */
  const steady = async (lastDayUsd: number | null): Promise<Db> => {
    const db = await seeded();
    for (let k = 1; k <= 30; k += 1)
      await at(db, 10, now - k * DAY - 12 * HOUR);
    if (lastDayUsd !== null) await at(db, lastDayUsd, now - HOUR);
    return db;
  };
  const alarms = (subjects: readonly string[]) =>
    subjects.filter((s) => s.startsWith("burn_alarm:"));

  // A quiet last day is a −100 % drop: news, not an alarm, so no finding.
  expect(alarms(await subjects(await steady(null), "budget"))).toEqual([]);
  // A rise past the 25 % threshold files exactly one.
  expect(alarms(await subjects(await steady(20), "budget"))).toEqual([
    "burn_alarm:2023-11-14",
  ]);
});
