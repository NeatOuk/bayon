// The drain's ordering and ownership (design, the architect's CRITICAL-1, HIGH-1,
// MEDIUM-1..3, MEDIUM-A, LOW-B) and mayStartTurn (§4), on 012's real defaults.
import { FakeClock, ok, TEMPLATES } from "@bayon/core";
import type { Db } from "@bayon/db";
import { updateSessionState } from "@bayon/db/supervisor";
import {
  seedRows,
  tempDb,
  ticketRow,
  unwrap,
  updateRowForTest,
  type EditableTable,
  type RowPatch,
  type SeedRows,
} from "@bayon/db/testing";
import { afterAll, expect, test, vi } from "vitest";
import {
  admissionRows,
  operatorRun,
  SECOND,
  startAdmission,
  T0,
  WAIT,
  type WorldOptions,
} from "./testing/admission-world.js";
import { AGENT_ID, EXECUTOR_ID } from "./testing/fixtures.js";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/** A seeded temp database and its lifecycle, plus the operator's edits a test makes mid-run. */
async function world(o: WorldOptions & { readonly extra?: SeedRows } = {}) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  unwrap(await seedRows(t.db, { ...admissionRows(o), ...o.extra }));
  const w = await startAdmission(t.db, clock, o);
  cleanups.push(async () => {
    await w.shutdown();
    t.cleanup();
  });
  return {
    ...w,
    setting: (key: string, value: number) =>
      seedRows(t.db, {
        settings: [{ key, value_json: JSON.stringify(value), updated_at: T0 }],
      }),
    edit: <T extends EditableTable>(table: T, id: string, patch: RowPatch<T>) =>
      updateRowForTest(t.db, table, id, patch),
    seed: (more: SeedRows) => seedRows(t.db, more),
  };
}

const refusedBy = (gate: string, retryable: boolean) => ({
  ok: false,
  error: { class: "admission_refused", retryable, cause: { gate } },
});

test("CRITICAL-1: queued `unhealthy`, a reconcile pass completes; health back, the session is admitted", async () => {
  const w = await world({ rows: { healthArgv: ["fail"] } });
  unwrap(await w.spawn("H"));
  await w.until("H", { state: "pending", queued_reason: "unhealthy" });
  // Nothing parks on the session's queue: the pass and settled() both finish.
  await w.lifecycle.reconcile();
  await w.lifecycle.settled();
  expect((await w.session("H")).state).toBe("pending");
  unwrap(
    await w.edit("executors", EXECUTOR_ID, {
      config_json: JSON.stringify({ healthArgv: ["ok"] }),
    }),
  );
  await w.lifecycle.reconcile();
  await w.until("H", { state: "idle", queued_reason: null });
});

test("HIGH-1: a reviewer of its builder's own agent at max_concurrency=1 is admitted past the concurrency queue", async () => {
  const w = await world({
    extra: {
      tickets: [ticketRow(1)],
      gates: [
        {
          id: "g-1",
          ticket_id: "ticket-1",
          kind: "ce_review",
          state: "running",
          attempt: 1,
          subject_kind: "diff",
          subject_ref: "unpinned",
          started_at: T0,
        },
      ],
    },
  });
  unwrap(await w.spawn("BLD"));
  await w.until("BLD", { state: "idle" });
  unwrap(await w.spawn("BLD2"));
  await w.until("BLD2", { state: "pending", queued_reason: "concurrency" });
  unwrap(
    await w.lifecycle.spawnInternal({
      payload: {
        session_id: "RV",
        agent_id: AGENT_ID,
        role: "reviewer",
        run_class: "review",
        ticket_id: "ticket-1",
      },
      run: {
        seq: 1,
        trigger: "gate",
        template: TEMPLATES.operator,
        inputs: { task: "review" },
      },
      workspace: "none",
      gate: { id: "g-1", fallbackFrom: null },
    }),
  );
  await w.until("RV", { state: "idle" });
  expect((await w.session("BLD2")).state).toBe("pending");
});

test("MEDIUM-1: an admit CAS lost to a competing move releases the drain's slot: `used` unchanged", async () => {
  const ref: { db?: Db } = {};
  const w = await world({
    hooks: {
      beforeAdmit: async (id) => {
        if (ref.db === undefined) return;
        unwrap(
          await updateSessionState(ref.db, id, {
            from: ["pending"],
            to: "exited",
            patch: { exit_reason: "killed" },
          }),
        );
      },
    },
  });
  ref.db = w.db;
  unwrap(await w.spawn("X"));
  await w.until("X", { state: "exited" });
  expect(w.slots.capacity().used).toBe(0);
  expect(
    w.logs.some((l) =>
      l.msg.startsWith("admission: another op moved the session first"),
    ),
  ).toBe(true);
});

test("MEDIUM-A: a stop while the admit CAS is awaited gives exactly one end, killed; `used` unchanged", async () => {
  const ref: { stop?: (id: string) => Promise<void> } = {};
  const w = await world({
    hooks: { beforeAdmit: async (id) => ref.stop?.(id) },
  });
  ref.stop = (id) => w.stop(id, "kill");
  unwrap(await w.spawn("Y"));
  await w.until("Y", { state: "exited", exit_reason: "killed" });
  await vi.waitFor(async () => {
    await w.lifecycle.settled();
    expect(w.ended.filter((id) => id === "Y")).toHaveLength(1);
  }, WAIT);
  expect(w.slots.capacity().used).toBe(0);
});

