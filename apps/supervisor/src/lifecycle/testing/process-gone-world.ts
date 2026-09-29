// A lifecycle on real fixture processes whose exits can be withheld: the local
// executor, a FakeClock, and an adapter that hides a process's exit, ends its stream while it lives,
// or holds its send. Cross-process waits are deadlines (vi.waitFor), never sleeps. The rows are
// seeded by the test file, the only place allowed to reach @bayon/db/testing (no-sql.test.ts).
import { TEMPLATES, ok, type FakeClock, type Result } from "@bayon/core";
import {
  getEventsSince,
  getSession,
  listSessionsInStates,
  type Db,
} from "@bayon/db";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import type {
  ExitInfo,
  RawRecord,
  RunnerAdapter,
  SessionHandle,
} from "@bayon/runners";
import {
  createFixtureAdapter,
  type FixtureAdapter,
  type FixtureScriptInput,
} from "@bayon/runners/fixture";
import { expect, vi } from "vitest";
import type { InternalSpawn } from "../internal-spawn.js";
import {
  AGENT_ID,
  CMD,
  EXECUTOR_ID,
  lifecycleRows,
  spawnPayload,
  startLifecycle,
  tempHome,
} from "./fixtures.js";

export const T0 = 1_700_000_000_000;
export const WAIT = { timeout: 15_000, interval: 10 };
const TURN = { kind: "turn_start", runner_type: "fixture.step", payload: {} };
/** Run 1 opens and waits on its gate: a process mid-run until something ends it. */
const GATE: FixtureScriptInput = {
  runs: [{ events: [TURN], gate: "release" }],
};
/** lifecycle.kill_grace_ms at its default: one step of the bounded exit wait. */
export const GRACE = 5_000;
export const GATE_ID = "g-1";
/** The gate row a reviewer's internal spawn names; the test file adds it, with its ticket. */
export const GATE_ROW = {
  id: GATE_ID,
  ticket_id: "ticket-1",
  kind: "code_review",
  state: "running",
  attempt: 1,
  subject_kind: "diff",
  subject_ref: "unpinned",
  started_at: T0,
} as const;

/** The rows every world runs on: the fixture runner, run 1 held on its gate. */
export const worldRows = () => lifecycleRows({ script: GATE });

