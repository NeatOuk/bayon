// "Take over after this step" end to end: the fixture runner on a real LocalExecutor,
// real tmux under a real FRM_HOME, a real git worktree and ticket. Run 1 is gated, so the session
// stays mid-turn until the test releases it. The ask never touches the agent: its turn completes
// and lands its terminal, and only then is the session taken over — with never two processes on
// its runner_session_id. A detach before then cancels it; `now` still interrupts as it always did.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { FakeClock, TEMPLATES } from "@bayon/core";
import { listRuns, listSessionsInStates, type Db } from "@bayon/db";
import { seedRows, tempDb, unwrap } from "@bayon/db/testing";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import {
  createFixtureAdapter,
  FIXTURE_CAPS,
  type FixtureScriptInput,
} from "@bayon/runners/fixture";
import type { RunnerAdapter, SessionHandle } from "@bayon/runners";
import { afterAll, describe, expect, test, vi } from "vitest";
import { tmuxSocketPath } from "../paths.js";
import {
  CMD,
  EXECUTOR_ID,
  startLifecycle,
  tempHome,
} from "./testing/fixtures.js";
import {
  TE as TURN_END,
  TS as TURN_START,
  WAIT,
  capturing,
  makeRepo,
  session,
  spawnOn,
  waitEvent,
  waitFor,
  waitState,
  worldRows,
  type World,
} from "./testing/handoff-world.js";

// Real processes, git and tmux: more than the default 5 s on a loaded host.
vi.setConfig({ testTimeout: 30_000 });

const T0 = 1_700_000_000_000;
/** Run 1 opens and waits mid-turn for the test's release; run 2 completes at once. */
const GATED: FixtureScriptInput = {
  runs: [
    { events: [TURN_START], gate: "release" },
    { events: [TURN_START, TURN_END] },
  ],
};
/** Run 1 completes at once: the session is idle, between turns. */
const QUICK: FixtureScriptInput = {
  runs: [{ events: [TURN_START, TURN_END] }],
};

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/**
 * The adapter the supervisor holds, with its process bookkeeping exposed: every automated process
 * it handed back stays in `live` until its exit settles, and each call the lifecycle makes is
 * logged in order. `resume(n)` records how many automated processes of that session were still
 * alive when the interactive resume was prepared — Invariant 12 says it must be 0.
 */
function tracking(a: RunnerAdapter) {
  const live = new Set<SessionHandle>();
  const ops: string[] = [];
  const track = (h: SessionHandle): void => {
    live.add(h);
    void h.exited.then(() => live.delete(h));
  };
  const liveFor = (id: string): number =>
    [...live].filter((h) => h.sessionId === id).length;
  const adapter: RunnerAdapter = {
    ...a,
    spawn: async (spec, ex) => {
      const r = await a.spawn(spec, ex);
      if (r.ok) {
        track(r.value);
        ops.push("spawn");
      }
      return r;
    },
    adopt: async (spec, ex) => {
      const r = await a.adopt(spec, ex);
      if (r.ok) {
        track(r.value);
        ops.push("adopt");
      }
      return r;
    },
    stop: async (h, mode) => {
      ops.push(`stop:${mode}`);
      return a.stop(h, mode);
    },
    interrupt: async (h) => {
      ops.push("interrupt");
      return a.interrupt(h);
    },
    interactiveResume: async (spec, rsid, ex) => {
      ops.push(`resume(${liveFor(spec.sessionId)})`);
      return a.interactiveResume(spec, rsid, ex);
    },
  };
  return { adapter, ops, liveFor };
}

type Tracked = ReturnType<typeof tracking>;

interface AttachWorld extends World {
  readonly frmHome: string;
  readonly tracked: Tracked;
}

