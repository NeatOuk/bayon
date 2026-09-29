// The hand-off write path end to end: the fixture runner on the local
// executor, a real git mirror and worktree, a real SQLite file, a FakeClock. The test plays the
// API's handoff_write through writeHandoffJudgement (wires the tool).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock } from "@bayon/core";
import {
  getEventsSince,
  listNeedsAttention,
  listRuns,
  listTicketEvents,
  type Db,
} from "@bayon/db";
import { updateSessionState } from "@bayon/db/supervisor";
import {
  seedRows,
  tempDb,
  unwrap,
  writeHandoffJudgement,
} from "@bayon/db/testing";
import type { FixtureScriptInput } from "@bayon/runners/fixture";
import { afterAll, describe, expect, test, vi } from "vitest";
import type { HandoffPending } from "./context.js";
import { CMD, tempHome } from "./testing/fixtures.js";
import {
  TE,
  TICKET,
  TS,
  fileHash,
  git,
  handoffsOf,
  session,
  makeRepo,
  startWorld,
  worldRows,
  spawnOn,
  turns,
  WAIT,
  waitEvent,
  waitFor,
  waitState,
  worktreeOf,
  type World,
} from "./testing/handoff-world.js";

// Real processes and git: more than the default 5 s on a loaded host.
vi.setConfig({ testTimeout: 30_000 });

const T0 = 1_700_000_000_000;

