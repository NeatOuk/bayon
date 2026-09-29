// The phase boundary is re-derived, never remembered (HIGH). The transition's
// `session.handoff` is the fast path and it is not durable — a boundary deferred to an open run is
// armed on the in-memory Entry while the command row is already `done` — so every reconciler pass
// asks `phaseBoundary` again over the rows. Here the supervisor is never *given* the command: it
// is inserted and left completed, as it would be after a delivery whose release was lost, and the
// release must come from the rows alone. Real processes, a real git worktree and a real SQLite
// file, as the rest of the hand-off tests.
import { readFileSync } from "node:fs";
import { FakeClock } from "@bayon/core";
import { listRuns, phaseHandoffKey, type Db } from "@bayon/db";
import { claimCommand, completeCommand } from "@bayon/db/supervisor";
import { insertCommand, seedRows, tempDb, unwrap } from "@bayon/db/testing";
import type { FixtureScriptInput } from "@bayon/runners/fixture";
import { afterAll, expect, test, vi } from "vitest";
import { tempHome } from "./testing/fixtures.js";
import {
  TE,
  TS,
  TINY,
  handoffsOf,
  session,
  makeRepo,
  startWorld,
  worldRows,
  spawnOn,
  waitFor,
  waitState,
  type World,
} from "./testing/handoff-world.js";

vi.setConfig({ testTimeout: 30_000 });

const T0 = 1_700_000_000_000;

/** 012's own class, so a session here carries one the ticket's status ladder actually issues. */
const SPIKE = "spike";

/** Run 1 finishes (the session reaches idle); run 2 is the hand-off run, held at its gate. */
const FINISHES: FixtureScriptInput = {
  runs: [
    { appends: [{ path: "plan.md", text: "the plan\n" }], events: [TS, TE] },
    { events: [TS, TE], gate: "release" },
  ],
};

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/** A world whose ticket sits at `ticketStatus`. */
async function setup(ticketStatus: string): Promise<World> {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const home = tempHome("frm-pr-");
  const { src, mirror } = makeRepo(home.path);
  unwrap(
    await seedRows(
      t.db,
      worldRows({ script: FINISHES, src, mirror, ticketStatus }),
    ),
  );
  return startWorld(
    { db: t.db, clock, home, src, mirror, cleanupDb: t.cleanup },
    cleanups,
  );
}

/**
 * The transition's own effect, exactly as `applyPhaseHandoffIn` writes it, and then completed:
 * the state the strand leaves behind — the ask on record, the delivery gone, nothing to requeue.
 */
async function askedAndLost(
  db: Db,
  id: string,
  phaseTo: string,
): Promise<void> {
  const command = unwrap(
    await insertCommand(db, {
      type: "session.handoff",
      payload: { session_id: id, reason: "phase_change", phase_to: phaseTo },
      idempotencyKey: phaseHandoffKey(id, 1),
    }),
  );
  unwrap(await claimCommand(db, {}));
  unwrap(await completeCommand(db, command.id, { state: "done" }));
}

test("an idle holder whose ticket moved past its phase is released by the reconciler, with the command already done", async () => {
  const w = await setup("planned");
  await spawnOn(w, "s1", { run_class: SPIKE });
  await waitState(w, "s1", "idle");
  await askedAndLost(w.db, "s1", "build");
  expect(await handoffsOf(w.db, "s1")).toEqual([]);

  await w.lifecycle.reconcile();

  await waitFor(w, async () => {
    expect((await session(w.db, "s1")).state).toBe("handoff_writing");
  });
  const [row] = await handoffsOf(w.db, "s1");
  expect(row).toMatchObject({
    reason: "phase_change",
    phase_from: SPIKE,
    // `planned` asks for build: the boundary re-derived from the ticket, not read back from the
    // command — the row only says that a release was asked for.
    phase_to: "build",
  });
  const prompt = readFileSync(
    unwrap(await listRuns(w.db, "s1"))[1]?.prompt_path ?? "",
    "utf8",
  );
  expect(prompt).toContain("from spike work to build");
  await w.release("s1");
});

test("a holder whose ticket still asks for its own phase is left alone, however often the pass runs", async () => {
  const w = await setup("spiking");
  await spawnOn(w, "s2", { run_class: SPIKE });
  await waitState(w, "s2", "idle");
  await askedAndLost(w.db, "s2", "build");

  await w.lifecycle.reconcile();
  await w.lifecycle.reconcile();
  await w.lifecycle.settled();

  expect((await session(w.db, "s2")).state).toBe("idle");
  expect(await handoffsOf(w.db, "s2")).toEqual([]);
});

test("a holder no transition ever asked to release is left alone: the sweep never invents a boundary", async () => {
  // M3's B4 exactly: a worker whose `ticket_update` is refused, so nothing moved and no phase
  // ended, sitting idle on a `qa_harness` ticket its build class does not match. Releasing it
  // would end work that is going perfectly well, and the operator's own stop is what follows.
  const w = await setup("qa_harness");
  await spawnOn(w, "s3", { run_class: TINY.name });
  await waitState(w, "s3", "idle");

  await w.lifecycle.reconcile();
  await w.lifecycle.settled();

  expect((await session(w.db, "s3")).state).toBe("idle");
  expect(await handoffsOf(w.db, "s3")).toEqual([]);
});

test("a repeated pass adds no second hand-off row", async () => {
  const w = await setup("planned");
  await spawnOn(w, "s4", { run_class: SPIKE });
  await waitState(w, "s4", "idle");
  await askedAndLost(w.db, "s4", "build");

  await w.lifecycle.reconcile();
  await waitFor(w, async () => {
    expect((await session(w.db, "s4")).state).toBe("handoff_writing");
  });
  await w.lifecycle.reconcile();
  await w.lifecycle.settled();

  expect(await handoffsOf(w.db, "s4")).toHaveLength(1);
  await w.release("s4");
});
