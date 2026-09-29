// The degraded path (§7.4, §11): a kill -9, a supervisor restart inside
// handoff_writing (never adopted, review HIGH 2), and a crash between the seal and the finalize.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock, HandoffFacts } from "@bayon/core";
import { listSessionsInStates, type Db } from "@bayon/db";
import { sealHandoff } from "@bayon/db/supervisor";
import {
  seedRows,
  tempDb,
  unwrap,
  writeHandoffJudgement,
} from "@bayon/db/testing";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import {
  createFixtureAdapter,
  type FixtureScriptInput,
} from "@bayon/runners/fixture";
import { afterAll, expect, test, vi } from "vitest";
import type { HandoffPending, SessionEnded } from "./context.js";
import { EDGES } from "./fsm.js";
import {
  CMD,
  EXECUTOR_ID,
  startLifecycle,
  tempHome,
} from "./testing/fixtures.js";
import {
  TE,
  TS,
  WAIT,
  capturing,
  fileHash,
  git,
  handoffsOf,
  makeRepo,
  session,
  spawnOn,
  waitEvent,
  waitFor,
  waitState,
  worktreeOf,
  worldRows,
  type World,
} from "./testing/handoff-world.js";

// Real processes and git: more than the default 5 s on a loaded host.
vi.setConfig({ testTimeout: 30_000 });

const T0 = 1_700_000_000_000;
const JUDGEMENT = {
  goal_line: "Carry on.",
  decisions_md: null,
  traps_md: null,
  next_steps_md: "1. Read.\n2. Accept.\n3. Go.",
  open_questions_md: null,
  pointers: [],
};

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

const LIVE = [
  "running",
  "idle",
  "stopping",
  "handoff_writing",
  "handed_off",
] as const;

async function reap(db: Db, executor: LocalExecutor): Promise<void> {
  const live = await listSessionsInStates(db, [...LIVE]);
  for (const s of live.ok ? live.value : []) {
    if (s.executor_ref !== null) await executor.cleanup(s.executor_ref, "hard");
  }
}

/** A lifecycle on `db` and `home`, with its own executor and a capturing fixture adapter. */
async function world(
  db: Db,
  clock: FakeClock,
  home: string,
  repo: { src: string; mirror: string },
  boot = true,
  resumable = true,
): Promise<World> {
  const slots = new SlotCounter(4);
  const executor = new LocalExecutor({ id: EXECUTOR_ID, slots });
  const base = createFixtureAdapter({ clock });
  // §5.1's capability, from the adapter object: `adoptable` reads `adapter.caps().resumable`, not
  // the runners row (reconciler.ts) — the same override reconciler.test.ts uses.
  const fixture = capturing(
    resumable ? base : { ...base, caps: () => ({ ...base.caps(), resumable }) },
  );
  const started = await startLifecycle({
    db,
    clock,
    frmHome: home,
    executor,
    slots,
    adapter: fixture.adapter,
    boot,
  });
  cleanups.unshift(async () => {
    await started.lifecycle.shutdown();
    await reap(db, executor);
  });
  return {
    ...started,
    db,
    clock,
    executor,
    slots,
    ...repo,
    release: fixture.release,
    adopts: fixture.adopts,
    stops: fixture.stops,
  };
}

async function setup(
  script: FixtureScriptInput,
  settings: Readonly<Record<string, number>> = {},
  resumable = true,
) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const home = tempHome("frm-dg-");
  const repo = makeRepo(home.path);
  unwrap(await seedRows(t.db, worldRows({ script, settings, ...repo })));
  cleanups.push(async () => {
    t.cleanup();
    home.cleanup();
  });
  const w = await world(t.db, clock, home.path, repo, true, resumable);
  return { w, home: home.path, repo };
}

const pidOf = (ref: string | null): number => Number(ref?.split(":")[1]);

