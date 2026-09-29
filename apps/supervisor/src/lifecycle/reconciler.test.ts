// Reconciler v0 on real processes: the local executor running the fixture runner, each process in
// its own group, reaped in afterAll. A FakeClock drives the lifecycle; cross-process waits are
// deadlines (vi.waitFor), never a sleep.
import { FakeClock, ok, sha256Hex } from "@bayon/core";
import {
  getEventsSince,
  getSession,
  listRuns,
  listSessionsInStates,
  SUPERVISOR_RUNNER_TYPE,
  type Db,
  type SessionRow,
} from "@bayon/db";
import { updateSessionState } from "@bayon/db/supervisor";
import { seedRows, tempDb, unwrap } from "@bayon/db/testing";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import type { RunnerAdapter, SessionHandle, SpawnSpec } from "@bayon/runners";
import {
  createFixtureAdapter,
  FIXTURE_CAPS,
  type FixtureAdapter,
  type FixtureScriptInput,
} from "@bayon/runners/fixture";
import { afterAll, describe, expect, test, vi } from "vitest";
import {
  CMD,
  EXECUTOR_ID,
  lifecycleRows,
  spawnPayload,
  startLifecycle,
  tempHome,
  type RowOptions,
} from "./testing/fixtures.js";

const T0 = 1_700_000_000_000;
const WAIT = { timeout: 15_000, interval: 10 };
const TURN = { kind: "turn_start", runner_type: "fixture.step", payload: {} };
const GATE: FixtureScriptInput = {
  runs: [{ events: [TURN], gate: "release" }],
};
const TERMINAL: FixtureScriptInput = { runs: [{ events: [TURN] }] };
const DIED = "the runner exited; the reconciler adopts or ends the session";
const WITH_PROCESS = [
  "pending",
  "preparing",
  "spawning",
  "running",
  "idle",
  "stopping",
] as const;

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

async function world(
  db: Db,
  clock: FakeClock,
  frmHome: string,
  adapter: RunnerAdapter,
  boot = true,
) {
  const slots = new SlotCounter(4);
  // On the test's clock, so its exitedAt and the watchdog's stuck timer read one time.
  const executor = new LocalExecutor({ id: EXECUTOR_ID, slots, clock });
  const started = await startLifecycle({
    db,
    clock,
    frmHome,
    executor,
    slots,
    adapter,
    boot,
  });
  cleanups.unshift(async () => started.lifecycle.shutdown());
  return { ...started, executor, slots };
}

async function setup(
  o: {
    rows?: RowOptions;
    adapter?: (base: FixtureAdapter) => RunnerAdapter;
  } = {},
) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  unwrap(await seedRows(t.db, lifecycleRows({ script: GATE, ...o.rows })));
  const home = tempHome();
  const base = createFixtureAdapter({ clock });
  const w = await world(t.db, clock, home.path, o.adapter?.(base) ?? base);
  cleanups.push(async () => {
    // Reap every process a session still records, then drop the database and FRM_HOME.
    const live = await listSessionsInStates(t.db, WITH_PROCESS);
    for (const s of live.ok ? live.value : []) {
      if (s.executor_ref !== null)
        await w.executor.cleanup(s.executor_ref, "hard");
    }
    t.cleanup();
    home.cleanup();
  });
  return { ...w, db: t.db, clock, home: home.path };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const session = async (db: Db, id: string) => unwrap(await getSession(db, id));
const terminals = async (db: Db, id: string) =>
  unwrap(
    await getEventsSince(db, {
      sessionId: id,
      since: 0,
      kinds: ["terminal"],
      limit: 100,
    }),
  ).rows;
const pidOf = (ref: string | null): number => Number(ref?.split(":")[1]);
const deaths = (h: Setup) => h.logs.filter((l) => l.msg === DIED).length;

