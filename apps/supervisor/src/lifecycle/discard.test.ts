// a suspended session is the one end an operator could not get out of. Resumability is
// protected on purpose — no stop edge leaves `resumable` — so a kill silently did nothing and the
// worktree stayed exempt from the sweep for good. The `discard` edge is the decisive way out, and
// the graceful stop that genuinely cannot do anything now says so instead of reporting done.
import { FakeClock } from "@bayon/core";
import { listSessionsInStates } from "@bayon/db";
import { seedRows, tempDb, unwrap } from "@bayon/db/testing";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import {
  createFixtureAdapter,
  type FixtureScriptInput,
} from "@bayon/runners/fixture";
import { afterAll, expect, test, vi } from "vitest";
import {
  CMD,
  EXECUTOR_ID,
  startLifecycle,
  tempHome,
} from "./testing/fixtures.js";
import {
  TE as TURN_END,
  TS as TURN_START,
  capturing,
  makeRepo,
  session,
  spawnOn,
  waitState,
  worldRows,
  type World,
} from "./testing/handoff-world.js";

// Real processes and git: more than the default 5 s on a loaded host.
vi.setConfig({ testTimeout: 30_000 });

const T0 = 1_700_000_000_000;
/** One run that completes, so the session is idle and stoppable. */
const SCRIPT: FixtureScriptInput = {
  runs: [{ events: [TURN_START, TURN_END] }],
};

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

async function setup(): Promise<World> {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const home = tempHome("frm-disc-");
  const { src, mirror } = makeRepo(home.path);
  unwrap(await seedRows(t.db, worldRows({ script: SCRIPT, src, mirror })));
  const slots = new SlotCounter(4);
  const executor = new LocalExecutor({ id: EXECUTOR_ID, slots });
  const fixture = capturing(createFixtureAdapter({ clock }));
  const started = await startLifecycle({
    db: t.db,
    clock,
    frmHome: home.path,
    executor,
    slots,
    adapter: fixture.adapter,
  });
  cleanups.push(async () => {
    await started.lifecycle.shutdown();
    const live = await listSessionsInStates(t.db, [
      "running",
      "idle",
      "stopping",
    ]);
    for (const s of live.ok ? live.value : []) {
      if (s.executor_ref !== null)
        await executor.cleanup(s.executor_ref, "hard");
    }
    t.cleanup();
    home.cleanup();
  });
  return {
    ...started,
    db: t.db,
    clock,
    executor,
    slots,
    src,
    mirror,
    release: fixture.release,
    adopts: fixture.adopts,
    stops: fixture.stops,
  };
}

const stop = (w: World, id: string, mode: "graceful" | "kill") =>
  w.lifecycle.handlers.stop.handle({ session_id: id, mode }, CMD);

/** A fixture session stopped gracefully: resumable, since the fixture runner can come back. */
async function suspended(w: World, id: string): Promise<void> {
  await spawnOn(w, id);
  await waitState(w, id, "idle");
  unwrap(await stop(w, id, "graceful"));
  await waitState(w, id, "resumable");
}

test("a kill discards a suspended session for good, so its worktree stops being exempt", async () => {
  const w = await setup();
  await suspended(w, "S1");

  unwrap(await stop(w, "S1", "kill"));
  await waitState(w, "S1", "exited");
  expect((await session(w.db, "S1")).exit_reason).toBe("killed");
});

test("a graceful stop of a suspended session is refused, and names the way to end it", async () => {
  const w = await setup();
  await suspended(w, "S2");

  const refused = await stop(w, "S2", "graceful");
  expect(refused.ok).toBe(false);
  if (refused.ok)
    throw new Error("a graceful stop of a suspended session must be refused");
  expect(refused.error.class).toBe("conflict");
  expect(refused.error.message).toContain("kill");
  // Refused, not merely ignored: it is still resumable, exactly as it was.
  expect((await session(w.db, "S2")).state).toBe("resumable");
});

test("discarding a holder leaves its ticket a hand-off, not a stranded ticket", async () => {
  const w = await setup();
  await suspended(w, "S3");
  // The graceful suspend already left the degraded row (end.ts's HOOKED): the discard must not
  // strand the ticket, and must not write a second one either.
  const afterSuspend = await handoffCount(w, "S3");
  expect(afterSuspend).toBeGreaterThan(0);

  unwrap(await stop(w, "S3", "kill"));
  await waitState(w, "S3", "exited");
  expect(await handoffCount(w, "S3")).toBe(afterSuspend);
});

async function handoffCount(w: World, id: string): Promise<number> {
  const s = await session(w.db, id);
  return s.handoff_out_id === null ? 0 : 1;
}