test("a kill -9 leaves a degraded packet whose file list matches git status (ticket test 2)", async () => {
  const { w } = await setup(
    {
      runs: [
        {
          appends: [
            { path: "README.md", text: "edited\n" },
            { path: "new.txt", text: "new\n" },
          ],
          events: [TS],
          gate: "release",
        },
      ],
      crash_on_resume: true,
    },
    { "lifecycle.adopt_max": 1 },
  );
  const pending: HandoffPending[] = [];
  w.lifecycle.onHandoffPending((e) => pending.push(e));
  const ended: SessionEnded[] = [];
  w.lifecycle.onSessionEnded((e) => ended.push(e));
  await spawnOn(w, "s1");
  await waitEvent(w, "s1", "turn_start");
  // A commit since base (new.txt), a dirty tracked file (README.md), an untracked one.
  const wt = await worktreeOf(w.db, "s1");
  git(wt, "add", "new.txt");
  git(wt, "commit", "-q", "-m", "committed new");
  writeFileSync(join(wt, "later.txt"), "later\n");
  process.kill(pidOf((await session(w.db, "s1")).executor_ref), "SIGKILL");

  // Adopted once (resumable), its resume crashes, then adopt_max: markDead.
  await waitFor(w, async () => {
    await w.lifecycle.reconcile();
    expect((await session(w.db, "s1")).state).toBe("exited");
  });
  expect(w.adopts()).toBe(1);
  expect((await session(w.db, "s1")).exit_reason).toBe("error");
  const [row] = await handoffsOf(w.db, "s1");
  expect(row).toMatchObject({ reason: "session_death", quality: "degraded" });
  const facts = HandoffFacts.parse(JSON.parse(row?.facts_json ?? "{}"));
  const files = facts.repos[0]?.files ?? [];
  // git status as it is, untrimmed: each -z entry is `XY path`.
  const status = execFileSync(
    "git",
    ["status", "--porcelain", "-z", "--untracked-files=all"],
    { cwd: wt, encoding: "utf8" },
  )
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => entry.slice(3))
    .toSorted();
  expect(
    files.filter((f) => f.code !== "committed").map((f) => f.path),
  ).toEqual(status);
  expect(status).toEqual(["README.md", "later.txt"]);
  expect(files.find((f) => f.path === "new.txt")?.code).toBe("committed");
  expect(fileHash(join(wt, row?.packet_path ?? ""))).toBe(row?.packet_hash);
  // The degraded row is pending the moment it is written: announced once, as a completion wake.
  // With the project of the session that left it: whose orchestrators it wakes.
  expect(pending).toEqual([
    {
      handoffId: row?.id,
      ticketId: row?.ticket_id,
      workspaceId: (await session(w.db, "s1")).workspace_id,
      quality: "degraded",
      at: expect.any(Number),
    },
  ]);
  // Exactly one completion for the pulse scheduler (wirePulse): the pending announcement. The end
  // that left it pending says so, and is not a second one.
  expect(ended).toMatchObject([{ sessionId: "s1", handoffPending: true }]);
  const completions =
    pending.length +
    ended.filter((e) => e.ticketId !== null && !e.handoffPending).length;
  expect(completions).toBe(1);
});

test("a supervisor restart inside handoff_writing never resumes it: a degraded packet", async () => {
  const script: FixtureScriptInput = {
    runs: [
      { events: [TS], gate: "release" },
      { events: [TS, TE], gate: "release" },
    ],
  };
  const { w, home, repo } = await setup(script);
  await spawnOn(w, "s1");
  await waitState(w, "s1", "running");
  unwrap(
    await w.lifecycle.handlers.handoff.handle(
      { session_id: "s1", reason: "operator" },
      CMD,
    ),
  );
  await waitState(w, "s1", "handoff_writing");
  unwrap(await writeHandoffJudgement(w.db, "s1", JUDGEMENT));
  // The supervisor goes away (no kills); a new one boots on the same database. Its boot pass
  // kills the unowned process and re-probes it on the (fake) clock, which the test advances.
  await w.lifecycle.shutdown();
  const again = await world(w.db, w.clock, home, repo, false);
  const booting = again.lifecycle.boot();
  await vi.waitFor(async () => {
    again.clock.advance(100);
    expect((await session(w.db, "s1")).state).toBe("exited");
  }, WAIT);
  unwrap(await booting);
  await again.lifecycle.settled();
  expect(again.adopts()).toBe(0);
  const [row] = await handoffsOf(w.db, "s1");
  expect(row?.quality).toBe("degraded");
  const text = readFileSync(
    join(await worktreeOf(w.db, "s1"), row?.packet_path ?? ""),
    "utf8",
  );
  expect(text).toContain("## Written before the session died — unverified");
});

test("a crash between the seal and the finalize: the reconciler's sweep finalizes it", async () => {
  const { w } = await setup({
    runs: [
      { events: [TS], gate: "release" },
      { events: [TS, TE], gate: "release" },
    ],
  });
  await spawnOn(w, "s1");
  await waitState(w, "s1", "running");
  unwrap(
    await w.lifecycle.handlers.handoff.handle(
      { session_id: "s1", reason: "operator" },
      CMD,
    ),
  );
  await waitState(w, "s1", "handoff_writing");
  unwrap(await writeHandoffJudgement(w.db, "s1", JUDGEMENT));
  // The seal commits, then the supervisor dies before its finalize.
  unwrap(
    await sealHandoff(w.db, {
      session_id: "s1",
      handOff: { ...EDGES.handOff, patch: { exit_reason: "ok" } },
      handoffFail: {
        ...EDGES.handoffFail,
        patch: { exit_reason: "abandoned" },
      },
      failed: false,
    }),
  );
  expect((await handoffsOf(w.db, "s1"))[0]?.quality).toBe("writing");
  await w.lifecycle.reconcile();
  const [row] = await handoffsOf(w.db, "s1");
  expect(row?.quality).toBe("full");
  expect(
    fileHash(join(await worktreeOf(w.db, "s1"), row?.packet_path ?? "")),
  ).toBe(row?.packet_hash);
});

