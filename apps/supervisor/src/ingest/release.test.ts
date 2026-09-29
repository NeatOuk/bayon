// releasePipes against ingest held back by backpressure: the real
// fixture runner on the local executor, under a shell that leaves a background process holding its
// stdout. Ingest's inserts are held while the runner writes run 1's events and terminal and then
// exits, so they wait in tee's queue; the pipes are released meanwhile. Once ingest may insert
// again, the runner's own terminal is stored and the run ends ok, with no read-failure note.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FakeClock } from "@bayon/core";
import { getEventsSince, listRuns } from "@bayon/db";
import {
  appendRun,
  createSession,
  insertEventsBatch,
  updateSessionState,
} from "@bayon/db/supervisor";
import {
  newRunInput,
  newSessionInput,
  seedSpine,
  tempDb,
  unwrap,
} from "@bayon/db/testing";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import type { SpawnSpec } from "@bayon/runners";
import { createFixtureAdapter, fixtureCommand } from "@bayon/runners/fixture";
import { pino } from "pino";
import { afterAll, expect, test, vi } from "vitest";
import { tempHome } from "../lifecycle/testing/fixtures.js";
import { rawLogPath } from "../paths.js";
import { EOF_CLOSE, must, texts } from "../testing/ingest-harness.js";
import { createIngest } from "./ingest.js";

const WAIT = { timeout: 20_000, interval: 20 };
/** Starts the runner with a background sleep that keeps its stdout, and only its stdout. */
const HOLD_STDOUT = '(sleep 300 2>/dev/null &); exec "$0" "$@"';

const clock = new FakeClock(1_700_000_000_000);
const t = unwrap(await tempDb(clock));
unwrap(await seedSpine(t.db, 14));
const home = tempHome();
const executor = new LocalExecutor({
  id: "local",
  slots: new SlotCounter(2),
  clock,
});
const refs: string[] = [];
afterAll(async () => {
  // The background sleep shares the runner's process group: the group goes with it.
  for (const ref of refs) await executor.cleanup(ref, "hard");
  t.cleanup();
  home.cleanup();
});

test("a release while ingest is held back keeps the runner's queued terminal, which is stored once ingest resumes", async () => {
  const gate = Promise.withResolvers<undefined>();
  let held = false;
  let waits = 0;
  const ingest = createIngest({
    db: t.db,
    clock,
    log: pino({ level: "silent" }),
    maxRows: 1,
    insertEvents: async (db, rows) => {
      if (held) {
        waits += 1;
        await gate.promise;
      }
      return insertEventsBatch(db, rows);
    },
  });
  const adapter = createFixtureAdapter({
    command: ["/bin/sh", "-c", HOLD_STDOUT, ...fixtureCommand(executor)],
  });
  const id = "released-1";
  must(
    await createSession(t.db, {
      ...newSessionInput(),
      id,
      raw_log_path: rawLogPath(home.path, id),
    }),
  );
  const { offset } = must(await ingest.beginSegment(id));
  const cwd = join(home.path, "work", id);
  const homeDir = join(home.path, "runtime", "sessions", id, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  const spec: SpawnSpec = {
    sessionId: id,
    cwd,
    homeDir,
    env: { PATH: process.env["PATH"] ?? "" },
    model: "fixture-model",
    flags: { script: { runs: [{ events: texts(40) }] } },
  };
  const handle = must(await adapter.spawn(spec, executor));
  refs.push(handle.executorRef);
  must(
    await updateSessionState(t.db, id, {
      from: ["pending", "idle", "running"],
      to: "idle",
      patch: { raw_segment_offset: offset },
    }),
  );
  const attachment = must(
    ingest.attach({
      sessionId: id,
      handle,
      adapter,
      segmentOffset: offset,
      onEof: () => EOF_CLOSE,
    }),
  );
  const run = must(await appendRun(t.db, newRunInput(id)));
  must(await ingest.openRun(id, run.id));
  // From here ingest's inserts wait: run 1's events and terminal pile up behind them.
  held = true;
  must(
    await adapter.send(handle, {
      runId: run.id,
      text: "go",
      promptPath: "/dev/null",
    }),
  );
  await vi.waitFor(() => expect(waits).toBeGreaterThan(0), WAIT);
  // The runner saw its terminal through tee; a graceful stop ends it. The sleep keeps stdout.
  await adapter.stop(handle, "graceful");
  await vi.waitFor(
    () => expect(executor.exitedAt(handle.executorRef)).not.toBeNull(),
    WAIT,
  );
  // As the stuck rule does: ask until released (draining while the reader is behind).
  await vi.waitFor(
    () =>
      expect(executor.releasePipes(handle.executorRef).state).toBe("released"),
    WAIT,
  );
  gate.resolve(undefined);
  await attachment.closed;
  const terminals = unwrap(
    await getEventsSince(t.db, {
      sessionId: id,
      since: 0,
      kinds: ["terminal"],
      limit: 10,
    }),
  ).rows;
  expect(terminals.map((e) => e.runner_type)).toEqual(["fixture.terminal"]);
  expect(unwrap(await listRuns(t.db, id))[0]?.state).toBe("ok");
  const exit = await handle.exited;
  expect(exit.stderrTail).not.toMatch(/read failed|premature/i);
  await ingest.shutdown();
});
