// The supervisor's half of the stale holder's release (§13.1). A `session.handoff`
// carrying `stale_session` is what `ticket_staff` inserts when the ticket's holder has been silent
// past `watchdog.silent_ms` (packages/db/src/repos/stale-holder.ts, asserted there against the same
// payload this file delivers). Here: it ends a genuinely wedged session, leaves the packet its
// successor is staffed with, and does nothing at all to a session that has spoken since.
//
// Real processes, a real git worktree and a real SQLite file, as the rest of the hand-off tests.
import { FakeClock } from "@bayon/core";
import { listPendingHandoffs, listRuns, listSessionsInStates } from "@bayon/db";
import { seedRows, tempDb, unwrap } from "@bayon/db/testing";
import type { FixtureScriptInput } from "@bayon/runners/fixture";
import { afterAll, expect, test, vi } from "vitest";
import { CMD, spawnPayload, tempHome } from "./testing/fixtures.js";
import {
  TE,
  TICKET,
  TINY,
  TS,
  WAIT,
  handoffsOf,
  makeRepo,
  session,
  spawnOn,
  startWorld,
  waitEvent,
  waitFor,
  waitState,
  worldRows,
  type World,
} from "./testing/handoff-world.js";

vi.setConfig({ testTimeout: 30_000 });

const T0 = 1_700_000_000_000;
/** 012's `watchdog.silent_ms`: the arm's threshold and the release's, one row (025). */
const SILENT_MS = 1_800_000;

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

async function setup(o: {
  readonly script: FixtureScriptInput;
  readonly settings?: Readonly<Record<string, number>>;
}): Promise<World> {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const home = tempHome("frm-stale-");
  const { src, mirror } = makeRepo(home.path);
  unwrap(await seedRows(t.db, worldRows({ ...o, src, mirror })));
  return startWorld(
    { db: t.db, clock, home, src, mirror, cleanupDb: t.cleanup },
    cleanups,
  );
}

/** The payload `ticket_staff` inserts for a holder past the silence rule. */
const release = (id: string) => ({
  session_id: id,
  reason: "stale_session" as const,
});

/** Sessions that still hold the ticket: §13.1's "live owner". */
const holders = async (w: World): Promise<string[]> => {
  const live = unwrap(
    await listSessionsInStates(w.db, [
      "pending",
      "running",
      "idle",
      "handoff_writing",
      "human_attached",
      "awaiting_approval",
      "stopping",
    ]),
  );
  return live.filter((s) => s.ticket_id === TICKET).map((s) => s.id);
};

/** A process that answers nothing: interrupt and SIGTERM are ignored, so only a kill ends it. */
const WEDGED: FixtureScriptInput = {
  runs: [{ events: [TS], then: "hard_hang" }],
};

/** Run 1 parked at a gate the test opens: a session that is slow, not stuck. */
const GATED: FixtureScriptInput = {
  runs: [{ events: [TS, TE], gate: "release" }, { events: [TS, TE] }],
};

test("a wedged holder is ended, and its ticket is re-staffed with the packet it left", async () => {
  const w = await setup({
    script: WEDGED,
    settings: { "lifecycle.interrupt_grace_ms": 1_000 },
  });
  await spawnOn(w, "s1");
  await waitEvent(w, "s1", "turn_start");
  expect(await holders(w)).toEqual(["s1"]);

  // It goes quiet: the injected clock carries the session past watchdog.silent_ms with its run
  // still open, which is exactly what the `stale_session` arm fires on.
  await w.clock.advance(SILENT_MS);

  unwrap(await w.lifecycle.handlers.handoff.handle(release("s1"), CMD));
  // The interrupt goes unanswered; its grace runs out on the fake clock, and the process is killed.
  await vi.waitFor(async () => {
    w.clock.advance(1_000);
    expect((await session(w.db, "s1")).state).toBe("exited");
  }, WAIT);
  expect(w.stops()).toEqual(["kill"]);

  // §13.1: the live owner is gone and a pending hand-off has taken its place — never neither.
  await waitFor(w, async () => {
    const [row] = await handoffsOf(w.db, "s1");
    expect(row?.quality).toBe("degraded");
    expect(row?.reason).toBe("stale_session");
  });
  expect(await holders(w)).toEqual([]);
  const [pending] = unwrap(await listPendingHandoffs(w.db, TICKET));
  expect(pending).toBeDefined();
  // No hand-off run was paid for: a wedged process cannot write a packet (handoff.ts).
  expect(unwrap(await listRuns(w.db, "s1"))).toHaveLength(1);

  // Re-staffed: `ticket_staff`'s spawn for a ticket with a pending hand-off, which is what the
  // ticket could not have at all while s1 held it (staffing.test.ts asserts this payload).
  unwrap(
    await w.lifecycle.handlers.spawn.handle(
      spawnPayload("s2", {
        workspace_id: "ws",
        ticket_id: TICKET,
        run_class: TINY.name,
        handoff_id: pending?.id ?? "",
      }),
      CMD,
    ),
  );
  await waitState(w, "s2", "running");
  expect(await holders(w)).toEqual(["s2"]);
});

test("a holder that has spoken since keeps its ticket: the ask is spent, not obeyed", async () => {
  const w = await setup({ script: GATED });
  await spawnOn(w, "s1");
  await waitState(w, "s1", "running");
  await w.clock.advance(SILENT_MS);

  // The session answers between the staffing call and this claim — the window the command path
  // cannot see, and the reason the silence rule is asked again here rather than trusted.
  await w.release("s1");
  await waitState(w, "s1", "idle");

  expect(
    unwrap(await w.lifecycle.handlers.handoff.handle(release("s1"), CMD)),
  ).toEqual({
    session_id: "s1",
    noop: "no longer silent",
  });
  await w.lifecycle.settled();
  expect((await session(w.db, "s1")).state).toBe("idle");
  expect(await handoffsOf(w.db, "s1")).toEqual([]);
  expect(await holders(w)).toEqual(["s1"]);
});

test("a release for a session already gone is done, not a failed command", async () => {
  const w = await setup({ script: { runs: [{ events: [TS, TE] }] } });
  await spawnOn(w, "s1");
  await waitState(w, "s1", "idle");
  unwrap(
    await w.lifecycle.handlers.stop.handle(
      { session_id: "s1", mode: "graceful" },
      CMD,
    ),
  );
  // A graceful stop suspends it: `resumable`, one of the states a release has nothing to ask of.
  await waitState(w, "s1", "resumable");

  // The server noticed a silence and the session stopped in the meantime: there is nothing left
  // to ask for, so the command is done rather than a conflict someone must clear by hand.
  expect(
    unwrap(await w.lifecycle.handlers.handoff.handle(release("s1"), CMD)),
  ).toEqual({
    session_id: "s1",
    noop: "resumable",
  });
});
