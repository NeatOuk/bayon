// The supervisor's half of the phase-boundary hand-off (§7.1 row four): a
// `session.handoff` carrying `phase_change` waits for the open run to end rather than interrupting
// it, then writes a full packet whose header names the phase the successor takes up. Real
// processes, a real git worktree and a real SQLite file, as the rest of the hand-off tests.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock } from "@bayon/core";
import { listRuns } from "@bayon/db";
import {
  seedRows,
  tempDb,
  unwrap,
  writeHandoffJudgement,
} from "@bayon/db/testing";
import type { FixtureScriptInput } from "@bayon/runners/fixture";
import { afterAll, expect, test, vi } from "vitest";
import { CMD, tempHome } from "./testing/fixtures.js";
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
  worktreeOf,
  type World,
} from "./testing/handoff-world.js";

vi.setConfig({ testTimeout: 30_000 });

const T0 = 1_700_000_000_000;

const JUDGEMENT = {
  goal_line: "The plan is in; build it.",
  decisions_md: "- One file, no new dependency.",
  traps_md: "- The fixture appends, never rewrites.",
  next_steps_md: "1. Read the plan.\n2. Write the code.\n3. Request review.",
  open_questions_md: null,
  pointers: ["plan: .foreman/plan.md"],
};

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/** The rows, then the wiring: only a test file may reach @bayon/db/testing (no-sql.test.ts). */
async function setup(o: {
  readonly script: FixtureScriptInput;
  readonly settings?: Readonly<Record<string, number>>;
  readonly ticketStatus?: string;
}): Promise<World> {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const home = tempHome("frm-ho-");
  const { src, mirror } = makeRepo(home.path);
  unwrap(await seedRows(t.db, worldRows({ ...o, src, mirror })));
  return startWorld(
    { db: t.db, clock, home, src, mirror, cleanupDb: t.cleanup },
    cleanups,
  );
}

/** Run 1 parked at its gate (so the session is `running`), then the hand-off run. */
const GATED: FixtureScriptInput = {
  runs: [
    { events: [TS], gate: "release" },
    { events: [TS, TE], gate: "release" },
  ],
};

/** Run 1 runs to its end, so the session reaches idle; run 2 is the hand-off run. */
const FINISHES: FixtureScriptInput = {
  runs: [
    { appends: [{ path: "plan.md", text: "the plan\n" }], events: [TS, TE] },
    { events: [TS, TE], gate: "release" },
  ],
};

const phaseChange = (phaseTo?: string) => ({
  session_id: "s1",
  reason: "phase_change" as const,
  ...(phaseTo === undefined ? {} : { phase_to: phaseTo }),
});

/** Waits until the hand-off run is open, with run 1 in `run1State`. */
const atHandoffGate = (w: World, run1State: string) =>
  waitFor(w, async () => {
    expect((await session(w.db, "s1")).state).toBe("handoff_writing");
    const runs = unwrap(await listRuns(w.db, "s1"));
    expect(runs.map((r) => [r.seq, r.trigger, r.state])).toEqual([
      [1, "operator", run1State],
      [2, "handoff", "running"],
    ]);
  });

test("a phase_change waits for the open run to end, then hands off with the boundary in the packet", async () => {
  const w = await setup({ script: GATED });
  await spawnOn(w, "s1");
  await waitState(w, "s1", "running");

  expect(
    unwrap(
      await w.lifecycle.handlers.handoff.handle(phaseChange("build"), CMD),
    ),
  ).toEqual({ session_id: "s1", deferred: true });

  // Nothing was interrupted: the turn is still open, and no hand-off row exists yet.
  await w.lifecycle.settled();
  expect((await session(w.db, "s1")).state).toBe("running");
  expect(await handoffsOf(w.db, "s1")).toEqual([]);
  expect(unwrap(await listRuns(w.db, "s1"))).toHaveLength(1);

  // The run ends of its own accord; the deferred hand-off starts from idle.
  await w.release("s1");
  await atHandoffGate(w, "ok");

  // The prompt tells the agent to write forward, for the phase that takes over.
  const runs = unwrap(await listRuns(w.db, "s1"));
  const prompt = readFileSync(runs[1]?.prompt_path ?? "", "utf8");
  expect(runs[1]?.template_id).toBe("handoff_request.v2");
  expect(prompt).toContain("Where this ticket goes next");
  expect(prompt).toContain(`from ${TINY.name} work to build`);

  unwrap(await writeHandoffJudgement(w.db, "s1", JUDGEMENT));
  await w.release("s1");
  await waitState(w, "s1", "handed_off");

  const [row] = await handoffsOf(w.db, "s1");
  expect(row).toMatchObject({
    reason: "phase_change",
    quality: "full",
    phase_from: TINY.name,
    // The one field that says what changed now says it (both writers used to hardcode it equal).
    phase_to: "build",
  });
  const text = readFileSync(
    join(await worktreeOf(w.db, "s1"), row?.packet_path ?? ""),
    "utf8",
  );
  expect(text).toContain(`${TINY.name} → build`);
  expect(text).toContain("reason: phase_change · quality: full");
  expect(text).toContain(JUDGEMENT.goal_line);
  // The successor, not the predecessor, ends the session: exit_reason is ok, never abandoned.
  expect(await session(w.db, "s1")).toMatchObject({ exit_reason: "ok" });
});