const JUDGEMENT = {
  goal_line: "Finish the README.",
  decisions_md: "- Keep it short.",
  traps_md: "- The fixture appends, never rewrites.",
  next_steps_md: "1. Read the packet.\n2. Accept it.\n3. Carry on.",
  open_questions_md: null,
  pointers: ["plan: none"],
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

/** Waits until the handoff run (run 2) is open and parked at its gate. */
async function atHandoffGate(w: World, id: string): Promise<void> {
  await waitFor(w, async () => {
    expect((await session(w.db, id)).state).toBe("handoff_writing");
    const runs = unwrap(await listRuns(w.db, id));
    expect(runs.map((r) => [r.seq, r.trigger, r.state])).toEqual([
      [1, "operator", "interrupted"],
      [2, "handoff", "running"],
    ]);
    const kinds = unwrap(
      await getEventsSince(w.db, { sessionId: id, since: 0, limit: 1000 }),
    ).rows.filter((e) => e.run_id === runs[1]?.id);
    expect(kinds.length).toBeGreaterThan(0);
  });
}

const pendingRefs = async (db: Db) =>
  unwrap(await listNeedsAttention(db))
    .filter((row) => row.why === "handoff_pending")
    .map((row) => row.ref);

const auditSteps = async (db: Db) =>
  unwrap(
    await listTicketEvents(db, { ticket_id: TICKET, since: 0, limit: 100 }),
  )
    .rows.filter((e) => e.kind === "handoff" && e.actor_kind === "supervisor")
    .map((e) => (JSON.parse(e.payload_json ?? "{}") as { step?: string }).step);

/** Run 1 edits the README and passes the ceiling, then waits; run 2 is the handoff run. */
const CEILING = (
  run2: FixtureScriptInput["runs"][number],
): FixtureScriptInput => ({
  runs: [
    {
      appends: [{ path: "README.md", text: "more\n" }],
      events: turns(3),
      gate: "release",
    },
    run2,
  ],
});

describe("the turn ceiling (ticket test 1)", () => {
  test("hands off with a full packet and does no other work afterwards", async () => {
    const w = await setup({
      script: CEILING({ events: turns(1), gate: "release" }),
    });
    const pending: HandoffPending[] = [];
    w.lifecycle.onHandoffPending((e) => pending.push(e));
    await spawnOn(w, "s1");
    await atHandoffGate(w, "s1");
    // While it is written, the row is not pending anywhere (review HIGH 4), nor announced.
    const [writing] = await handoffsOf(w.db, "s1");
    expect(writing?.quality).toBe("writing");
    expect(await pendingRefs(w.db)).toEqual([]);
    expect(pending).toEqual([]);

    unwrap(await writeHandoffJudgement(w.db, "s1", JUDGEMENT));
    await w.release("s1");
    await waitState(w, "s1", "handed_off");

    const [row] = await handoffsOf(w.db, "s1");
    expect(row).toMatchObject({
      reason: "turn_ceiling",
      quality: "full",
      packet_path: ".foreman/handoff-1.md",
    });
    const wt = await worktreeOf(w.db, "s1");
    const file = join(wt, ".foreman/handoff-1.md");
    expect(fileHash(file)).toBe(row?.packet_hash);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("reason: turn_ceiling · quality: full");
    expect(text).toContain("M README.md +1 -0");
    expect(text).toContain(JUDGEMENT.goal_line);
    expect(row?.tokens_est ?? Infinity).toBeLessThanOrEqual(1200);

    // Exactly the one handoff run after the ceiling, and nothing after its terminal.
    const runs = unwrap(await listRuns(w.db, "s1"));
    expect(runs.map((r) => [r.trigger, r.state])).toEqual([
      ["operator", "interrupted"],
      ["handoff", "ok"],
    ]);
    expect(runs[1]?.template_id).not.toBeNull();
    const events = unwrap(
      await getEventsSince(w.db, { sessionId: "s1", since: 0, limit: 1000 }),
    ).rows;
    expect(events.at(-1)).toMatchObject({
      kind: "terminal",
      run_id: runs[1]?.id,
    });
    expect(await session(w.db, "s1")).toMatchObject({
      exit_reason: "ok",
      handoff_out_id: row?.id,
    });
    expect(await auditSteps(w.db)).toEqual(["begin", "seal", "finalize"]);
    // Unaccepted, it is pending (ticket test 3), announced once; packets never show in git status.
    expect(await pendingRefs(w.db)).toEqual([row?.id]);
    expect(pending).toEqual([
      {
        handoffId: row?.id,
        ticketId: TICKET,
        workspaceId: (await session(w.db, "s1")).workspace_id,
        quality: "full",
        at: expect.any(Number),
      },
    ]);
    expect(git(wt, "status", "--porcelain")).toBe("M README.md");
    expect(readFileSync(join(w.mirror, "info/exclude"), "utf8")).toContain(
      ".foreman/",
    );
  });

  test("a handoff run past its turn cap is interrupted: degraded, abandoned", async () => {
    const w = await setup({
      script: CEILING({ events: turns(4), gate: "release" }),
    });
    await spawnOn(w, "s1");
    await waitState(w, "s1", "exited");
    expect(await session(w.db, "s1")).toMatchObject({
      exit_reason: "abandoned",
      error_class: "over_budget",
    });
    const [row] = await handoffsOf(w.db, "s1");
    expect(row?.quality).toBe("degraded");
    const text = readFileSync(
      join(await worktreeOf(w.db, "s1"), row?.packet_path ?? ""),
      "utf8",
    );
    expect(text).toContain("(no judgement: the cap hit)");
  });

  test("no handoff_write by the terminal: degraded, abandoned", async () => {
    const w = await setup({ script: CEILING({ events: turns(1) }) });
    await spawnOn(w, "s1");
    await waitState(w, "s1", "exited");
    expect((await session(w.db, "s1")).exit_reason).toBe("abandoned");
    const [row] = await handoffsOf(w.db, "s1");
    expect(row?.quality).toBe("degraded");
    expect(await pendingRefs(w.db)).toEqual([row?.id]);
  });

  test("the wall clock after a handoff_write: the judgement stays, unverified", async () => {
    const w = await setup({
      script: CEILING({ events: turns(1), gate: "release" }),
      settings: { "handoff.wall_clock_ms": 60_000 },
    });
    await spawnOn(w, "s1");
    await atHandoffGate(w, "s1");
    unwrap(await writeHandoffJudgement(w.db, "s1", JUDGEMENT));
    w.clock.advance(60_000);
    await waitState(w, "s1", "exited");
    expect(await session(w.db, "s1")).toMatchObject({
      exit_reason: "abandoned",
      error_class: "timeout",
    });
    const [row] = await handoffsOf(w.db, "s1");
    const text = readFileSync(
      join(await worktreeOf(w.db, "s1"), row?.packet_path ?? ""),
      "utf8",
    );
    expect(row?.quality).toBe("degraded");
    expect(text).toContain(
      "## Written before the wall clock ran out — unverified",
    );
    expect(text).toContain(JUDGEMENT.goal_line);
  });
});

describe("an open run that never answers its interrupt (design §3 op A step 2)", () => {
  test("is killed, and the hand-off ends degraded and abandoned", async () => {
    const w = await setup({
      // hard_hang ignores interrupt and SIGTERM: only a kill ends it.
      script: { runs: [{ events: [TS], then: "hard_hang" }] },
      settings: { "lifecycle.interrupt_grace_ms": 1_000 },
    });
    await spawnOn(w, "s1");
    await waitEvent(w, "s1", "turn_start");
    unwrap(
      await w.lifecycle.handlers.handoff.handle(
        { session_id: "s1", reason: "operator" },
        CMD,
      ),
    );
    // The interrupt goes unanswered; its grace runs out on the fake clock.
    await vi.waitFor(async () => {
      w.clock.advance(1_000);
      expect((await session(w.db, "s1")).state).toBe("exited");
    }, WAIT);
    expect(w.stops()).toEqual(["kill"]);
    expect(await session(w.db, "s1")).toMatchObject({
      exit_reason: "abandoned",
      error_class: "interrupted",
    });
    // The seal commits first; the packet is finalized right after it.
    await waitFor(w, async () => {
      const [row] = await handoffsOf(w.db, "s1");
      expect(row?.quality).toBe("degraded");
    });
    // No handoff run was started for a wedged process.
    expect(unwrap(await listRuns(w.db, "s1"))).toHaveLength(1);
  });
});

describe("session.handoff", () => {
  const GATED: FixtureScriptInput = {
    runs: [
      { events: [TS], gate: "release" },
      { events: [TS, TE], gate: "release" },
    ],
  };

  test("agent_request hands off once; a second request is a conflict", async () => {
    const w = await setup({ script: GATED });
    await spawnOn(w, "s1");
    await waitState(w, "s1", "running");
    const handoff = w.lifecycle.handlers.handoff;
    const payload = {
      session_id: "s1",
      reason: "agent_request" as const,
      note: "stuck",
    };
    unwrap(await handoff.handle(payload, CMD));
    await atHandoffGate(w, "s1");
    expect(await handoff.handle(payload, CMD)).toMatchObject({
      ok: false,
      error: { class: "conflict" },
    });
    const runs = unwrap(await listRuns(w.db, "s1"));
    const prompt = readFileSync(runs[1]?.prompt_path ?? "", "utf8");
    expect(prompt).toContain("agent_request: stuck");
    expect(prompt).toContain("Facts (generated by foreman — do not edit)");
    unwrap(await writeHandoffJudgement(w.db, "s1", JUDGEMENT));
    await w.release("s1");
    await waitState(w, "s1", "handed_off");
    expect(await handoffsOf(w.db, "s1")).toHaveLength(1);
  });

  test("a session.handoff re-delivered after a crash (attempt 2) finds the hand-off begun: ok, and still one row", async () => {
    const w = await setup({ script: GATED });
    await spawnOn(w, "s1");
    await waitState(w, "s1", "running");
    const handoff = w.lifecycle.handlers.handoff;
    const payload = { session_id: "s1", reason: "agent_request" as const };
    unwrap(await handoff.handle(payload, CMD));
    await atHandoffGate(w, "s1");
    expect(
      unwrap(await handoff.handle(payload, { ...CMD, attempts: 2 })),
    ).toEqual({ session_id: "s1", replay: true });
    unwrap(await writeHandoffJudgement(w.db, "s1", JUDGEMENT));
    await w.release("s1");
    await waitState(w, "s1", "handed_off");
    expect(
      unwrap(await handoff.handle(payload, { ...CMD, attempts: 2 })),
    ).toEqual({ session_id: "s1", replay: true });
    expect(await handoffsOf(w.db, "s1")).toHaveLength(1);
  });

  test("a session that holds no ticket cannot hand off", async () => {
    const w = await setup({ script: GATED, ticketStatus: "done" });
    await spawnOn(w, "s1");
    await waitState(w, "s1", "running");
    expect(
      await w.lifecycle.handlers.handoff.handle(
        { session_id: "s1", reason: "operator" },
        CMD,
      ),
    ).toMatchObject({ ok: false, error: { class: "validation" } });
  });
});

describe("the exit law and the holding rule (§3.2, review HIGH 3)", () => {
  const ONE_RUN: FixtureScriptInput = {
    runs: [{ appends: [{ path: "notes.txt", text: "n\n" }], events: [TS, TE] }],
  };
  const stop = (w: World, id: string) =>
    w.lifecycle.handlers.stop.handle({ session_id: id, mode: "graceful" }, CMD);

  test("an ok exit while holding the ticket is abandoned, with a degraded row", async () => {
    const w = await setup({ script: ONE_RUN });
    await spawnOn(w, "s1");
    await waitState(w, "s1", "idle");
    unwrap(await stop(w, "s1"));
    await waitFor(w, async () => {
      expect((await session(w.db, "s1")).exit_reason).toBe("abandoned");
    });
    const [row] = await handoffsOf(w.db, "s1");
    expect(row).toMatchObject({ reason: "operator", quality: "degraded" });
    const text = readFileSync(
      join(await worktreeOf(w.db, "s1"), row?.packet_path ?? ""),
      "utf8",
    );
    expect(text).toContain("?? notes.txt");
    expect(await auditSteps(w.db)).toEqual(["degraded"]);
  });

  test("a closed ticket is not held: the exit stays ok and leaves no row", async () => {
    const w = await setup({ script: ONE_RUN, ticketStatus: "done" });
    await spawnOn(w, "s1");
    await waitState(w, "s1", "idle");
    unwrap(await stop(w, "s1"));
    await waitFor(w, async () => {
      expect((await session(w.db, "s1")).exit_reason).toBe("ok");
    });
    expect(await handoffsOf(w.db, "s1")).toEqual([]);
  });

  test("a successor that dies before accepting leaves no second row", async () => {
    const w = await setup({ script: ONE_RUN });
    await spawnOn(w, "s2");
    await waitState(w, "s2", "idle");
    unwrap(
      await updateSessionState(w.db, "s2", {
        from: ["idle"],
        to: "idle",
        patch: { handoff_in_id: "h-prior" },
      }),
    );
    unwrap(await stop(w, "s2"));
    await waitFor(w, async () => {
      expect((await session(w.db, "s2")).ended_at).not.toBeNull();
    });
    expect((await session(w.db, "s2")).exit_reason).toBe("ok");
    expect(await handoffsOf(w.db, "s2")).toEqual([]);
  });
});
