// an earlier change review HIGH, and the spike's own test-plan line: "Kill the supervisor between the
// command insert and its claim; assert the same." This kills it *after* the claim, which is the
// worse case — the command row is already `done`, so nothing re-delivers it — with a real
// supervisor as a child process, SIGKILLed, exactly as restart.test.ts does. The phase boundary
// must survive that: the reconciler re-derives it from the rows and the ticket is released.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { systemClock } from "@bayon/core";
import {
  ENDED_STATES,
  getCommand,
  getEventsSince,
  getSession,
  listTicketHandoffs,
  openDb,
  phaseHandoffKey,
  readHeartbeat,
  type Db,
} from "@bayon/db";
import { migrateUp } from "@bayon/db/supervisor";
import { insertCommand, seedRows, unwrap } from "@bayon/db/testing";
import {
  FIXTURE_CAPS,
  FIXTURE_RUNNER_ID,
  FIXTURE_VERSION,
  type FixtureScriptInput,
} from "@bayon/runners/fixture";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { dbPath } from "../paths.js";
import { certifyPair } from "./testing/certify.js";
import { AGENT_ID, lifecycleRows } from "./testing/fixtures.js";
import { startMcpStub } from "./testing/mcp-stub.js";

const PACKAGE = fileURLToPath(new URL("../../", import.meta.url));
const MAIN = fileURLToPath(new URL("../../dist/main.js", import.meta.url));
const WAIT = { timeout: 30_000, interval: 50 };
const SESSION = "phase-restart-session";
const TICKET = "phase-restart-ticket";
const STEP = { kind: "turn_start", runner_type: "fixture.step", payload: {} };
const END = { kind: "turn_end", runner_type: "fixture.step", payload: {} };

/**
 * Run 1 holds at its gate, so the supervisor dies with the turn open and the boundary deferred.
 * Run 2 is the hand-off request the resumed process is given; it ends on its own, with no
 * handoff_write behind it, so the packet finalizes `degraded` — the quality is not the point here,
 * the row and the release are.
 */
const GATE: FixtureScriptInput = {
  runs: [{ events: [STEP, STEP], gate: "release" }, { events: [STEP, END] }],
};

/** The children's FRM_MCP_URL: the spawn and the adopt gate on it answering. */
const mcp = await startMcpStub();
const children: ChildProcess[] = [];
const runners = new Set<number>();
const dbs: Db[] = [];
const homes: string[] = [];
afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  for (const pid of runners) {
    if (isAlive(pid)) process.kill(pid, "SIGKILL");
  }
  for (const db of dbs) await db.close();
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  await mcp.close();
});

beforeAll(() => {
  // The child runs the compiled supervisor; tsc -b is incremental, and a no-op after `pnpm -w build`.
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  execFileSync(process.execPath, [tsc, "-b", PACKAGE], { stdio: "inherit" });
}, 180_000);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // ESRCH: gone
  }
}

const pidOf = (ref: string | null): number => Number(ref?.split(":")[1]);

function startSupervisor(home: string, n: number): ChildProcess {
  const log = openSync(join(home, `supervisor-${n}.log`), "a");
  const child = spawn(process.execPath, [MAIN], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      FRM_HOME: home,
      // Its own /mcp: never the default URL, where the operator's live API may or may not be.
      FRM_MCP_URL: mcp.url,
    },
    stdio: ["ignore", log, log],
    detached: true,
  });
  closeSync(log);
  children.push(child);
  return child;
}

/** Up once its heartbeat carries its pid: migrations and registration are done. */
async function ready(db: Db, child: ChildProcess): Promise<void> {
  await vi.waitFor(async () => {
    expect(unwrap(await readHeartbeat(db))?.pid).toBe(child.pid);
  }, WAIT);
}

async function kill9(child: ChildProcess): Promise<void> {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL"); // the supervisor alone: runners lead their own groups
  await exited;
}

const handoffs = async (db: Db) => unwrap(await listTicketHandoffs(db, TICKET));