test("a phase_change on an idle session hands off at once, with no deferral", async () => {
  const w = await setup({ script: FINISHES });
  await spawnOn(w, "s1");
  await waitState(w, "s1", "idle");
  expect(
    unwrap(
      await w.lifecycle.handlers.handoff.handle(phaseChange("build"), CMD),
    ),
  ).toEqual({ session_id: "s1", deferred: false });
  await atHandoffGate(w, "ok");
});

test("a phase_change with no next phase leaves the header as it was: no phase was decided", async () => {
  // The boundaries into plan_review, code_review, qa_harness and qa_human: a gate or a human moves
  // the ticket on, and only then is the next run class known.
  const w = await setup({ script: FINISHES });
  await spawnOn(w, "s1");
  await waitState(w, "s1", "idle");
  unwrap(await w.lifecycle.handlers.handoff.handle(phaseChange(), CMD));
  await atHandoffGate(w, "ok");
  const prompt = readFileSync(
    unwrap(await listRuns(w.db, "s1"))[1]?.prompt_path ?? "",
    "utf8",
  );
  expect(prompt).not.toContain("Where this ticket goes next");
  const [row] = await handoffsOf(w.db, "s1");
  expect(row).toMatchObject({ phase_from: TINY.name, phase_to: TINY.name });
});

test("a phase_change for a session already handing off, or gone, is done rather than failed", async () => {
  // One turn can cross two boundaries — each status move ships its own command — and the ticket
  // can close between a move and its claim. A phase change is the server noticing something, not
  // an instruction to this session, so a late one is a no-op and never a failed command.
  const w = await setup({ script: FINISHES });
  await spawnOn(w, "s1");
  await waitState(w, "s1", "idle");
  unwrap(await w.lifecycle.handlers.handoff.handle(phaseChange("build"), CMD));
  await atHandoffGate(w, "ok");

  expect(
    unwrap(
      await w.lifecycle.handlers.handoff.handle(phaseChange("build"), CMD),
    ),
  ).toEqual({ session_id: "s1", noop: "handoff_writing" });

  unwrap(await writeHandoffJudgement(w.db, "s1", JUDGEMENT));
  await w.release("s1");
  await waitState(w, "s1", "handed_off");
  expect(
    unwrap(
      await w.lifecycle.handlers.handoff.handle(phaseChange("build"), CMD),
    ),
  ).toEqual({ session_id: "s1", noop: "handed_off" });
  expect(await handoffsOf(w.db, "s1")).toHaveLength(1);

  // An operator's hand-off in the same place is still a conflict: that one is an instruction.
  expect(
    await w.lifecycle.handlers.handoff.handle(
      { session_id: "s1", reason: "operator" },
      CMD,
    ),
  ).toMatchObject({ ok: false, error: { class: "conflict" } });
});

test("two boundaries in one turn leave one hand-off, carrying the later phase", async () => {
  const w = await setup({ script: GATED });
  await spawnOn(w, "s1");
  await waitState(w, "s1", "running");
  const handoff = w.lifecycle.handlers.handoff;
  // The M3 shape: `staffed → spiking` then `spiking → planned` inside one turn.
  expect(unwrap(await handoff.handle(phaseChange("spike"), CMD))).toEqual({
    session_id: "s1",
    deferred: true,
  });
  expect(unwrap(await handoff.handle(phaseChange("build"), CMD))).toEqual({
    session_id: "s1",
    deferred: true,
  });
  await w.release("s1");
  await atHandoffGate(w, "ok");
  unwrap(await writeHandoffJudgement(w.db, "s1", JUDGEMENT));
  await w.release("s1");
  await waitState(w, "s1", "handed_off");
  const rows = await handoffsOf(w.db, "s1");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ reason: "phase_change", phase_to: "build" });
});