test("MEDIUM-2: FIFO per resource; another executor's spawn passes the queue; a fresh spawn waits behind it", async () => {
  // Several live sessions of one agent on purpose: this test is about each executor's slots.
  const w = await world({
    slots: 1,
    second: true,
    rows: { maxConcurrency: 6 },
  });
  unwrap(await w.spawn("A0"));
  await w.until("A0", { state: "idle" });
  unwrap(await w.spawn("A"));
  unwrap(await w.spawn("B"));
  await w.until("A", { state: "pending", queued_reason: "slot" });
  await w.until("B", { state: "pending", queued_reason: "slot" });
  unwrap(await w.spawn("D", { executor_id: SECOND }));
  await w.until("D", { state: "idle" });
  unwrap(await w.spawn("E"));
  await w.until("E", { state: "pending", queued_reason: "slot" });
  await w.stop("A0", "kill");
  await w.until("A", { state: "idle" });
  expect((await w.session("B")).state).toBe("pending");
  await w.stop("A", "kill");
  await w.until("B", { state: "idle" });
  expect((await w.session("E")).state).toBe("pending");
});

test("MEDIUM-3: a re-delivered session.spawn for a running session returns its id and runs no gate", async () => {
  const w = await world();
  unwrap(await w.spawn("R"));
  await w.until("R", { state: "idle" });
  unwrap(await w.setting("fleet.paused", 1));
  expect(await w.spawn("R")).toEqual(ok({ session_id: "R" }));
  await w.lifecycle.settled();
  expect(await w.session("R")).toMatchObject({
    state: "idle",
    queued_reason: null,
  });
});

test("LOW-B: two deliveries of one session.spawn at once make one session, admitted once", async () => {
  const w = await world();
  unwrap(await w.setting("fleet.paused", 1));
  const both = await Promise.all([w.spawn("T"), w.spawn("T")]);
  expect(both).toEqual([ok({ session_id: "T" }), ok({ session_id: "T" })]);
  unwrap(await w.setting("fleet.paused", 0));
  await w.recheck();
  await w.until("T", { state: "idle" });
  const admitted = w.logs.filter(
    (l) =>
      l.msg === "admitted" &&
      (l.obj as { readonly sessionId?: string }).sessionId === "T",
  );
  expect(admitted).toHaveLength(1);
});

test("mayStartTurn: paused, a live session's run is refused (fleet_paused, retryable), its first send too; resumed, it runs", async () => {
  const w = await world();
  // Spawned without a prompt: idle, no run yet. Its first send is seq 1, and a new turn.
  unwrap(await w.spawn("S"));
  await w.until("S", { state: "idle" });
  unwrap(await w.setting("fleet.paused", 1));
  expect(await w.lifecycle.startRun("S", operatorRun(1))).toMatchObject(
    refusedBy("fleet_paused", true),
  );
  unwrap(await w.setting("fleet.paused", 0));
  expect(unwrap(await w.lifecycle.startRun("S", operatorRun(1)))).toMatchObject(
    { seq: 1 },
  );
});

test("mayStartTurn: a spent budget refuses a live session's run (budget, retryable); a hand-off packet's kind never is", async () => {
  const w = await world();
  unwrap(await w.spawn("S"));
  await w.until("S", { state: "idle" });
  // The operator's agent budget, spent at once (a 0-token cap), lands after the spawn.
  unwrap(
    await w.seed({
      budgets: [
        {
          id: "b-agent",
          scope: "agent",
          scope_ref: AGENT_ID,
          period: "month",
          cap_tokens: 0,
          updated_at: T0,
        },
      ],
    }),
  );
  expect(await w.lifecycle.startRun("S", operatorRun(1))).toMatchObject(
    refusedBy("budget", true),
  );
  expect(
    unwrap(
      await w.lifecycle.startRun("S", operatorRun(1, { turn: "handoff" })),
    ),
  ).toMatchObject({ seq: 1 });
});

test("mayStartTurn: an unhealthy executor never refuses a live session's run", async () => {
  const w = await world();
  unwrap(await w.spawn("S"));
  await w.until("S", { state: "idle" });
  unwrap(
    await w.edit("executors", EXECUTOR_ID, {
      config_json: JSON.stringify({ healthArgv: ["fail"] }),
    }),
  );
  await w.lifecycle.reconcile();
  expect(unwrap(await w.lifecycle.startRun("S", operatorRun(1)))).toMatchObject(
    { seq: 1 },
  );
});

test("mayStartTurn: paused, a run of kind `handoff` (the packet's) is never held", async () => {
  const w = await world();
  unwrap(await w.spawn("S"));
  await w.until("S", { state: "idle" });
  unwrap(await w.setting("fleet.paused", 1));
  expect(
    unwrap(
      await w.lifecycle.startRun("S", operatorRun(1, { turn: "handoff" })),
    ),
  ).toMatchObject({ seq: 1 });
});