/** Spawns with a prompt and waits until run 1 has started (gate) or ended (terminal). */
async function spawnRun(
  h: Setup,
  id: string,
  until: "running" | "idle",
): Promise<SessionRow> {
  unwrap(
    await h.lifecycle.handlers.spawn.handle(
      spawnPayload(id, { prompt: "go" }),
      CMD,
    ),
  );
  await vi.waitFor(async () => {
    await h.lifecycle.settled();
    const kinds = unwrap(
      await getEventsSince(h.db, { sessionId: id, since: 0, limit: 10 }),
    ).rows.map((e) => e.kind);
    expect(kinds).toContain(until === "running" ? "turn_start" : "terminal");
    expect((await session(h.db, id)).state).toBe(until);
  }, WAIT);
  return session(h.db, id);
}

/** SIGKILLs the session's runner and waits until this supervisor has seen it die. */
async function kill9(h: Setup, id: string): Promise<void> {
  const seen = deaths(h);
  process.kill(pidOf((await session(h.db, id)).executor_ref), "SIGKILL");
  await vi.waitFor(async () => {
    await h.lifecycle.settled();
    expect(deaths(h)).toBe(seen + 1);
  }, WAIT);
}

/** A child that leaves a setsid grandchild on its stderr, prints the grandchild's pid, and exits. */
const ESCAPE_STDERR = [
  "const { spawn } = require('node:child_process');",
  "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'],",
  "  { detached: true, stdio: ['ignore', 'ignore', 'inherit'] });",
  "g.unref();",
  "process.stdout.write(String(g.pid) + '\\n');",
].join("\n");

const drain = async (s: AsyncIterable<Uint8Array>): Promise<string> => {
  const parts: Buffer[] = [];
  for await (const chunk of s) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts).toString("utf8");
};

describe("the watchdog's stuck rule under the reconciler (escape 2)", () => {
  test(
    "an adopt that fails after the adapter handed back its process, an escapee on its stderr: released through its candidate, and the pass does not hang",
    { timeout: 30_000 },
    async () => {
      const escapees: number[] = [];
      const ours = new WeakSet<SessionHandle>();
      const holder: { db?: Db } = {};
      const h = await setup({
        rows: { script: TERMINAL },
        adapter: (base) => ({
          ...base,
          async adopt(spec, ex) {
            const proc = await ex.exec(
              [process.execPath, "-e", ESCAPE_STDERR],
              {
                cwd: spec.cwd,
                env: { PATH: process.env["PATH"] ?? "" },
                stdin: "ignore",
              },
            );
            void drain(proc.stdout).then((pid) => escapees.push(Number(pid)));
            // As tee builds it: the process's exit and its stderr drained.
            const exited = Promise.all([proc.exited, drain(proc.stderr)]).then(
              ([s]) => ({
                ...(s.code === null ? {} : { code: s.code }),
                ...(s.signal === null ? {} : { signal: s.signal }),
                stderrTail: "",
              }),
            );
            const handle: SessionHandle = {
              sessionId: spec.sessionId,
              executorRef: proc.ref,
              ...(spec.resumeRunnerSessionId === undefined
                ? {}
                : { runnerSessionId: spec.resumeRunnerSessionId }),
              exited,
            };
            ours.add(handle);
            // The adopt edge (from running or idle) now refuses; die (handoff_writing too) still ends it.
            unwrap(
              await updateSessionState(holder.db as Db, spec.sessionId, {
                from: ["idle", "running"],
                to: "handoff_writing",
              }),
            );
            return ok(handle);
          },
          async stop(handle, mode) {
            if (!ours.has(handle)) return base.stop(handle, mode);
            // As the fixture's kill does: it waits for the handle's exit, which the escapee holds.
            await handle.exited;
          },
        }),
      });
      holder.db = h.db;
      cleanups.push(async () => {
        for (const pid of escapees) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // gone
          }
        }
      });
      await spawnRun(h, "E", "idle");
      await kill9(h, "E");
      const pass = h.lifecycle.reconcile().then(() => true);
      // The stuck timer runs every lifecycle.kill_grace_ms: advance until it has released.
      await vi.waitFor(async () => {
        await h.clock.advance(5_000);
        expect(await Promise.race([pass, Promise.resolve(false)])).toBe(true);
      }, WAIT);
      await h.lifecycle.settled();
      // Ours under a live supervisor: its own class through markDead, never supervisor_restart.
      expect(await session(h.db, "E")).toMatchObject({
        state: "exited",
        exit_reason: "error",
        error_class: "conflict",
      });
      expect(escapees.length).toBe(1);
    },
  );
});

