// A runner whose stream ends while its process lives on, and a gate's reviewer whose exit is never
// reported. Real fixture processes on the local executor; a FakeClock
// drives the lifecycle; cross-process waits are deadlines, never sleeps.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock } from "@bayon/core";
import { seedRows, tempDb, ticketRow, unwrap } from "@bayon/db/testing";
import { afterAll, describe, expect, test, vi } from "vitest";
import { collect, type Collected } from "../gates/collect.js";
import type { AfterExitFacts } from "./after-exit.js";
import { DEFAULT_SETTINGS } from "./settings.js";
import { CMD } from "./testing/fixtures.js";
import {
  GATE_ID,
  GATE_ROW,
  GRACE,
  T0,
  WAIT,
  driveUntil,
  killMidRun,
  msgs,
  processWorld,
  reviewer,
  session,
  spawnRunning,
  untilRunning,
  untilStreamEnded,
  withheld,
  worldRows,
  type World,
  type WorldOptions,
} from "./testing/process-gone-world.js";

const TAG = "0123456789ab";
const QUIET = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

async function setup(
  o: WorldOptions & { readonly gate?: boolean },
): Promise<World> {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const rows = worldRows();
  unwrap(
    await seedRows(
      t.db,
      o.gate === true
        ? { ...rows, tickets: [ticketRow(1)], gates: [GATE_ROW] }
        : rows,
    ),
  );
  const w = await processWorld({ ...o, db: t.db, clock, cleanupDb: t.cleanup });
  cleanups.push(w.cleanup);
  return w;
}

/** Past the longest an exit op may take: a periodic pass notices the missed exit. */
const PAST_EXIT_OP = 4 * GRACE + 10_000;

describe(
  "a stream that ends while its process lives on",
  { timeout: 30_000 },
  () => {
    test("the exit op kills its process group after one grace, and one pass adopts the session", async () => {
      const cut = Promise.withResolvers<undefined>();
      const w = await setup({
        adapter: (base) => withheld(base, { exit: "real", cut: cut.promise }),
      });
      await spawnRunning(w, "L");
      const before = (await session(w.db, "L")).executor_ref ?? "";
      cut.resolve(undefined);
      await untilStreamEnded(w, "L");
      expect(await w.executor.probe(before)).toBe("alive");
      await driveUntil(w, w.lifecycle.settled());
      expect(msgs(w)).toContain(
        "the runner's stream ended but its process has not exited: killing its process group",
      );
      expect(msgs(w)).not.toContain(
        "the runner's stream ended but its exit was not reported: going on without it",
      );
      expect(await w.executor.probe(before)).toBe("dead");
      await driveUntil(w, w.lifecycle.reconcile());
      await driveUntil(w, w.lifecycle.settled());
      const after = await session(w.db, "L");
      expect(after.state).toBe("idle");
      expect(after.executor_ref).not.toBe(before);
      expect(await w.executor.probe(after.executor_ref ?? "")).toBe("alive");
    });

    test("a missed exit whose group kill did not land: the adopt kills the straggler first", async () => {
      const cut = Promise.withResolvers<undefined>();
      const hold = Promise.withResolvers<undefined>();
      const w = await setup({
        homeTag: TAG,
        adapter: (base) =>
          withheld(base, {
            exit: "real",
            cut: cut.promise,
            hold: hold.promise,
          }),
      });
      await spawnRunning(w, "G");
      const before = (await session(w.db, "G")).executor_ref ?? "";
      // The exit op's own group kill is lost (an executor that did not answer): only the adopt's
      // straggler sweep is left to stop the old process before a second one resumes its id.
      const cleanup = w.executor.cleanup.bind(w.executor);
      let dropped = 0;
      vi.spyOn(w.executor, "cleanup").mockImplementation(async (ref, mode) => {
        if (ref === before && dropped === 0) {
          dropped += 1;
          return;
        }
        return cleanup(ref, mode);
      });
      cut.resolve(undefined);
      await untilStreamEnded(w, "G");
      await w.clock.advance(PAST_EXIT_OP);
      await driveUntil(w, w.lifecycle.reconcile());
      expect(msgs(w)).toContain(
        "its stream ended but no exit op took it: marked dead for this pass",
      );
      expect(await w.executor.probe(before)).toBe("alive");
      hold.resolve(undefined);
      await driveUntil(w, w.lifecycle.settled());
      expect(dropped).toBe(1);
      expect(msgs(w)).toContain(
        "stragglers of a session to adopt: killing them first",
      );
      expect(await w.executor.probe(before)).toBe("dead");
      const after = await session(w.db, "G");
      expect(after.state).toBe("idle");
      expect(after.executor_ref).not.toBe(before);
      expect(await w.executor.probe(after.executor_ref ?? "")).toBe("alive");
    });
  },
);

