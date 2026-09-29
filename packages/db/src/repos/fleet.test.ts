import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { internalsOf } from "../connection.js";
import { SPINE_SEED, seedSpine, tempDb, unwrap } from "../testing.js";
import { getFleet, heartbeat, readHeartbeat } from "./fleet.js";

const T0 = 1_700_000_000_000;
const clock = new FakeClock(T0);
const t = unwrap(await tempDb(clock));
unwrap(await seedSpine(t.db, 2));
afterAll(() => t.cleanup());

test("getFleet returns v_fleet's columns, its project and its ticket's key for live sessions", async () => {
  const [row, ...rest] = unwrap(await getFleet(t.db));
  expect(rest).toEqual([]);
  // idle_ms is left out: v_fleet reads the wall clock through unixepoch().
  expect(Object.keys(row ?? {}).toSorted()).toEqual(
    [
      "agent",
      "cost_usd",
      "executor_id",
      "id",
      "idle_ms",
      "model_tier",
      "role",
      "run_class",
      "runner_id",
      "state",
      "ticket",
      "ticket_key",
      "title",
      "turns",
      "workspace_id",
    ].toSorted(),
  );
  expect(row).toMatchObject({
    id: SPINE_SEED.sessionId,
    agent: SPINE_SEED.agentName,
    run_class: SPINE_SEED.runClass,
    state: "idle",
    runner_id: SPINE_SEED.runnerId,
    executor_id: SPINE_SEED.executorId,
    ticket: null,
    ticket_key: null,
    title: null,
    turns: 0,
    cost_usd: 0,
    workspace_id: null,
  });
});

test("readHeartbeat is null until the supervisor beats, then the latest beat", async () => {
  expect(unwrap(await readHeartbeat(t.db))).toBeNull();
  unwrap(await heartbeat(t.db, { pid: 42, version: "0.1.0", startedAt: T0 }));
  await clock.advance(5_000);
  unwrap(await heartbeat(t.db, { pid: 42, version: "0.1.0", startedAt: T0 }));
  expect(unwrap(await readHeartbeat(t.db))).toEqual({
    pid: 42,
    version: "0.1.0",
    startedAt: T0,
    at: T0 + 5_000,
  });
});

test("a corrupt heartbeat row is an internal error, not a throw", async () => {
  const { raw } = unwrap(internalsOf(t.db));
  raw
    .prepare(
      "UPDATE supervisor_state SET value_json = ? WHERE key = 'supervisor.heartbeat'",
    )
    .run('{"pid":"not a number"}');
  expect(await readHeartbeat(t.db)).toMatchObject({
    ok: false,
    error: { class: "internal" },
  });
});