test("a run that passed its wall clock while the supervisor was down: exited(timeout) and a degraded packet, never adopted", async () => {
  const { w, home, repo } = await setup({
    runs: [{ events: [TS], gate: "release" }],
  });
  await spawnOn(w, "s1");
  await waitEvent(w, "s1", "turn_start");
  // The supervisor goes away (its run timer with it), and stays away past TINY's wall clock.
  await w.lifecycle.shutdown();
  await w.clock.advance(3_600_001);
  const again = await world(w.db, w.clock, home, repo, false);
  const booting = again.lifecycle.boot();
  await vi.waitFor(async () => {
    again.clock.advance(100); // the boot pass re-probes the unowned process it killed
    expect((await session(w.db, "s1")).state).toBe("exited");
  }, WAIT);
  unwrap(await booting);
  await again.lifecycle.settled();
  expect(again.adopts()).toBe(0);
  // The outcome stays timeout; the class says the restart ended it.
  expect(await session(w.db, "s1")).toMatchObject({
    exit_reason: "timeout",
    error_class: "supervisor_restart",
  });
  const [row] = await handoffsOf(w.db, "s1");
  expect(row).toMatchObject({ quality: "degraded", reason: "session_death" });
  expect(JSON.parse(row?.facts_json ?? "{}")).toMatchObject({
    why: "the run timed out",
  });
});

// the scenario an earlier change deferred: "a non-resumable session with a dirty worktree ends
// exited(error) with a degraded hand-off." Covered here rather than as a `--m4` phase, and that is a
// deliberate retirement of the venue, not of the assertion. A smoke phase would need a second
// fixture-derived runner registration declaring resumable: false — which needs its own conformance
// kit and, because 012 seeds admission.require_certified=1, its own certification run in every
// `--m4`: a third full suite, roughly +35 s on a mode that already costs ~80 s in every merge chain.
// Nothing about the assertion needs a live fleet: it is a real git worktree, a real process killed
// with SIGKILL, and three facts about what the reconciler does next.
test("an earlier change S2: a session that cannot resume dies exited(error) with a degraded packet, and its dirty worktree is kept", async () => {
  const { w } = await setup(
    {
      runs: [
        {
          appends: [{ path: "README.md", text: "uncommitted when it died\n" }],
          events: [TS],
          gate: "release",
        },
      ],
    },
    {},
    false, // resumable: false — the half of S2 the fixture runner could not give an earlier change
  );
  await spawnOn(w, "s1");
  await waitEvent(w, "s1", "turn_start");
  const wt = await worktreeOf(w.db, "s1");
  writeFileSync(join(wt, "later.txt"), "not committed either\n");

  process.kill(pidOf((await session(w.db, "s1")).executor_ref), "SIGKILL");
  await waitFor(w, async () => {
    await w.lifecycle.reconcile();
    expect((await session(w.db, "s1")).state).toBe("exited");
  });

  // 1. Never adopted: a runner that declares it cannot resume is not asked to.
  expect(w.adopts()).toBe(0);
  // 2. exited(error), and the class says why — no terminal event ever arrived (Invariant 3).
  const dead = await session(w.db, "s1");
  expect(dead.exit_reason).toBe("error");
  expect(dead.error_class).toBe("runner_exited_without_terminal");
  // 3. A degraded packet, holding the work in progress the session never got to describe.
  const [row] = await handoffsOf(w.db, "s1");
  expect(row).toMatchObject({ reason: "session_death", quality: "degraded" });
  const facts = HandoffFacts.parse(JSON.parse(row?.facts_json ?? "{}"));
  expect(
    (facts.repos[0]?.files ?? [])
      .filter((f) => f.code !== "committed")
      .map((f) => f.path)
      .toSorted(),
  ).toEqual(["README.md", "later.txt"]);
  expect(fileHash(join(wt, row?.packet_path ?? ""))).toBe(row?.packet_hash);
  // And the worktree itself survives: work in progress is never deleted to tidy up (§9.2).
  expect(readFileSync(join(wt, "later.txt"), "utf8")).toBe(
    "not committed either\n",
  );
});
