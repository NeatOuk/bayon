// What the hand-off tests share: a real git source and --mirror clone, the fixture
// runner on the local executor, a ticket in building and a run class with a low turn ceiling.
// Test-only.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock } from "@bayon/core";
import {
  getEventsSince,
  getSession,
  listSessionWorktrees,
  listSessionsInStates,
  listTicketHandoffs,
  type Db,
  type HandoffRow,
  type SessionRow,
} from "@bayon/db";
import { LocalExecutor, SlotCounter, type Executor } from "@bayon/executors";
import type { RunnerAdapter, SessionHandle } from "@bayon/runners";
import {
  createFixtureAdapter,
  type FixtureAdapter,
  type FixtureScriptInput,
} from "@bayon/runners/fixture";
import { expect, vi } from "vitest";
import type { SessionSpawnPayload } from "../payloads.js";
import {
  CMD,
  EXECUTOR_ID,
  lifecycleRows,
  spawnPayload,
  startLifecycle,
  type Started,
} from "./fixtures.js";

export const TICKET = "ticket-1";
export const T0 = 1_700_000_000_000;
export const WAIT = { timeout: 20_000, interval: 10 };
export const TS = {
  kind: "turn_start",
  runner_type: "fixture.step",
  payload: {},
};
export const TE = {
  kind: "turn_end",
  runner_type: "fixture.step",
  payload: {},
};

/** `n` top-level turns. */
export const turns = (n: number) =>
  Array.from({ length: n }, () => [TS, TE]).flat();

/** A build-like class whose turn ceiling is 2 (§7.1), so a test reaches it in a few events. */
export const TINY = {
  name: "tiny",
  context_tokens_cap: 25_000,
  max_turns: 60,
  max_tool_calls: 100,
  wall_clock_ms: 3_600_000,
  cost_cap_usd: 5,
  handoff_at_turns: 2,
  handoff_at_context_pct: 70,
  default_tier: "standard" as const,
};

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

/** A source repo with one commit and its --mirror clone under `home`. */
export function makeRepo(home: string): { src: string; mirror: string } {
  const src = join(home, "src");
  mkdirSync(src);
  git(src, "init", "-q", "-b", "main");
  writeFileSync(join(src, "README.md"), "hello\n");
  git(src, "add", ".");
  git(src, "commit", "-q", "-m", "one");
  const mirror = join(home, "mirror.git");
  git(home, "clone", "-q", "--mirror", src, mirror);
  return { src, mirror };
}

/** The operator rows: the fixture runner, the repo and its workspace, TINY, and ticket 1. */
export function worldRows(o: {
  script: FixtureScriptInput;
  src: string;
  mirror: string;
  settings?: Readonly<Record<string, number>>;
  ticketStatus?: string;
  secretRefs?: readonly string[];
}) {
  return {
    ...lifecycleRows({
      script: o.script,
      settings: o.settings,
      secretRefs: o.secretRefs,
    }),
    repos: [
      {
        id: "repo",
        name: "repo",
        origin_url: o.src,
        mirror_path: o.mirror,
        doctrine_paths_json: "[]",
      },
    ],
    workspaces: [{ id: "ws", name: "ws", kind: "single" as const }],
    workspace_repos: [
      {
        workspace_id: "ws",
        repo_id: "repo",
        rel_path: "repo",
        role: "primary" as const,
      },
    ],
    run_classes: [TINY],
    tickets: [
      {
        id: TICKET,
        num: 1,
        title: "ticket 1",
        type: "chore" as const,
        status: o.ticketStatus ?? "building",
        origin: "operator",
        created_at: 0,
        updated_at: 0,
      },
    ],
  };
}

/** The fixture adapter: each session's handle kept (to open a gate), adopts counted, stops logged. */
export function capturing(base: FixtureAdapter) {
  const handles = new Map<string, SessionHandle>();
  const stops: string[] = [];
  let adopts = 0;
  const adapter: RunnerAdapter = {
    ...base,
    stop: async (h, mode) => {
      stops.push(mode);
      return base.stop(h, mode);
    },
    spawn: async (spec, ex) => {
      const spawned = await base.spawn(spec, ex);
      if (spawned.ok) handles.set(spec.sessionId, spawned.value);
      return spawned;
    },
    adopt: async (spec, ex) => {
      adopts += 1;
      const adopted = await base.adopt(spec, ex);
      if (adopted.ok) handles.set(spec.sessionId, adopted.value);
      return adopted;
    },
  };
  return {
    adapter,
    adopts: () => adopts,
    /** The modes adapter.stop was called with, in order. */
    stops: (): readonly string[] => [...stops],
    /** Opens the session's `gate: release` run. */
    release: async (id: string): Promise<void> => {
      const handle = handles.get(id);
      if (handle === undefined) throw new Error(`no handle for ${id}`);
      const released = await base.release(handle);
      if (!released.ok) throw new Error(released.error.message);
    },
  };
}