/** A Result's value, or the test fails with its error. */
function must<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.class}: ${r.error.message}`);
  return r.value;
}
const WITH_PROCESS = [
  "pending",
  "preparing",
  "spawning",
  "running",
  "idle",
  "stopping",
] as const;

export interface Withheld {
  readonly caps?: RunnerAdapter["caps"];
  /** A send that does not return until it settles: an op holding the session's queue. */
  readonly hold?: Promise<unknown>;
  /** `hung` (default): a spawned process's exit never settles. `real`: it does, when it exits. */
  readonly exit?: "hung" | "real";
  /** Given: a spawned process's stream ends when it settles, while the process lives on. */
  readonly cut?: Promise<unknown>;
}

/** The fixture adapter with a spawned process's exit or stream withheld; adopted ones are its own. */
export function withheld(
  base: FixtureAdapter,
  o: Withheld = {},
): RunnerAdapter {
  const originals = new WeakMap<SessionHandle, SessionHandle>();
  const real = (h: SessionHandle): SessionHandle => originals.get(h) ?? h;
  const wrap = (r: Result<SessionHandle>): Result<SessionHandle> => {
    if (!r.ok) return r;
    const handle: SessionHandle = {
      ...r.value,
      ...(o.exit === "real"
        ? {}
        : { exited: new Promise<ExitInfo>(() => undefined) }),
    };
    originals.set(handle, r.value);
    return ok(handle);
  };
  const cut = o.cut;
  async function* until(
    records: AsyncIterable<RawRecord>,
    end: Promise<unknown>,
  ): AsyncGenerator<RawRecord> {
    const it = records[Symbol.asyncIterator]();
    const ended = end.then(() => ({ done: true, value: undefined }) as const);
    for (;;) {
      const next = await Promise.race([it.next(), ended]);
      if (next.done === true) return;
      yield next.value;
    }
  }
  return {
    ...base,
    ...(o.caps === undefined ? {} : { caps: o.caps }),
    spawn: async (spec, ex) => wrap(await base.spawn(spec, ex)),
    send: async (h, p) => {
      const sent = await base.send(real(h), p);
      if (o.hold !== undefined) await o.hold;
      return sent;
    },
    records: (h) =>
      cut !== undefined && originals.has(h)
        ? until(base.records(real(h)), cut)
        : base.records(real(h)),
    interrupt: (h) => base.interrupt(real(h)),
    stop: (h, mode) => base.stop(real(h), mode),
  };
}

export interface WorldOptions {
  readonly adapter: (base: FixtureAdapter) => RunnerAdapter;
  /** FRM_HOME_TAG: the executor lists its tagged processes, so a pass sees stragglers. */
  readonly homeTag?: string;
}

/** A booted lifecycle over the caller's seeded database (worldRows, and GATE_ROW for a reviewer). */
export async function processWorld(
  o: WorldOptions & {
    readonly db: Db;
    readonly clock: FakeClock;
    readonly cleanupDb: () => void;
  },
) {
  const { clock } = o;
  const t = { db: o.db, cleanup: o.cleanupDb };
  const home = tempHome();
  const slots = new SlotCounter(4);
  const executor = new LocalExecutor({
    id: EXECUTOR_ID,
    slots,
    clock,
    ...(o.homeTag === undefined ? {} : { homeTag: o.homeTag }),
  });
  const started = await startLifecycle({
    db: t.db,
    clock,
    frmHome: home.path,
    executor,
    slots,
    adapter: o.adapter(createFixtureAdapter({ clock })),
    boot: true,
    ...(o.homeTag === undefined ? {} : { homeTag: o.homeTag }),
  });
  const cleanup = async (): Promise<void> => {
    await started.lifecycle.shutdown();
    const live = await listSessionsInStates(t.db, WITH_PROCESS);
    for (const s of live.ok ? live.value : []) {
      if (s.executor_ref !== null)
        await executor.cleanup(s.executor_ref, "hard");
    }
    t.cleanup();
    home.cleanup();
  };
  return {
    ...started,
    executor,
    slots,
    db: t.db,
    clock,
    frmHome: home.path,
    cleanup,
  };
}

export type World = Awaited<ReturnType<typeof processWorld>>;

export const session = async (db: Db, id: string) =>
  must(await getSession(db, id));
export const pidOf = (ref: string | null): number => Number(ref?.split(":")[1]);
export const msgs = (w: World): string[] => w.logs.map((l) => l.msg);

/** Waits until `id` is running run 1 (the fixture holds it on its gate). */
export async function untilRunning(w: World, id: string): Promise<void> {
  await vi.waitFor(async () => {
    const kinds = must(
      await getEventsSince(w.db, { sessionId: id, since: 0, limit: 10 }),
    ).rows.map((e) => e.kind);
    expect(kinds).toContain("turn_start");
    expect((await session(w.db, id)).state).toBe("running");
  }, WAIT);
}

/** Spawns with a prompt; returns once run 1 is open. */
export async function spawnRunning(w: World, id: string): Promise<void> {
  must(
    await w.lifecycle.handlers.spawn.handle(
      spawnPayload(id, { prompt: "go" }),
      CMD,
    ),
  );
  await untilRunning(w, id);
}

/** A gate's reviewer, run 1 open on its gate, told its facts through `afterExit`. */
export function reviewer(
  id: string,
  afterExit: InternalSpawn["afterExit"],
): InternalSpawn {
  return {
    payload: {
      session_id: id,
      agent_id: AGENT_ID,
      role: "reviewer",
      run_class: "review",
      ticket_id: "ticket-1",
    },
    run: {
      seq: 1,
      trigger: "gate",
      template: TEMPLATES.operator,
      inputs: { task: "review" },
    },
    workspace: "none",
    gate: { id: GATE_ID, fallbackFrom: null },
    ...(afterExit === undefined ? {} : { afterExit }),
  };
}

/** Waits for ingest's supervisor terminal on `id`: its stream ended with run 1 open. */
export async function untilStreamEnded(w: World, id: string): Promise<void> {
  await vi.waitFor(async () => {
    const terminals = must(
      await getEventsSince(w.db, {
        sessionId: id,
        since: 0,
        kinds: ["terminal"],
        limit: 10,
      }),
    ).rows;
    expect(terminals.map((e) => e.payload_json)).toEqual([
      expect.stringContaining("runner_exited_without_terminal"),
    ]);
  }, WAIT);
}

/** SIGKILLs the runner mid-run and waits until its stream has ended; returns its old ref. */
export async function killMidRun(w: World, id: string): Promise<string> {
  const ref = (await session(w.db, id)).executor_ref ?? "";
  process.kill(pidOf(ref), "SIGKILL");
  await untilStreamEnded(w, id);
  return ref;
}

/** Advances the clock a grace at a time until `p` settles. */
export async function driveUntil(w: World, p: Promise<unknown>): Promise<void> {
  const done = p.then(() => true);
  await vi.waitFor(async () => {
    await w.clock.advance(GRACE);
    expect(await Promise.race([done, Promise.resolve(false)])).toBe(true);
  }, WAIT);
}
