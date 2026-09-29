// The successor spawn (§7.3, §9.2): a spawn carrying handoff_id takes its predecessor's
// worktree and branch over, re-writes the packet file from the row and sends the packet in run 1
// under the mission. Real git, the fixture runner on the local executor, a real SQLite file.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock, TEMPLATES } from "@bayon/core";
import {
  getSession,
  getTicket,
  listPendingHandoffs,
  listRuns,
  listSessionsInStates,
  listSessionWorktrees,
  type HandoffRow,
} from "@bayon/db";
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
import {
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
  git,
  handoffsOf,
  makeRepo,
  session,
  spawnOn,
  turns,
  waitFor,
  waitState,
  worktreeOf,
  worldRows,
  type World,
} from "./testing/handoff-world.js";

vi.setConfig({ testTimeout: 30_000 });

const T0 = 1_700_000_000_000;
const MISSION = "Build carefully; hand off, never compact.";
const NOTES = "the predecessor's uncommitted notes\n";
const JUDGEMENT = {
  goal_line: "Finish the README.",
  decisions_md: "- Keep it short.",
  traps_md: null,
  next_steps_md: "1. Accept.\n2. Read notes.txt.\n3. Carry on.",
  open_questions_md: null,
  pointers: [],
};

/** A class so small that no build prompt fits: pre-flight refuses it. */
const MICRO = { ...TINY, name: "micro", context_tokens_cap: 50 };

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

async function setup(
  script: FixtureScriptInput,
  /** The agent's max_concurrency; default the column's 1 (admission's real default). */
  maxConcurrency?: number,
): Promise<World> {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const home = tempHome("frm-su-");
  const { src, mirror } = makeRepo(home.path);
  const rows = worldRows({ script, src, mirror });
  unwrap(
    await seedRows(t.db, {
      ...rows,
      missions: [
        {
          id: "M1",
          agent_name: "agent-1",
          version: 1,
          who_md: "who",
          what_md: "what",
          how_md: "how",
          laws_md: "laws",
          rendered_md: MISSION,
          hash: "0".repeat(64),
          created_at: 0,
          created_by: "operator",
        },
      ],
      agents: rows.agents.map((a) => ({
        ...a,
        mission_id: "M1",
        ...(maxConcurrency === undefined
          ? {}
          : { max_concurrency: maxConcurrency }),
      })),
      run_classes: [...rows.run_classes, MICRO],
    }),
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
      "handoff_writing",
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
  };
}

/** A staffed successor's spawn command: no prompt, the pending hand-off (payload). */
const staff = (w: World, id: string, handoffId: string, ticket = TICKET) =>
  w.lifecycle.handlers.spawn.handle(
    spawnPayload(id, {
      workspace_id: "ws",
      ticket_id: ticket,
      run_class: TINY.name,
      handoff_id: handoffId,
    }),
    CMD,
  );

const worktreeList = (w: World): string =>
  git(w.mirror, "worktree", "list", "--porcelain");