test(
  "a phase boundary claimed and deferred survives a SIGKILL: the reconciler re-derives it and the ticket is released",
  { timeout: 120_000 },
  async () => {
    const home = realpathSync(mkdtempSync("/tmp/frm-pb-"));
    homes.push(home);
    const db = unwrap(await openDb({ path: dbPath(home), clock: systemClock }));
    dbs.push(db);
    unwrap(await migrateUp(db));
    // The local executor measures this host's real disk; a restart is under test here,
    // not free space.
    unwrap(
      await seedRows(db, {
        settings: [
          {
            key: "admission.disk_min_free_pct",
            value_json: "0",
            updated_at: 0,
          },
        ],
      }),
    );
    let supervisor = startSupervisor(home, 1);
    await ready(db, supervisor);
    // The runner and executor rows come from the supervisor's own registration; the operator's
    // rows go in once they exist (foreign keys).
    const rows = lifecycleRows({ script: GATE });
    unwrap(
      await seedRows(db, {
        profiles: rows.profiles,
        agents: rows.agents,
        // `planned` asks for build, and the session below carries spike: a boundary, which is
        // what the transition that landed the ticket here would have planned.
        tickets: [
          {
            id: TICKET,
            num: 1,
            title: "a ticket mid-phase",
            type: "chore",
            status: "planned",
            origin: "operator",
            created_at: 0,
            updated_at: 0,
          },
        ],
      }),
    );
    await certifyPair(db, {
      runnerId: FIXTURE_RUNNER_ID,
      runnerVersion: FIXTURE_VERSION,
      caps: FIXTURE_CAPS,
      executorId: "local",
      at: systemClock.now(),
    });
    unwrap(
      await insertCommand(db, {
        type: "session.spawn",
        payload: {
          session_id: SESSION,
          agent_id: AGENT_ID,
          role: "builder",
          run_class: "spike",
          ticket_id: TICKET,
          prompt: "hold at the gate",
        },
      }),
    );
    await vi.waitFor(async () => {
      const events = unwrap(
        await getEventsSince(db, { sessionId: SESSION, since: 0, limit: 100 }),
      ).rows;
      expect(events.filter((e) => e.kind === "turn_start")).toHaveLength(2);
    }, WAIT);
    const first = unwrap(await getSession(db, SESSION));
    expect(first.state).toBe("running");
    expect(mcp.probes()).toBeGreaterThan(0); // admitted on this test's /mcp
    runners.add(pidOf(first.executor_ref));

    // The API's own effect, as transitionTicket inserts it. It is claimed while the turn is open,
    // so it is deferred to the run's end — and recorded `done` right then, which is the whole
    // problem: from here on, nothing in any table remembers that a release is owed.
    const command = unwrap(
      await insertCommand(db, {
        type: "session.handoff",
        payload: {
          session_id: SESSION,
          reason: "phase_change",
          phase_to: "build",
        },
        idempotencyKey: phaseHandoffKey(SESSION, 1),
      }),
    );
    await vi.waitFor(async () => {
      expect(unwrap(await getCommand(db, command.id)).state).toBe("done");
    }, WAIT);
    expect(unwrap(await getSession(db, SESSION)).state).toBe("running");
    expect(await handoffs(db)).toEqual([]);

    // The plug, pulled while the boundary lives only in the supervisor's memory.
    await kill9(supervisor);
    await vi.waitFor(
      () => expect(isAlive(pidOf(first.executor_ref))).toBe(false),
      WAIT,
    );
    // Nothing re-delivers it: the row is `done`, not `claimed`, so no requeue will ever touch it.
    expect(unwrap(await getCommand(db, command.id)).state).toBe("done");

    supervisor = startSupervisor(home, 2);
    await ready(db, supervisor);

    // The new supervisor was told nothing. It adopts the session, re-derives the boundary from the
    // ticket's own status, and hands the ticket on.
    await vi.waitFor(async () => {
      const [row] = await handoffs(db);
      expect(row?.reason).toBe("phase_change");
      const s = unwrap(await getSession(db, SESSION));
      expect(ENDED_STATES, s.state).toContain(s.state);
    }, WAIT);
    const [row] = await handoffs(db);
    expect(row).toMatchObject({
      ticket_id: TICKET,
      from_session_id: SESSION,
      reason: "phase_change",
      phase_from: "spike",
      phase_to: "build",
    });
  },
);
