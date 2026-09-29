// The M4 smoke's kill-switch step as a test ("Done when"; spec "Amendments — M4", §16):
// the built API as a child process on the same database, and a lifecycle on the fixture runner.
// Pause with a gated run in flight → a new spawn is queued fleet_paused and a new turn is refused
// → the in-flight turn ends ok → resume admits the queued spawn; the audit rows exist.
import { FakeClock } from "@bayon/core";
import { getSession, listRuns, type SessionRow } from "@bayon/db";
import { listAudit, seedRows, tempDb, unwrap } from "@bayon/db/testing";
import { SlotCounter } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import { FleetPauseState } from "@bayon/proto";
import type { RunnerAdapter, SessionHandle } from "@bayon/runners";
import {
  createFixtureAdapter,
  FIXTURE_PROGRAM,
  fixtureProgram,
  type FixtureScriptInput,
} from "@bayon/runners/fixture";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import {
  admissionRows,
  operatorRun,
  T0,
  WAIT,
} from "./testing/admission-world.js";
import { buildApi, startApiChild } from "./testing/api-child.js";
import {
  CMD,
  EXECUTOR_ID,
  spawnPayload,
  startLifecycle,
  tempHome,
} from "./testing/fixtures.js";

const TOKEN = "kill-switch-operator-token-0123456789";
const TURN = { kind: "turn_start", runner_type: "fixture.step", payload: {} };
/** Every run waits at its gate for a release: a turn held in flight. */
const GATED: FixtureScriptInput = {
  runs: [{ events: [TURN], gate: "release" }],
};
/** 012's admission.recheck_ms. */
const RECHECK_MS = 5_000;

const cleanups: (() => Promise<void> | void)[] = [];
beforeAll(buildApi, 180_000);
afterAll(async () => {
  for (const cleanup of cleanups.toReversed()) await cleanup();
});

test(
  "pause with a gated run in flight: a new spawn queues fleet_paused, a new turn is refused, the turn in flight ends ok, resume admits the spawn; audited",
  { timeout: 120_000 },
  async () => {
    const clock = new FakeClock(T0);
    const t = unwrap(await tempDb(clock));
    const home = tempHome("frm-ks-");
    cleanups.push(() => {
      t.cleanup();
      home.cleanup();
    });
    // Two sessions of one agent at once: concurrency is not the gate under test.
    unwrap(
      await seedRows(
        t.db,
        admissionRows({ rows: { script: GATED, maxConcurrency: 2 } }),
      ),
    );
    const api = await startApiChild({
      home: home.path,
      dbPath: t.path,
      token: TOKEN,
    });
    cleanups.push(() => api.stop());
    const origin = new URL(api.mcpUrl).origin;
    const post = async (path: string) => {
      const res = await fetch(`${origin}/api/v1${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(200);
      return FleetPauseState.parse(await res.json());
    };

    const slots = new SlotCounter(4);
    const fixture = createFixtureAdapter({ command: [FIXTURE_PROGRAM], clock });
    // The fixture keys its processes by handle: keep each session's, to release its gate.
    const handles = new Map<string, SessionHandle>();
    const adapter: RunnerAdapter = {
      ...fixture,
      spawn: async (spec, ex) => {
        const spawned = await fixture.spawn(spec, ex);
        if (spawned.ok) handles.set(spec.sessionId, spawned.value);
        return spawned;
      },
    };
    const { lifecycle } = await startLifecycle({
      db: t.db,
      clock,
      frmHome: home.path,
      executor: new FakeExecutor({
        id: EXECUTOR_ID,
        slots,
        programs: { [FIXTURE_PROGRAM]: fixtureProgram, ok: () => 0 },
      }),
      slots,
      adapter,
    });
    cleanups.push(async () => {
      for (const id of ["A", "B"]) await lifecycle.stop(id, "kill");
      await lifecycle.shutdown();
    });
    const session = async (id: string): Promise<SessionRow> =>
      unwrap(await getSession(t.db, id));
    const until = (id: string, match: Partial<SessionRow>) =>
      vi.waitFor(async () => {
        await lifecycle.settled();
        expect(await session(id)).toMatchObject(match);
      }, WAIT);
    const recheck = async () => {
      await clock.advance(RECHECK_MS);
      await lifecycle.settled();
    };

    // A's run 1 is in flight, held at its gate (a spawn with no prompt idles first).
    unwrap(await lifecycle.handlers.spawn.handle(spawnPayload("A"), CMD));
    await until("A", { state: "idle" });
    unwrap(await lifecycle.startRun("A", operatorRun(1)));
    await until("A", { state: "running" });

    expect(await post("/fleet/pause")).toMatchObject({
      paused: true,
      changed: true,
    });

    // A new spawn waits behind the pause.
    unwrap(await lifecycle.handlers.spawn.handle(spawnPayload("B"), CMD));
    await until("B", { state: "pending", queued_reason: "fleet_paused" });

    // The turn in flight finishes: pause never cuts one.
    const a = handles.get("A");
    if (a === undefined) throw new Error("session A has no handle");
    unwrap(await fixture.release(a));
    await until("A", { state: "idle" });
    expect(unwrap(await listRuns(t.db, "A")).map((r) => r.state)).toEqual([
      "ok",
    ]);

    // A new turn is refused while paused; the queued spawn still waits after a recheck.
    expect(await lifecycle.startRun("A", operatorRun(2))).toMatchObject({
      ok: false,
      error: { class: "admission_refused", cause: { gate: "fleet_paused" } },
    });
    await recheck();
    expect(await session("B")).toMatchObject({
      state: "pending",
      queued_reason: "fleet_paused",
    });

    // Resume: the next recheck admits it.
    expect(await post("/fleet/resume")).toMatchObject({
      paused: false,
      changed: true,
    });
    await recheck();
    await until("B", { state: "idle", queued_reason: null });

    const fleetRows = unwrap(await listAudit(t.db)).filter((r) =>
      r.action.startsWith("fleet."),
    );
    expect(
      fleetRows.map((r) => [r.actor, r.action, r.target_id, r.payload_json]),
    ).toEqual([
      [
        "operator",
        "fleet.pause",
        "fleet.paused",
        JSON.stringify({ via: "rest" }),
      ],
      [
        "operator",
        "fleet.resume",
        "fleet.paused",
        JSON.stringify({ via: "rest" }),
      ],
    ]);
  },
);