async function setup(script: FixtureScriptInput): Promise<AttachWorld> {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const home = tempHome("frm-te-");
  const { src, mirror } = makeRepo(home.path);
  const rows = worldRows({ script, src, mirror });
  // §12.5 needs the pty cap, on the runner row and on the adapter object alike (attach.test.ts).
  const runner = rows.runners[0];
  if (runner === undefined) throw new Error("worldRows seeded no runner");
  runner.caps_json = JSON.stringify({ ...FIXTURE_CAPS, pty: true });
  unwrap(await seedRows(t.db, rows));
  const slots = new SlotCounter(4);
  const executor = new LocalExecutor({ id: EXECUTOR_ID, slots });
  const base = createFixtureAdapter({ clock });
  const fixture = capturing({
    ...base,
    caps: () => ({ ...base.caps(), pty: true }),
  });
  const tracked = tracking(fixture.adapter);
  const started = await startLifecycle({
    db: t.db,
    clock,
    frmHome: home.path,
    executor,
    slots,
    adapter: tracked.adapter,
  });
  cleanups.push(async () => {
    await started.lifecycle.shutdown();
    const live = await listSessionsInStates(t.db, [
      "running",
      "idle",
      "human_attached",
      "stopping",
      "handoff_writing",
    ]);
    for (const s of live.ok ? live.value : []) {
      if (s.tmux_target !== null) killTmux(s.tmux_target);
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
    frmHome: home.path,
    tracked,
  };
}

function killTmux(socket: string): void {
  try {
    execFileSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" });
  } catch {
    // Already gone.
  }
}

function tmuxAlive(socket: string): boolean {
  try {
    execFileSync("tmux", ["-S", socket, "has-session", "-t", "main"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

const runStates = async (db: Db, id: string): Promise<readonly string[]> =>
  unwrap(await listRuns(db, id)).map((r) => r.state);

/** Spawns a builder whose run 1 opens and waits, gated, mid-turn. */
async function midTurn(w: AttachWorld, id: string): Promise<void> {
  await spawnOn(w, id);
  await waitState(w, id, "running");
  await waitEvent(w, id, "turn_start");
}

const TOKEN = "web-tab-after-this-step";

const askTurnEnd = (w: AttachWorld, id: string) =>
  w.lifecycle.handlers.attach.handle(
    { session_id: id, client_token: TOKEN, when: "turn_end" },
    CMD,
  );

describe("take over after this step", () => {
  test("turn_end mid-turn: the turn completes and lands its terminal, uninterrupted, and only then is the session taken over", async () => {
    const w = await setup(GATED);
    const id = "s-te-1";
    await midTurn(w, id);

    expect(await askTurnEnd(w, id)).toMatchObject({
      ok: true,
      value: { when: "turn_end" },
    });
    await waitFor(w, async () => {
      expect(await session(w.db, id)).toMatchObject({
        state: "running",
        attach_intent_owner: TOKEN,
      });
    });
    const pending = await session(w.db, id);
    expect(pending.attach_intent_at).toBe(T0);
    // The agent was not touched: no stop, no interrupt, one live process, no tmux, run 1 open.
    expect(w.tracked.ops).toEqual(["spawn"]);
    expect(w.tracked.liveFor(id)).toBe(1);
    expect(existsSync(tmuxSocketPath(w.frmHome, id))).toBe(false);
    expect(await runStates(w.db, id)).toEqual(["running"]);

    w.tracked.ops.push("release");
    await w.release(id);
    await waitState(w, id, "human_attached");

    // Run 1 ended on its own terminal, ok — never interrupted — and the one stop came after it.
    expect(await runStates(w.db, id)).toEqual(["ok"]);
    // Invariant 12: the idle automated process was gone before the interactive resume was even
    // prepared, and nothing but that one stop came between the run's end and the takeover.
    expect(w.tracked.ops).toEqual([
      "spawn",
      "release",
      "stop:graceful",
      "resume(0)",
    ]);
    expect(w.tracked.liveFor(id)).toBe(0);
    const attached = await session(w.db, id);
    expect(attached).toMatchObject({
      attach_lease_owner: TOKEN,
      attach_intent_owner: null,
      attach_intent_at: null,
    });
    expect(tmuxAlive(attached.tmux_target as string)).toBe(true);
    // And no automated turn can start under the human.
    expect(
      await w.lifecycle.startRun(id, {
        seq: 2,
        trigger: "retry",
        template: TEMPLATES.operator,
        inputs: { task: "x" },
      }),
    ).toMatchObject({ ok: false, error: { class: "conflict" } });
    killTmux(attached.tmux_target as string);
  });

  test("a detach before the turn ends cancels the takeover: the turn completes and the session carries on automated", async () => {
    const w = await setup(GATED);
    const id = "s-te-cancel";
    await midTurn(w, id);
    expect((await askTurnEnd(w, id)).ok).toBe(true);
    await waitFor(w, async () => {
      expect((await session(w.db, id)).attach_intent_owner).toBe(TOKEN);
    });

    expect(
      (await w.lifecycle.handlers.detach.handle({ session_id: id }, CMD)).ok,
    ).toBe(true);
    await waitFor(w, async () => {
      expect(await session(w.db, id)).toMatchObject({
        state: "running",
        attach_intent_owner: null,
        attach_intent_at: null,
      });
    });

    await w.release(id);
    await waitState(w, id, "idle");
    expect(await runStates(w.db, id)).toEqual(["ok"]);
    // Nothing was stopped, nothing resumed, no tmux, no lease, no hand-off: the agent never knew.
    expect(w.tracked.ops).toEqual(["spawn"]);
    expect(existsSync(tmuxSocketPath(w.frmHome, id))).toBe(false);
    expect(await session(w.db, id)).toMatchObject({
      state: "idle",
      attach_lease_owner: null,
      handoff_out_id: null,
    });
    // Automation carries on: the next run starts and completes on the same process.
    expect(
      await w.lifecycle.startRun(id, {
        seq: 2,
        trigger: "retry",
        template: TEMPLATES.operator,
        inputs: { task: "x" },
      }),
    ).toMatchObject({ ok: true });
    await waitFor(w, async () => {
      expect(await runStates(w.db, id)).toEqual(["ok", "ok"]);
    });
    expect((await session(w.db, id)).state).toBe("idle");
  });

  test("now still interrupts as before: the turn is cut short and the process stopped before the resume", async () => {
    const w = await setup(GATED);
    const id = "s-te-now";
    await midTurn(w, id);

    expect(
      (
        await w.lifecycle.handlers.attach.handle(
          { session_id: id, client_token: TOKEN, when: "now" },
          CMD,
        )
      ).ok,
    ).toBe(true);
    await waitState(w, id, "human_attached");

    expect(await runStates(w.db, id)).toEqual(["interrupted"]);
    expect(w.tracked.ops).toEqual(["spawn", "stop:graceful", "resume(0)"]);
    const s = await session(w.db, id);
    expect(s.attach_lease_owner).toBe(TOKEN);
    killTmux(s.tmux_target as string);
  });

  test("a command with no `when` (stored before) is `now`", async () => {
    const w = await setup(GATED);
    const id = "s-te-legacy";
    await midTurn(w, id);
    expect(
      (await w.lifecycle.handlers.attach.handle({ session_id: id }, CMD)).ok,
    ).toBe(true);
    await waitState(w, id, "human_attached");
    expect(await runStates(w.db, id)).toEqual(["interrupted"]);
    killTmux((await session(w.db, id)).tmux_target as string);
  });

  test("turn_end on an idle session takes it over at once: there is no turn to wait for", async () => {
    const w = await setup(QUICK);
    const id = "s-te-idle";
    await spawnOn(w, id);
    await waitState(w, id, "idle");

    expect((await askTurnEnd(w, id)).ok).toBe(true);
    await waitState(w, id, "human_attached");
    expect(
      w.logs.some((l) => l.msg === "takeover deferred to the open run's end"),
    ).toBe(false);
    expect(await session(w.db, id)).toMatchObject({
      attach_lease_owner: TOKEN,
      attach_intent_owner: null,
    });
    expect(w.tracked.ops).toEqual(["spawn", "stop:graceful", "resume(0)"]);
    killTmux((await session(w.db, id)).tmux_target as string);
  });

  test("a stop while a takeover is pending still stops the session, and the takeover goes with it", async () => {
    const w = await setup(GATED);
    const id = "s-te-stop";
    await midTurn(w, id);
    expect((await askTurnEnd(w, id)).ok).toBe(true);
    await waitFor(w, async () => {
      expect((await session(w.db, id)).attach_intent_owner).toBe(TOKEN);
    });

    expect(
      (
        await w.lifecycle.handlers.stop.handle(
          { session_id: id, mode: "kill" },
          CMD,
        )
      ).ok,
    ).toBe(true);
    await waitState(w, id, "exited");
    expect(await session(w.db, id)).toMatchObject({
      attach_intent_owner: null,
      attach_intent_at: null,
      attach_lease_owner: null,
    });
    expect(w.tracked.ops.some((op) => op.startsWith("resume"))).toBe(false);
    expect(existsSync(tmuxSocketPath(w.frmHome, id))).toBe(false);
  });

  test("the takeover survives a supervisor restart: the restart ends the run, the boot pass adopts the session, then takes it over", async () => {
    const w = await setup(GATED);
    const id = "s-te-restart";
    await midTurn(w, id);
    expect((await askTurnEnd(w, id)).ok).toBe(true);
    await waitFor(w, async () => {
      expect((await session(w.db, id)).attach_intent_owner).toBe(TOKEN);
    });

    // A crash: this supervisor's loops stop, its process and the row stay as they were.
    await w.lifecycle.shutdown();
    const restarted = await startLifecycle({
      db: w.db,
      clock: w.clock,
      frmHome: w.frmHome,
      executor: w.executor,
      slots: w.slots,
      adapter: w.tracked.adapter,
      boot: false,
    });
    cleanups.push(() => restarted.lifecycle.shutdown());
    // The boot pass kills the old, unowned process and probes it on the clock until it is dead.
    const booted = restarted.lifecycle.boot().then(() => true);
    await vi.waitFor(async () => {
      await w.clock.advance(100);
      expect(await Promise.race([booted, Promise.resolve(false)])).toBe(true);
    }, WAIT);

    await vi.waitFor(async () => {
      await restarted.lifecycle.settled();
      expect((await session(w.db, id)).state).toBe("human_attached");
    }, WAIT);
    const s = await session(w.db, id);
    // The GUI tab that asked is the lease holder: the owner came through the restart in the row.
    expect(s).toMatchObject({
      attach_lease_owner: TOKEN,
      attach_intent_owner: null,
    });
    // The restart ended run 1 (its process predated the new supervisor); the boot pass adopted the
    // session and only then was it taken over, one process at a time.
    expect(await runStates(w.db, id)).toEqual(["interrupted"]);
    expect(w.tracked.ops.slice(1)).toEqual([
      "adopt",
      "stop:graceful",
      "resume(0)",
    ]);
    expect(
      restarted.logs.some((l) =>
        l.msg.includes("its run already ended; taking over now"),
      ),
    ).toBe(true);
    killTmux(s.tmux_target as string);
  });
});
