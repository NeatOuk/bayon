// an earlier change §4.4 on real processes: this home's tagged processes reaped by their session's state at
// a pass's step 5, anything that matches less left alone; the boot self-check of the scan; and a
// sentinel secret in their environment reaching no log line (HIGH-2).
import { spawn, type ChildProcess } from "node:child_process";
import { FakeClock } from "@bayon/core";
import {
  getExecutor,
  getSession,
  listRuns,
  listSessionsInStates,
} from "@bayon/db";
import { createSession, updateSessionState } from "@bayon/db/supervisor";
import { seedRows, tempDb, unwrap } from "@bayon/db/testing";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import {
  createFixtureAdapter,
  FIXTURE_RUNNER_ID,
} from "@bayon/runners/fixture";
import { afterAll, expect, test, vi } from "vitest";
import {
  AGENT_ID,
  CMD,
  EXECUTOR_ID,
  lifecycleRows,
  spawnPayload,
  startLifecycle,
  tempHome,
} from "./testing/fixtures.js";

// Real processes and ps scans: more than the default 5 s on a loaded host.
vi.setConfig({ testTimeout: 30_000 });

const T0 = 1_700_000_000_000;
const TAG = "fh-a1b2c3d4e5f6a7b8c9d0e1f2";
const OTHER = "fh-ffffffffffffffffffffffff";
const SENTINEL = "sk-sentinel-reaper-7d2e-do-not-leak";
const WAIT = { timeout: 20_000, interval: 50 };
const TURN = { kind: "turn_start", runner_type: "fixture.step", payload: {} };

const children: ChildProcess[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
  for (const c of children) {
    if (c.pid === undefined || c.exitCode !== null || c.signalCode !== null)
      continue;
    try {
      process.kill(-c.pid, "SIGKILL");
    } catch {
      // gone already
    }
  }
});

/**
 * A tagged waiting program in its own group, as a session's escaped descendant would be. node, not
 * /bin/sleep: macOS hides a platform binary's environment from `ps -E`.
 */
function straggler(sessionId: string, tag = TAG): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    env: {
      PATH: process.env["PATH"] ?? "/bin:/usr/bin",
      FRM_HOME_TAG: tag,
      FRM_SESSION_ID: sessionId,
      SECRET: SENTINEL,
    },
    detached: true,
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

const gone = (c: ChildProcess): boolean =>
  c.exitCode !== null || c.signalCode !== null;

/** `executorTag` null: a local executor built without a home tag, as tests and old boots have. */
async function setup(executorTag: string | null = TAG) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  unwrap(
    await seedRows(
      t.db,
      // No healthArgv: the default health check runs node on this real executor.
      lifecycleRows({ script: { runs: [{ events: [TURN] }] } }),
    ),
  );
  const home = tempHome();
  const slots = new SlotCounter(4);
  const executor = new LocalExecutor({
    id: EXECUTOR_ID,
    slots,
    ...(executorTag === null ? {} : { homeTag: executorTag }),
  });
  const started = await startLifecycle({
    db: t.db,
    clock,
    frmHome: home.path,
    executor,
    slots,
    adapter: createFixtureAdapter({ clock }),
    homeTag: TAG,
  });
  cleanups.push(async () => {
    await started.lifecycle.shutdown();
    const live = await listSessionsInStates(t.db, ["running", "idle"]);
    for (const s of live.ok ? live.value : []) {
      if (s.executor_ref !== null)
        await executor.cleanup(s.executor_ref, "hard");
    }
    t.cleanup();
    home.cleanup();
  });
  /** An ended session's row, as a previous supervisor left it. */
  const ended = async (id: string) => {
    unwrap(
      await createSession(t.db, {
        id,
        agent_id: AGENT_ID,
        role: "builder",
        run_class: "build",
        runner_id: FIXTURE_RUNNER_ID,
        executor_id: EXECUTOR_ID,
        session_root: `${home.path}/work/${id}`,
        home_dir: `${home.path}/runtime/sessions/${id}/home`,
        config_hash: "0".repeat(64),
        raw_log_path: `${home.path}/runtime/sessions/${id}/logs/stdout.jsonl`,
        mcp_token_hash: `token-hash-${id}`,
      }),
    );
    unwrap(
      await updateSessionState(t.db, id, {
        from: ["pending"],
        to: "exited",
        patch: { exit_reason: "error", ended_at: T0 },
      }),
    );
  };
  return { ...started, db: t.db, ended };
}

test("a pass kills an ended session's straggler; an unknown session's, another home's and a live session's are left", async () => {
  const w = await setup();
  await w.ended("ENDED");
  // A session this supervisor runs: run 1 ends, its process idles, its entry is alive.
  unwrap(
    await w.lifecycle.handlers.spawn.handle(
      spawnPayload("LIVE", { prompt: "go" }),
      CMD,
    ),
  );
  await vi.waitFor(async () => {
    await w.lifecycle.settled();
    expect(unwrap(await listRuns(w.db, "LIVE"))[0]?.state).toBe("ok");
    expect(unwrap(await getSession(w.db, "LIVE")).state).toBe("idle");
  }, WAIT);
  const ended = straggler("ENDED");
  const unknown = straggler("NO-ROW");
  const foreign = straggler("ENDED", OTHER);
  const live = straggler("LIVE"); // an escaped descendant of a session this supervisor runs
  await vi.waitFor(async () => {
    await w.lifecycle.reconcile();
    await w.lifecycle.settled();
    expect(gone(ended)).toBe(true);
  }, WAIT);
  expect({
    unknown: gone(unknown),
    foreign: gone(foreign),
    live: gone(live),
  }).toEqual({ unknown: false, foreign: false, live: false });
  expect(w.logs.map((l) => l.msg)).toContain(
    "a resource with no session here: not ours to touch",
  );
  expect(JSON.stringify(w.logs)).not.toContain(SENTINEL);
});

test("the boot self-check records orphan_scan ok when the local scan sees a tagged process", async () => {
  const w = await setup();
  await w.lifecycle.reconcile(); // a health pass writes health_detail
  const row = unwrap(await getExecutor(w.db, EXECUTOR_ID));
  expect(JSON.parse(row.health_detail ?? "{}")).toMatchObject({
    orphan_scan: "ok",
  });
});

test("an executor that cannot see our tag reports orphan_scan unavailable, with a warning", async () => {
  const w = await setup(null);
  await w.lifecycle.reconcile();
  const row = unwrap(await getExecutor(w.db, EXECUTOR_ID));
  expect(JSON.parse(row.health_detail ?? "{}")).toMatchObject({
    orphan_scan: "unavailable",
  });
  expect(w.logs.map((l) => l.msg)).toContain(
    "the orphan scan cannot see a tagged process on this executor: orphan_scan unavailable",
  );
});