describe("reconciler v0 on real processes", { timeout: 30_000 }, () => {
  test("kill -9 mid-run: the run fails without terminal, the next pass adopts via resume, the slot is held throughout", async () => {
    const h = await setup();
    const before = await spawnRun(h, "K", "running");
    await kill9(h, "K");
    expect((await session(h.db, "K")).state).toBe("idle");
    expect(unwrap(await listRuns(h.db, "K"))[0]).toMatchObject({
      state: "failed",
      error_class: "runner_exited_without_terminal",
    });
    const [only, ...rest] = await terminals(h.db, "K");
    expect(rest).toEqual([]);
    expect(only).toMatchObject({
      runner_type: SUPERVISOR_RUNNER_TYPE,
      raw_offset: -1,
    });
    expect(h.slots.capacity().used).toBe(1);

    await h.lifecycle.reconcile();
    await h.lifecycle.settled();
    const after = await session(h.db, "K");
    expect(after).toMatchObject({
      state: "idle",
      runner_session_id: before.runner_session_id,
    });
    expect(after.executor_ref).not.toBe(before.executor_ref);
    expect(after.raw_segment_offset).toBeGreaterThan(0);
    expect(after.mcp_token_hash).not.toBe(before.mcp_token_hash);
    expect(await h.executor.probe(after.executor_ref ?? "")).toBe("alive");
    expect(h.slots.capacity().used).toBe(1);
    expect(await terminals(h.db, "K")).toHaveLength(1);
  });

  test("adopt commits the new token hash before the process starts, and move('adopt') keeps it", async () => {
    const seen: { spec?: SpawnSpec; hashAtAdopt?: string } = {};
    const at: { db?: Db } = {};
    const h = await setup({
      rows: { toolAllowlist: ["ticket_get"] },
      adapter: (base) => ({
        ...base,
        caps: () => ({ ...base.caps(), mcpClient: true }),
        adopt: async (spec, ex) => {
          seen.spec = spec;
          if (at.db !== undefined) {
            seen.hashAtAdopt = (
              await session(at.db, spec.sessionId)
            ).mcp_token_hash;
          }
          return base.adopt(spec, ex);
        },
      }),
    });
    at.db = h.db;
    const before = await spawnRun(h, "M", "running");
    await kill9(h, "M");
    await h.lifecycle.reconcile();
    await h.lifecycle.settled();

    const token = seen.spec?.mcp?.token ?? "";
    expect(token).not.toBe("");
    expect(seen.spec?.mcp?.tools).toEqual(["ticket_get"]);
    expect(seen.hashAtAdopt).toBe(await sha256Hex(token));
    const after = await session(h.db, "M");
    expect(after.state).toBe("idle");
    expect(after.mcp_token_hash).toBe(await sha256Hex(token));
    expect(after.mcp_token_hash).not.toBe(before.mcp_token_hash);
    expect(after.toolset_hash).toBe(before.toolset_hash);
  });

  test("adopt prepares the session on its executor before resuming it (kill before adopt)", async () => {
    const order: string[] = [];
    const h = await setup({
      adapter: (base) => ({
        ...base,
        adopt: async (spec, ex) => {
          order.push(`adopt ${spec.sessionId}`);
          return base.adopt(spec, ex);
        },
      }),
    });
    const prepare = h.executor.prepare.bind(h.executor);
    vi.spyOn(h.executor, "prepare").mockImplementation(async (spec) => {
      order.push(`prepare ${spec.sessionId}`);
      return prepare(spec);
    });
    await spawnRun(h, "P", "running");
    await kill9(h, "P");
    order.length = 0;
    await h.lifecycle.reconcile();
    await h.lifecycle.settled();
    expect(order).toEqual(["prepare P", "adopt P"]);
    expect((await session(h.db, "P")).state).toBe("idle");
  });

  test("kill -9 while idle: adopted, and no terminal is written", async () => {
    const h = await setup({ rows: { script: TERMINAL } });
    const before = await spawnRun(h, "I", "idle");
    await kill9(h, "I");
    await h.lifecycle.reconcile();
    await h.lifecycle.settled();
    const after = await session(h.db, "I");
    expect(after.state).toBe("idle");
    expect(after.executor_ref).not.toBe(before.executor_ref);
    const all = await terminals(h.db, "I");
    expect(all.map((e) => e.runner_type)).toEqual(["fixture.terminal"]); // run 1's own only
    expect(h.slots.capacity().used).toBe(1);
  });

  // this process spawned and attached it, so its death under this supervisor keeps its
  // own class through the failed adopt and markDead, and the circuit breaker counts it.
  test("kill -9 of a runner that cannot resume: exited{error} and the slot is released", async () => {
    const h = await setup({
      rows: { script: TERMINAL },
      adapter: (base) => ({
        ...base,
        caps: () => ({ ...FIXTURE_CAPS, resumable: false }),
      }),
    });
    await spawnRun(h, "N", "idle");
    await kill9(h, "N");
    expect(h.slots.capacity().used).toBe(1);
    await h.lifecycle.reconcile();
    await h.lifecycle.settled();
    expect(await session(h.db, "N")).toMatchObject({
      state: "exited",
      exit_reason: "error",
      error_class: "runner_exited_without_terminal",
    });
    expect((await session(h.db, "N")).error_class).not.toBe(
      "supervisor_restart",
    );
    expect(h.slots.capacity().used).toBe(0);
  });

  test("crash_on_resume: the reconciler gives up after lifecycle.adopt_max adopts", async () => {
    const h = await setup({
      rows: {
        script: { ...TERMINAL, crash_on_resume: true },
        settings: { "lifecycle.adopt_max": 2 },
      },
    });
    await spawnRun(h, "X", "idle");
    await kill9(h, "X");
    for (let adopt = 1; adopt <= 2; adopt += 1) {
      const seen = deaths(h);
      await h.lifecycle.reconcile();
      await vi.waitFor(async () => {
        await h.lifecycle.settled();
        expect(deaths(h)).toBe(seen + 1); // the adopted process crashed on resume
      }, WAIT);
      expect((await session(h.db, "X")).state).toBe("idle");
    }
    await h.lifecycle.reconcile();
    await h.lifecycle.settled();
    expect(await session(h.db, "X")).toMatchObject({
      state: "exited",
      exit_reason: "error",
      error_class: "runner_error",
    });
    expect(h.slots.capacity().used).toBe(0);
  });

  test("alive at boot: a second supervisor kills the unowned process, then adopts it (Invariant 12)", async () => {
    const h = await setup({ rows: { script: TERMINAL } });
    const before = await spawnRun(h, "B", "idle");
    const next = await world(
      h.db,
      h.clock,
      h.home,
      createFixtureAdapter({ clock: h.clock }),
      false,
    );
    const booted = next.lifecycle.boot().then(() => true);
    await vi.waitFor(async () => {
      await h.clock.advance(100); // its re-probe interval
      expect(await Promise.race([booted, Promise.resolve(false)])).toBe(true);
    }, WAIT);
    await next.lifecycle.settled();
    expect(next.logs.map((l) => l.msg)).toContain(
      "alive but unowned: killing it before adopting",
    );
    const after = await session(h.db, "B");
    expect(after.state).toBe("idle");
    expect(after.executor_ref).not.toBe(before.executor_ref);
    expect(await next.executor.probe(before.executor_ref ?? "")).toBe("dead");
    expect(await next.executor.probe(after.executor_ref ?? "")).toBe("alive");
    expect(next.slots.capacity().used).toBe(1);
  });
});
