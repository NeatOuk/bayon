import { FakeClock, ok, type ExitReason, type SessionState } from "@bayon/core";
import type { Compilable } from "kysely";
import { afterAll, describe, expect, test } from "vitest";
import { execute, qb, write, type Db } from "../connection.js";
import {
  SPINE_SEED,
  newRunInput,
  newSessionInput,
  seedSpine,
  tempDb,
  unwrap,
} from "../testing.js";
import {
  DAILY_CAP_KEY,
  ERRORED_WITHIN_MS,
  STALE_AFTER_MS,
  getFleetOverview,
} from "./fleet-overview.js";
import { appendRun } from "./runs.js";
import { createSession } from "./sessions.js";
import { insertSpend } from "./spend.js";

const MIDNIGHT = Date.UTC(2026, 8, 13);
const NOW = MIDNIGHT + 10 * 60 * 60_000; // 10:00 UTC
const HOUR = 60 * 60_000;

const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function fresh(): Promise<Db> {
  const t = unwrap(await tempDb(new FakeClock(NOW)));
  cleanups.push(t.cleanup);
  unwrap(await seedSpine(t.db, 2));
  return t.db;
}

const exec = async (db: Db, query: Compilable<unknown>) =>
  unwrap(
    await write(db, (ix) => {
      execute(ix, query);
      return ok(undefined);
    }),
  );

async function session(
  db: Db,
  id: string,
  set: {
    readonly state: SessionState;
    readonly executor_id?: string;
    readonly last_event_at?: number;
    readonly ended_at?: number;
    readonly exit_reason?: ExitReason;
    readonly error_message?: string;
  },
): Promise<void> {
  const { executor_id, ...rest } = set;
  unwrap(
    await createSession(db, {
      ...newSessionInput(),
      id,
      ...(executor_id === undefined ? {} : { executor_id }),
    }),
  );
  await exec(db, qb.updateTable("sessions").set(rest).where("id", "=", id));
}

async function spend(db: Db, costUsd: number, ts: number): Promise<void> {
  const run = unwrap(await appendRun(db, newRunInput(SPINE_SEED.sessionId)));
  unwrap(
    await insertSpend(db, {
      run_id: run.id,
      session_id: SPINE_SEED.sessionId,
      phase: SPINE_SEED.runClass,
      runner_id: SPINE_SEED.runnerId,
      model: "model-a",
      cost_usd: costUsd,
      cost_source: "reported",
      ts,
    }),
  );
}

const setCap = (db: Db, valueJson: string) =>
  exec(
    db,
    qb
      .updateTable("settings")
      .set({ value_json: valueJson })
      .where("key", "=", DAILY_CAP_KEY),
  );

describe("budget", () => {
  test("today is the current UTC day by the Db's clock; the seeded cap is null", async () => {
    const db = await fresh();
    await spend(db, 1, MIDNIGHT - 1); // yesterday
    await spend(db, 2, MIDNIGHT);
    await spend(db, 0.5, NOW);
    await spend(db, 4, MIDNIGHT + 24 * HOUR); // tomorrow
    expect(unwrap(await getFleetOverview(db)).budget).toEqual({
      today_usd: 2.5,
      daily_cap_usd: null,
    });
  });

  test("no spend today is 0", async () => {
    const db = await fresh();
    expect(unwrap(await getFleetOverview(db)).budget.today_usd).toBe(0);
  });

  test("the cap comes from settings.budget.daily_cap_usd", async () => {
    const db = await fresh();
    await setCap(db, "40");
    expect(unwrap(await getFleetOverview(db)).budget.daily_cap_usd).toBe(40);
  });

  test("a missing cap row is no cap; a malformed one is an internal error", async () => {
    const db = await fresh();
    await exec(db, qb.deleteFrom("settings").where("key", "=", DAILY_CAP_KEY));
    expect(unwrap(await getFleetOverview(db)).budget.daily_cap_usd).toBeNull();
    const other = await fresh();
    for (const bad of ['"forty"', "-1", "{"]) {
      await setCap(other, bad);
      expect(await getFleetOverview(other)).toMatchObject({
        ok: false,
        error: { class: "internal" },
      });
    }
  });
});

test("slots: live sessions per executor against executors.slots", async () => {
  const db = await fresh(); // the spine's idle session is on "local" (4 slots)
  await exec(
    db,
    qb.insertInto("executors").values([
      // One insert takes the union of the rows' columns: every row names them all.
      { id: "ctr", kind: "container", config_json: "{}", slots: 8, enabled: 1 },
      { id: "off", kind: "remote", config_json: "{}", slots: 2, enabled: 0 },
      { id: "drain", kind: "remote", config_json: "{}", slots: 2, enabled: 0 },
    ]),
  );
  await session(db, "on-drain", { state: "running", executor_id: "drain" });
  await session(db, "gone", { state: "exited", executor_id: "ctr" });
  expect(unwrap(await getFleetOverview(db)).slots).toEqual([
    { executor_id: "ctr", busy: 0, capacity: 8 },
    { executor_id: "drain", busy: 1, capacity: 2 },
    { executor_id: "local", busy: 1, capacity: 4 },
  ]);
});

test("attention: error exits in the last 24 h, then running or idle sessions quiet for 30 min", async () => {
  const db = await fresh(); // the spine's session is idle with no event: not stale
  const quiet = NOW - STALE_AFTER_MS;
  await session(db, "stale", { state: "running", last_event_at: quiet - 1 });
  await session(db, "stale-idle", { state: "idle", last_event_at: quiet - 2 });
  await session(db, "edge", { state: "running", last_event_at: quiet });
  await session(db, "waiting", {
    state: "awaiting_approval",
    last_event_at: quiet - 1,
  });
  const exited = (ended: number, reason: ExitReason) => ({
    state: "exited" as const,
    ended_at: ended,
    exit_reason: reason,
    error_message: `${reason} at ${ended}`,
  });
  await session(db, "crashed", exited(NOW - HOUR, "error"));
  await session(db, "crashed-late", exited(NOW - 2 * HOUR, "error"));
  await session(db, "old", exited(NOW - ERRORED_WITHIN_MS - 1, "error"));
  await session(db, "clean", exited(NOW - HOUR, "ok"));
  await session(db, "killed", exited(NOW - HOUR, "killed"));

  const agent = SPINE_SEED.agentName;
  expect(unwrap(await getFleetOverview(db)).attention).toEqual([
    {
      session_id: "crashed",
      agent,
      why: "errored",
      since: NOW - HOUR,
      detail: `error at ${NOW - HOUR}`,
    },
    {
      session_id: "crashed-late",
      agent,
      why: "errored",
      since: NOW - 2 * HOUR,
      detail: `error at ${NOW - 2 * HOUR}`,
    },
    {
      session_id: "stale-idle",
      agent,
      why: "stale",
      since: quiet - 2,
      detail: null,
    },
    {
      session_id: "stale",
      agent,
      why: "stale",
      since: quiet - 1,
      detail: null,
    },
  ]);
});