export interface World extends Started {
  readonly db: Db;
  readonly clock: FakeClock;
  readonly executor: Executor;
  readonly slots: SlotCounter;
  readonly src: string;
  readonly mirror: string;
  readonly release: (id: string) => Promise<void>;
  readonly adopts: () => number;
  readonly stops: () => readonly string[];
}

/**
 * A booted lifecycle over the caller's seeded database, a real git mirror and the fixture runner.
 * The rows themselves are seeded by the test file, which is the only place allowed to reach
 * @bayon/db/testing (no-sql.test.ts); this owns the wiring every hand-off test repeats. The
 * teardown goes on the caller's `cleanups`, which its own afterAll runs.
 */
export async function startWorld(
  o: {
    readonly db: Db;
    readonly clock: FakeClock;
    readonly home: { readonly path: string; cleanup(): void };
    readonly src: string;
    readonly mirror: string;
    readonly cleanupDb: () => void;
  },
  cleanups: (() => Promise<void>)[],
): Promise<World> {
  const slots = new SlotCounter(4);
  const executor = new LocalExecutor({ id: EXECUTOR_ID, slots });
  const fixture = capturing(createFixtureAdapter({ clock: o.clock }));
  const started = await startLifecycle({
    db: o.db,
    clock: o.clock,
    frmHome: o.home.path,
    executor,
    slots,
    adapter: fixture.adapter,
  });
  cleanups.push(async () => {
    await started.lifecycle.shutdown();
    const live = await listSessionsInStates(o.db, [
      "running",
      "idle",
      "stopping",
      "handoff_writing",
      "handed_off",
    ]);
    for (const s of live.ok ? live.value : []) {
      if (s.executor_ref !== null)
        await executor.cleanup(s.executor_ref, "hard");
    }
    o.cleanupDb();
    o.home.cleanup();
  });
  return {
    ...started,
    db: o.db,
    clock: o.clock,
    executor,
    slots,
    src: o.src,
    mirror: o.mirror,
    release: fixture.release,
    adopts: fixture.adopts,
    stops: fixture.stops,
  };
}

export const session = async (db: Db, id: string): Promise<SessionRow> => {
  const found = await getSession(db, id);
  if (!found.ok) throw new Error(found.error.message);
  return found.value;
};

/** Spawns a builder on ticket 1 in the workspace, run class TINY, with a prompt. */
export async function spawnOn(
  w: World,
  id: string,
  extra: Partial<SessionSpawnPayload> = {},
): Promise<void> {
  const spawned = await w.lifecycle.handlers.spawn.handle(
    spawnPayload(id, {
      workspace_id: "ws",
      ticket_id: TICKET,
      run_class: TINY.name,
      prompt: "go",
      ...extra,
    }),
    CMD,
  );
  if (!spawned.ok) throw new Error(spawned.error.message);
}

export async function waitFor(
  w: World,
  check: () => Promise<void>,
): Promise<void> {
  await vi.waitFor(async () => {
    await w.lifecycle.settled();
    await check();
  }, WAIT);
}

export const waitState = (w: World, id: string, state: string) =>
  waitFor(w, async () => {
    expect((await session(w.db, id)).state).toBe(state);
  });

/** Waits until the session has stored an event of `kind`: its run's appends are on disk. */
export const waitEvent = (w: World, id: string, kind: string) =>
  waitFor(w, async () => {
    const rows = await getEventsSince(w.db, {
      sessionId: id,
      since: 0,
      limit: 1000,
    });
    expect(rows.ok ? rows.value.rows.map((e) => e.kind) : []).toContain(kind);
  });

/** The session's hand-off rows (at most one). */
export async function handoffsOf(db: Db, id: string): Promise<HandoffRow[]> {
  const rows = await listTicketHandoffs(db, TICKET);
  if (!rows.ok) throw new Error(rows.error.message);
  return rows.value.filter((row) => row.from_session_id === id);
}

export async function worktreeOf(db: Db, id: string): Promise<string> {
  const rows = await listSessionWorktrees(db, id);
  const path = rows.ok ? rows.value[0]?.path : undefined;
  if (path === undefined) throw new Error(`no worktree for ${id}`);
  return path;
}

/** The packet file's sha256, as packet_hash stores it. */
export const fileHash = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
