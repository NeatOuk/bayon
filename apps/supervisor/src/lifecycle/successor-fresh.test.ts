// an earlier change §3.1 and §3.5 on real git and the fixture runner: a ticket's holder that a restart cut
// short before its workspace step leaves a degraded hand-off (restartAbort); its successor, with no
// worktree to take over, is placed afresh, the packet in run 1 and in its new worktree. A chain
// whose only worktree was removed still refuses. And a degraded write that fails leaves the holder
// for the next pass (MEDIUM-4).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock } from "@bayon/core";
import {
  listRuns,
  listSessionsInStates,
  listSessionWorktrees,
} from "@bayon/db";
import {
  createSession,
  setWorktreeState,
  updateSessionState,
} from "@bayon/db/supervisor";
import {
  failInsertsForTest,
  seedRows,
  tempDb,
  unwrap,
} from "@bayon/db/testing";
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
  spawnPayload,
  startLifecycle,
  tempHome,
} from "./testing/fixtures.js";
import {
  TICKET,
  TINY,
  capturing,
  fileHash,
  handoffsOf,
  makeRepo,
  session,
  turns,
  waitState,
  worldRows,
  type World,
} from "./testing/handoff-world.js";

vi.setConfig({ testTimeout: 30_000 });

const T0 = 1_700_000_000_000;
const HASH = "0".repeat(64);

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

type Fresh = World & { readonly home: string };

async function setup(): Promise<Fresh> {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const home = tempHome("frm-fr-");
  const { src, mirror } = makeRepo(home.path);
  unwrap(
    await seedRows(
      t.db,
      worldRows({ script: { runs: [{ events: turns(1) }] }, src, mirror }),
    ),
  );
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
    home: home.path,
  };
}

/** A ticket holder the old supervisor left in `preparing`, before its workspace step: no worktree. */
async function cutShort(w: Fresh, id: string): Promise<void> {
  const runtime = join(w.home, "runtime", "sessions", id);
  unwrap(
    await createSession(w.db, {
      id,
      agent_id: AGENT_ID,
      ticket_id: TICKET,
      role: "builder",
      run_class: TINY.name,
      runner_id: FIXTURE_RUNNER_ID,
      executor_id: EXECUTOR_ID,
      workspace_id: "ws",
      session_root: join(w.home, "work", id),
      home_dir: join(runtime, "home"),
      config_hash: HASH,
      raw_log_path: join(runtime, "logs", "stdout.jsonl"),
      mcp_token_hash: `token-hash-${id}`,
    }),
  );
  unwrap(
    await updateSessionState(w.db, id, { from: ["pending"], to: "preparing" }),
  );
}

/** A staffed successor's spawn command: no prompt, the pending hand-off. */
const staff = (w: World, id: string, handoffId: string) =>
  w.lifecycle.handlers.spawn.handle(
    spawnPayload(id, {
      workspace_id: "ws",
      ticket_id: TICKET,
      run_class: TINY.name,
      handoff_id: handoffId,
    }),
    CMD,
  );

async function pass(w: World): Promise<void> {
  await w.lifecycle.reconcile();
  await w.lifecycle.settled();
}

test("a holder cut short before its workspace step leaves a degraded row; its successor is placed afresh, the packet in run 1 and its new worktree", async () => {
  const w = await setup();
  await cutShort(w, "pre");
  await pass(w);
  expect(await session(w.db, "pre")).toMatchObject({
    state: "exited",
    exit_reason: "error",
    error_class: "supervisor_restart",
    error_message: "the supervisor restarted during spawn",
  });
  const [h, ...more] = await handoffsOf(w.db, "pre");
  expect(more).toEqual([]);
  expect(h).toMatchObject({ quality: "degraded", reason: "session_death" });
  const why = (JSON.parse(h?.facts_json ?? "{}") as { why?: string }).why;
  expect(why).toBe("the supervisor restarted before its process started");

  unwrap(await staff(w, "fresh", h?.id ?? ""));
  await waitState(w, "fresh", "idle");
  expect(await session(w.db, "fresh")).toMatchObject({
    predecessor_session_id: "pre",
    handoff_in_id: h?.id,
  });
  const [wt, ...others] = unwrap(await listSessionWorktrees(w.db, "fresh"));
  expect(others).toEqual([]);
  expect(wt).toMatchObject({ branch: "frm/fresh", state: "active" });
  expect(fileHash(join(wt?.path ?? "", h?.packet_path ?? ""))).toBe(
    h?.packet_hash,
  );
  const [run] = unwrap(await listRuns(w.db, "fresh"));
  expect(readFileSync(run?.prompt_path ?? "", "utf8")).toContain(
    `(no judgement: ${why})`,
  );

  // The chain has a worktree now: once it is only removed, the next successor is refused.
  await w.lifecycle.stop("fresh", "kill");
  await waitState(w, "fresh", "exited");
  unwrap(await setWorktreeState(w.db, wt?.id ?? "", "removed"));
  const refused = await staff(w, "again", h?.id ?? "");
  expect(!refused.ok && refused.error).toMatchObject({
    class: "not_found",
    message: expect.stringContaining("left none"),
  });
});

test("a degraded write that fails leaves the holder in its state for the next pass (MEDIUM-4)", async () => {
  const w = await setup();
  await cutShort(w, "pre");
  const undo = unwrap(await failInsertsForTest(w.db, "handoffs"));
  await pass(w);
  expect((await session(w.db, "pre")).state).toBe("preparing");
  expect(await handoffsOf(w.db, "pre")).toEqual([]);
  unwrap(await undo());
  await pass(w);
  expect((await session(w.db, "pre")).state).toBe("exited");
  expect(await handoffsOf(w.db, "pre")).toHaveLength(1);
});