describe("a stop queued for a dead session", { timeout: 30_000 }, () => {
  test("behind a reconcile: it ends exited(killed), never adopt-then-stop, and kills what is left of its group", async () => {
    const cut = Promise.withResolvers<undefined>();
    const hold = Promise.withResolvers<undefined>();
    const w = await setup({
      adapter: (base) =>
        withheld(base, { exit: "real", cut: cut.promise, hold: hold.promise }),
    });
    await spawnRunning(w, "T");
    const before = (await session(w.db, "T")).executor_ref ?? "";
    const cleanup = w.executor.cleanup.bind(w.executor);
    let dropped = 0;
    vi.spyOn(w.executor, "cleanup").mockImplementation(async (ref, mode) => {
      if (ref === before && dropped === 0) {
        dropped += 1;
        return;
      }
      return cleanup(ref, mode);
    });
    cut.resolve(undefined);
    await untilStreamEnded(w, "T");
    await w.clock.advance(PAST_EXIT_OP);
    // The reconcile is queued first, the stop after it: the stop's intent keeps it from adopting.
    await driveUntil(w, w.lifecycle.reconcile());
    unwrap(
      await w.lifecycle.handlers.stop.handle(
        { session_id: "T", mode: "graceful" },
        CMD,
      ),
    );
    hold.resolve(undefined);
    await driveUntil(w, w.lifecycle.settled());
    expect(dropped).toBe(1);
    expect(msgs(w)).not.toContain("adopted via resume");
    expect(await session(w.db, "T")).toMatchObject({
      state: "exited",
      exit_reason: "killed",
    });
    // SIGKILLed by the stop: dead once the kernel has it.
    await vi.waitFor(async () => {
      expect(await w.executor.probe(before)).toBe("dead");
    }, WAIT);
    expect(w.slots.capacity().used).toBe(0);
  });
});

describe(
  "a gate's reviewer whose exit is never reported",
  { timeout: 30_000 },
  () => {
    /** What its afterExit collected, as the gate engine's own hook would. */
    const collectInto =
      (
        w: () => World,
        out: { collected?: Collected; facts?: AfterExitFacts },
      ) =>
      async (facts: AfterExitFacts): Promise<void> => {
        const world = w();
        const exec = {
          settings: DEFAULT_SETTINGS,
          clock: world.clock,
          frmHome: world.frmHome,
          path: process.env["PATH"] ?? "/usr/bin:/bin",
          log: QUIET,
        };
        out.facts = facts;
        out.collected = await collect({
          db: world.db,
          frmHome: world.frmHome,
          exec,
          git: { exec, executor: facts.executor },
          gateId: GATE_ID,
          kind: "code_review",
          sessionId: "RV",
          pin: {
            repoId: "repo-1",
            workspaceId: "ws-1",
            executorId: "local",
            mirror: join(world.frmHome, "no-mirror"),
            baseRef: "refs/heads/main",
            base: "a".repeat(40),
            head: "b".repeat(40),
            tip: "a".repeat(40),
            files: [],
            stat: "",
            planText: null,
            diffPath: join(world.frmHome, "diff.patch"),
            others: [],
          },
          choice: {
            runnerId: "fixture",
            fallbackFrom: null,
            singleRunnerReview: false,
            outputSchema: false,
            agentId: "agent-1",
            profileId: null,
            executorId: "local",
          },
          baseDrift: false,
          artifactsDir: join(world.frmHome, "artifacts", GATE_ID),
          facts,
        });
      };

    test("its exit.json reads code null and the gate fails reviewer_error", async () => {
      const out: { collected?: Collected; facts?: AfterExitFacts } = {};
      const w = await setup({ gate: true, adapter: (base) => withheld(base) });
      unwrap(
        await w.lifecycle.spawnInternal(
          reviewer(
            "RV",
            collectInto(() => w, out),
          ),
        ),
      );
      await untilRunning(w, "RV");
      await killMidRun(w, "RV");
      await vi.waitFor(async () => {
        await w.clock.advance(GRACE);
        expect(out.collected).toBeDefined();
      }, WAIT);
      expect(out.facts?.exit).toEqual({ stderrTail: "" });
      const exitJson = join(w.frmHome, "artifacts", GATE_ID, "exit.json");
      expect(JSON.parse(readFileSync(exitJson, "utf8"))).toEqual({
        code: null,
        signal: null,
      });
      expect(out.collected?.evidence).toMatchObject({
        reason: "reviewer_error",
      });
      expect(out.collected?.findings).toEqual([]);
    });

    test("a missed exit: the after-exit still runs, before the reconciler ends the reviewer", async () => {
      const hold = Promise.withResolvers<undefined>();
      const told: AfterExitFacts[] = [];
      const states: string[] = [];
      const w = await setup({
        gate: true,
        adapter: (base) => withheld(base, { hold: hold.promise }),
      });
      unwrap(
        await w.lifecycle.spawnInternal(
          reviewer("RM", async (facts) => {
            told.push(facts);
            states.push((await session(w.db, "RM")).state);
          }),
        ),
      );
      await untilRunning(w, "RM");
      await killMidRun(w, "RM");
      await w.clock.advance(PAST_EXIT_OP);
      await driveUntil(w, w.lifecycle.reconcile());
      expect(msgs(w)).toContain(
        "its stream ended but no exit op took it: marked dead for this pass",
      );
      expect(told).toHaveLength(0);
      hold.resolve(undefined);
      await driveUntil(w, w.lifecycle.settled());
      expect(told).toHaveLength(1);
      expect(told[0]?.exit.code).toBeUndefined();
      expect(told[0]?.run?.state).toBe("failed");
      // Told before its end (its run's terminal had already moved it to idle): markDead came after.
      expect(states).toEqual(["idle"]);
      expect(await session(w.db, "RM")).toMatchObject({
        state: "exited",
        exit_reason: "error",
      });
    });
  },
);