/** The template's own `## ` headings; the packet's sink below them (the compiler escapes them). */
const headings = (prompt: string): string[] =>
  [...prompt.matchAll(/^## (.+)$/gm)].map((m) => m[1] ?? "");

/** A session's run 1 and the prompt it was sent. */
async function run1(w: World, id: string) {
  const [run] = unwrap(await listRuns(w.db, id));
  return { run, prompt: readFileSync(run?.prompt_path ?? "", "utf8") };
}

test("a staffed spawn without a hand-off gets its ticket run 1; an operator prompt keeps operator.v1; over budget spawns nothing", async () => {
  // Three sessions of one agent live at once: this test is about run 1's template, not concurrency.
  const w = await setup({ runs: [{ events: turns(1) }] }, 3);
  const spawn = (id: string, runClass: string, prompt?: string) =>
    w.lifecycle.handlers.spawn.handle(
      spawnPayload(id, {
        workspace_id: "ws",
        ticket_id: TICKET,
        run_class: runClass,
        ...(prompt === undefined ? {} : { prompt }),
      }),
      CMD,
    );
  unwrap(await spawn("t-spike", "spike"));
  unwrap(await spawn("t-fix", "fix"));
  unwrap(await spawn("t-op", TINY.name, "do the operator's thing"));
  for (const id of ["t-spike", "t-fix", "t-op"]) {
    await waitState(w, id, "idle");
  }
  const spike = await run1(w, "t-spike");
  expect(spike.run).toMatchObject({
    seq: 1,
    trigger: "orchestrator",
    template_id: "spike.v6",
  });
  expect(headings(spike.prompt)).toEqual(["Mission", "Ticket"]);
  expect(spike.prompt).toContain('"title": "ticket 1"');
  expect(spike.prompt).toContain(MISSION);
  expect((await run1(w, "t-fix")).run?.template_id).toBe("build.v8");
  const op = await run1(w, "t-op");
  expect(op.run).toMatchObject({
    trigger: "operator",
    template_id: "operator.v1",
  });
  expect(op.prompt).toContain("do the operator's thing");
  const over = await spawn("t-over", MICRO.name);
  expect(!over.ok && over.error.class).toBe("over_budget");
  expect((await getSession(w.db, "t-over")).ok).toBe(false);
});

test("run 1 carries every question asked on the ticket, oldest first, each answer with its time, and no dismissed one (build.v7)", async () => {
  const w = await setup({ runs: [{ events: turns(1) }] });
  // Answered in the other order from the asking: the later answer is the second question's.
  unwrap(
    await seedRows(w.db, {
      human_requests: [
        {
          id: "Q-1",
          ticket_id: TICKET,
          kind: "decision",
          question: "Keep it blocked until the log check is confirmed?",
          status: "answered",
          answer_json: '"Keep ticket blocked until the log check is confirmed"',
          answered_by: "operator",
          asked_at: T0 - 3_000,
          answered_at: T0 - 500,
        },
        {
          id: "Q-2",
          ticket_id: TICKET,
          kind: "decision",
          question: "Safe to remove the v1 routes now?",
          status: "answered",
          answer_json: '"Already confirmed: proceed now"',
          answered_by: "operator",
          asked_at: T0 - 2_000,
          answered_at: T0 - 1_000,
        },
        {
          id: "Q-3",
          ticket_id: TICKET,
          kind: "decision",
          question: "Which store?",
          asked_at: T0 - 1_500,
        },
        {
          id: "Q-P",
          ticket_id: TICKET,
          kind: "staff_approval",
          question: "Staff it?",
          asked_at: T0 - 100,
        },
        {
          // Withdrawn by the operator as no longer relevant: never an instruction to anyone.
          id: "Q-D",
          ticket_id: TICKET,
          kind: "decision",
          question: "Retire the old API before the new one ships?",
          status: "dismissed",
          answered_by: "operator",
          asked_at: T0 - 2_500,
          answered_at: T0 - 200,
        },
      ],
    }),
  );
  unwrap(
    await w.lifecycle.handlers.spawn.handle(
      spawnPayload("t-q", {
        workspace_id: "ws",
        ticket_id: TICKET,
        run_class: "build",
      }),
      CMD,
    ),
  );
  await waitState(w, "t-q", "idle");
  const { run, prompt } = await run1(w, "t-q");
  expect(run?.template_id).toBe("build.v8");
  expect(headings(prompt)).toEqual([
    "Mission",
    "Ticket",
    "Questions to the operator",
  ]);
  expect(prompt).toContain("where two answers disagree, follow the later one");
  const section = prompt.slice(prompt.indexOf("## Questions to the operator"));
  const at = (text: string) => section.indexOf(text);
  expect(at("Keep it blocked")).toBeGreaterThan(0);
  expect(at("Keep it blocked")).toBeLessThan(
    at("Safe to remove the v1 routes now?"),
  );
  expect(at("Safe to remove the v1 routes now?")).toBeLessThan(
    at("Which store?"),
  );
  expect(section).toContain('"answer": "Already confirmed: proceed now"');
  expect(section).toContain(
    `"answered_at": "${new Date(T0 - 500).toISOString()}"`,
  );
  // The open one is listed too, so it is not asked again; a staffing proposal is not a question.
  expect(section).toContain('"status": "open"');
  expect(section).not.toContain("Staff it?");
  expect(prompt).not.toContain("Retire the old API");
  expect(prompt).not.toContain("dismissed");
});

async function onlyHandoff(w: World, id: string): Promise<HandoffRow> {
  const [row, ...more] = await handoffsOf(w.db, id);
  expect(more).toEqual([]);
  if (row === undefined) throw new Error(`${id} left no hand-off`);
  return row;
}

test("a successor takes the worktree and branch over: dirty files intact, packet re-written, under the mission", async () => {
  // Run 1 edits the README and passes the turn ceiling; run 2 is the handoff run.
  const w = await setup({
    runs: [
      {
        appends: [{ path: "README.md", text: "more\n" }],
        events: turns(3),
        gate: "release",
      },
      { events: turns(1), gate: "release" },
    ],
  });
  await spawnOn(w, "s1");
  await waitState(w, "s1", "handoff_writing");
  const path = await worktreeOf(w.db, "s1");
  writeFileSync(join(path, "notes.txt"), NOTES);
  await waitFor(w, async () => {
    expect(unwrap(await listRuns(w.db, "s1")).map((r) => r.trigger)).toEqual([
      "operator",
      "handoff",
    ]);
  });
  unwrap(await writeHandoffJudgement(w.db, "s1", JUDGEMENT));
  await w.release("s1");
  await waitState(w, "s1", "handed_off");
  const h = await onlyHandoff(w, "s1");
  expect(h.quality).toBe("full");
  const packetFile = join(path, h.packet_path);
  writeFileSync(packetFile, "touched by someone\n");
  const before = worktreeList(w);

  unwrap(await staff(w, "s2", h.id));
  await waitFor(w, async () => {
    expect(unwrap(await listRuns(w.db, "s2"))).toHaveLength(1);
  });

  // The session: its predecessor and hand-off in; the ticket's owner is still handoff_accept's.
  expect(await session(w.db, "s2")).toMatchObject({
    predecessor_session_id: "s1",
    handoff_in_id: h.id,
    workspace_id: "ws",
  });
  expect(unwrap(await getTicket(w.db, TICKET)).owner_session_id).toBeNull();
  // The worktree row moved (path is UNIQUE); the directory and branch are the predecessor's.
  expect(unwrap(await listSessionWorktrees(w.db, "s1"))).toEqual([]);
  expect(unwrap(await listSessionWorktrees(w.db, "s2"))).toMatchObject([
    { path, branch: "frm/s1", state: "active" },
  ]);
  // Dirty files are intact (the successor's run 1 appends to the README again).
  expect(readFileSync(join(path, "notes.txt"), "utf8")).toBe(NOTES);
  expect(readFileSync(join(path, "README.md"), "utf8")).toMatch(
    /^hello\nmore\n/,
  );
  expect(git(path, "status", "--porcelain")).toBe("M README.md\n?? notes.txt");
  expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("frm/s1");
  // No second `git worktree add`: same worktrees, and no frm/s2 branch.
  expect(worktreeList(w)).toBe(before);
  expect(git(w.mirror, "branch", "--list", "frm/s2")).toBe("");
  // The packet file is the row's again.
  expect(fileHash(packetFile)).toBe(h.packet_hash);

  // Run 1: build template, the packet directly under the mission, then the ticket.
  const [run] = unwrap(await listRuns(w.db, "s2"));
  expect(run).toMatchObject({ seq: 1, trigger: "orchestrator" });
  expect(run?.template_id).toBe("build.v8");
  const prompt = readFileSync(run?.prompt_path ?? "", "utf8");
  expect(headings(prompt)).toEqual(["Mission", "Hand-off packet", "Ticket"]);
  const packet = prompt.slice(
    prompt.indexOf("## Hand-off packet"),
    prompt.indexOf("## Ticket"),
  );
  // The header names the hand-off by its label and its id.
  expect(packet).toContain(
    `· handoff-1 (id ${h.id}) · tiny → tiny · reason: turn_ceiling`,
  );
  expect(packet).toContain(JUDGEMENT.goal_line);
  expect(prompt.indexOf(MISSION)).toBeLessThan(prompt.indexOf(packet));
});

test("a degraded packet re-renders to its hash; an unaccepted successor's worktree passes to the next (spawnInternal inherit)", async () => {
  const w = await setup({ runs: [{ events: turns(1) }] });
  await spawnOn(w, "d1");
  await waitState(w, "d1", "idle");
  const path = await worktreeOf(w.db, "d1");
  writeFileSync(join(path, "notes.txt"), NOTES);
  await w.lifecycle.stop("d1", "kill");
  await waitState(w, "d1", "exited");
  const h = await onlyHandoff(w, "d1");
  expect(h.quality).toBe("degraded");
  // The degraded line is stored with the facts, so the row re-renders to its hash.
  const why = (JSON.parse(h.facts_json) as { why?: string }).why ?? "";
  expect(why).toMatch(/^the session /);

  unwrap(await staff(w, "d2", h.id));
  await waitState(w, "d2", "idle");
  expect(fileHash(join(path, h.packet_path))).toBe(h.packet_hash);
  // d2 dies before handoff_accept: it held nothing, so no row, and h is still pending.
  await w.lifecycle.stop("d2", "kill");
  await waitState(w, "d2", "exited");
  expect(await handoffsOf(w.db, "d2")).toEqual([]);
  expect(
    unwrap(await listPendingHandoffs(w.db, TICKET)).map((r) => r.id),
  ).toEqual([h.id]);

  const [held] = unwrap(await listSessionWorktrees(w.db, "d2"));
  const internal = (id: string, workspace: "none" | string) =>
    w.lifecycle.spawnInternal({
      payload: {
        session_id: id,
        agent_id: "agent-1",
        role: "builder",
        run_class: TINY.name,
        ticket_id: TICKET,
        handoff_id: h.id,
      },
      run: {
        seq: 1,
        trigger: "orchestrator",
        template: TEMPLATES.build,
        inputs: { ticket: "ticket 1" },
      },
      workspace:
        workspace === "none" ? "none" : { inherit: { worktreeId: workspace } },
    });
  const refused = [
    await internal("x-1", "none"),
    await internal("x-2", "w-other"),
  ];
  expect(refused.map((r) => !r.ok && r.error.class)).toEqual([
    "validation",
    "validation",
  ]);
  unwrap(await internal("d3", held?.id ?? ""));
  await waitState(w, "d3", "idle");
  expect(await session(w.db, "d3")).toMatchObject({
    predecessor_session_id: "d1",
    handoff_in_id: h.id,
  });
  expect(unwrap(await listSessionWorktrees(w.db, "d3"))).toMatchObject([
    { id: held?.id, path, branch: "frm/d1", state: "active" },
  ]);
  expect(readFileSync(join(path, "notes.txt"), "utf8")).toBe(NOTES);
  const [run] = unwrap(await listRuns(w.db, "d3"));
  expect(readFileSync(run?.prompt_path ?? "", "utf8")).toContain(
    `(no judgement: ${why})`,
  );
});

test("refused, spawning nothing: not pending (writing, accepted), unknown, another ticket, predecessor live, worktree missing", async () => {
  const w = await setup({ runs: [{ events: turns(1) }] });
  await spawnOn(w, "p1");
  await waitState(w, "p1", "idle");
  const row = (id: string, o: Partial<HandoffRow> = {}) => ({
    id,
    ticket_id: TICKET,
    from_session_id: "p1",
    reason: "operator",
    facts_json: "{}",
    quality: "degraded",
    packet_path: `.foreman/${id}.md`,
    packet_hash: "0".repeat(64),
    created_at: T0,
    ...o,
  });
  unwrap(
    await seedRows(w.db, {
      handoffs: [
        row("HW", { quality: "writing" }),
        row("HA", { accepted_at: T0, to_session_id: "p1" }),
        row("HP"),
      ],
    }),
  );
  const classes = [
    await staff(w, "r-writing", "HW"),
    await staff(w, "r-accepted", "HA"),
    await staff(w, "r-unknown", "nope"),
    await staff(w, "r-ticket", "HP", "ticket-2"),
    await staff(w, "r-live", "HP"),
  ].map((r) => !r.ok && r.error.class);
  expect(classes).toEqual([
    "conflict",
    "conflict",
    "not_found",
    "validation",
    "conflict",
  ]);

  await w.lifecycle.stop("p1", "kill");
  await waitState(w, "p1", "exited");
  rmSync(await worktreeOf(w.db, "p1"), { recursive: true, force: true });
  const missing = await staff(w, "r-missing", "HP");
  expect(!missing.ok && missing.error).toMatchObject({
    class: "not_found",
    message: expect.stringContaining("is missing"),
  });
  for (const id of [
    "r-writing",
    "r-accepted",
    "r-unknown",
    "r-ticket",
    "r-live",
    "r-missing",
  ]) {
    expect((await getSession(w.db, id)).ok).toBe(false);
  }
});
