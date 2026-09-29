import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { FakeClock, err, ok } from "@bayon/core";
import { getCommand, migrationStatus, readHeartbeat } from "@bayon/db";
import { insertCommand, unwrap } from "@bayon/db/testing";
import { pino } from "pino";
import { afterAll, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  lockPath,
  relaySocketPath,
  socketPath,
  tmuxSocketPath,
} from "./paths.js";
import { startSupervisor } from "./supervisor.js";

const T0 = 1_700_000_000_000;
const homes: string[] = [];
/** Real processes, each leading its own group: reaped here if still alive. */
const children = new Set<ChildProcess>();
afterAll(() => {
  for (const child of children) {
    const pid = child.pid;
    if (pid === undefined || pid < 2 || child.exitCode !== null) continue;
    if (child.signalCode !== null) continue;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});
const tempHome = (prefix = "/tmp/frm-") => {
  const home = mkdtempSync(prefix);
  homes.push(home);
  return home;
};
const log = pino({ level: "silent" });
const turns = async (n: number) => {
  for (let i = 0; i < n; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

function wake(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(path, () => conn.end('{"op":"wake"}\n'));
    conn.on("error", reject);
    conn.on("close", () => resolve());
    conn.resume();
  });
}

test("boots migrations → socket → heartbeat → lifecycle → claimer, and shuts down in reverse", async () => {
  const home = tempHome();
  const clock = new FakeClock(T0);
  const order: string[] = [];
  let bootCommand = "";
  const started = await startSupervisor({
    home,
    clock,
    log,
    version: "0.1.0",
    lifecycle: (deps) => {
      deps.claimer.register({
        type: "t.ping",
        payload: z.object({}),
        idempotent: true,
        handle: async () => {
          order.push("handled");
          return ok("pong");
        },
      });
      return {
        spawnInternal: async () => ok("unused"),
        stop: async () => undefined,
        onSessionEnded: () => () => undefined,
        onHandoffPending: () => () => undefined,
        boot: async () => {
          const status = unwrap(await migrationStatus(deps.db));
          order.push(`boot:${status.pending.length}`);
          expect(existsSync(socketPath(home))).toBe(true);
          expect(unwrap(await readHeartbeat(deps.db))?.pid).toBe(process.pid);
          bootCommand = unwrap(
            await insertCommand(deps.db, { type: "t.ping", payload: {} }),
          ).id;
          await turns(20);
          order.push(unwrap(await getCommand(deps.db, bootCommand)).state);
          return ok(undefined);
        },
        spawn: async () =>
          err({
            class: "not_found",
            message: "unused in this test",
            retryable: false,
          }),
        shutdown: async () => {
          order.push("lifecycle.shutdown");
        },
      };
    },
  });
  const sup = unwrap(started);
  expect(statSync(socketPath(home)).mode & 0o777).toBe(0o600);
  await vi.waitFor(async () =>
    expect(unwrap(await getCommand(sup.db, bootCommand)).state).toBe("done"),
  );

  // A wake on the socket beats the 1 s poll: the clock never moves.
  const woken = unwrap(
    await insertCommand(sup.db, { type: "t.ping", payload: {} }),
  ).id;
  await wake(socketPath(home));
  await vi.waitFor(async () =>
    expect(unwrap(await getCommand(sup.db, woken)).state).toBe("done"),
  );
  expect(clock.now()).toBe(T0);

  await sup.shutdown();
  expect(order).toEqual([
    "boot:0",
    "pending",
    "handled",
    "handled",
    "lifecycle.shutdown",
  ]);
  expect(existsSync(socketPath(home))).toBe(false);
  expect((await getCommand(sup.db, woken)).ok).toBe(false);
});

test("a second supervisor on the same FRM_HOME is refused", async () => {
  const home = tempHome();
  const clock = new FakeClock(T0);
  const first = unwrap(
    await startSupervisor({ home, clock, log, version: "0.1.0" }),
  );
  const second = await startSupervisor({ home, clock, log, version: "0.1.0" });
  expect(second.ok ? null : second.error.class).toBe("conflict");
  expect(existsSync(socketPath(home))).toBe(true);
  await first.shutdown();
});

// the supervisor lock ($FRM_HOME/supervisor.lock), taken before the socket.
const LOCK_TEST_PREFIX = "/tmp/frm-fix-sup-";
const STALE_SOCKET =
  "require('net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))";

/** Runs `node -e <script> [arg]` in its own process group to its end. */
function runToEnd(
  script: string,
  arg?: string,
): Promise<{ readonly pid: number; readonly signal: string | null }> {
  const argv = ["-e", script, ...(arg === undefined ? [] : [arg])];
  const child = spawn(process.execPath, argv, {
    detached: true,
    stdio: "ignore",
  });
  children.add(child);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (_code, signal) =>
      resolve({ pid: child.pid ?? -1, signal }),
    );
  });
}

const lockOwner = (home: string): unknown =>
  (JSON.parse(readFileSync(lockPath(home), "utf8")) as { pid?: unknown }).pid;

test("two supervisors starting at once over one stale socket: exactly one comes up, the other is refused", async () => {
  const home = tempHome(LOCK_TEST_PREFIX);
  const stale = await runToEnd(STALE_SOCKET, socketPath(home));
  expect(stale.signal).toBe("SIGKILL");
  expect(lstatSync(socketPath(home)).isSocket()).toBe(true);
  const clock = new FakeClock(T0);
  const both = await Promise.all([
    startSupervisor({ home, clock, log, version: "0.1.0" }),
    startSupervisor({ home, clock, log, version: "0.1.0" }),
  ]);
  const up = both.flatMap((r) => (r.ok ? [r.value] : []));
  const refused = both.flatMap((r) => (r.ok ? [] : [r.error]));
  try {
    expect(up).toHaveLength(1);
    expect(refused).toEqual([
      expect.objectContaining({
        class: "conflict",
        message: expect.stringContaining(
          `another supervisor holds ${lockPath(home)} (pid ${process.pid} `,
        ),
      }),
    ]);
    expect(lockOwner(home)).toBe(process.pid);
    expect(lstatSync(socketPath(home)).isSocket()).toBe(true);
  } finally {
    for (const sup of up) await sup.shutdown();
  }
  // The lock went last, and the refused start left nothing behind.
  const left = readdirSync(home).filter(
    (f) => f.startsWith("supervisor.lock") || f === "s.sock",
  );
  expect(left).toEqual([]);
});

test("a lock left by a supervisor that died is reclaimed, and released on shutdown", async () => {
  const home = tempHome(LOCK_TEST_PREFIX);
  const dead = await runToEnd("");
  const stale = {
    pid: dead.pid,
    started_at: 0,
    host: hostname(),
    acquired_at: T0,
    nonce: "dead",
  };
  writeFileSync(lockPath(home), `${JSON.stringify(stale)}\n`);
  const sup = unwrap(
    await startSupervisor({
      home,
      clock: new FakeClock(T0),
      log,
      version: "0.1.0",
    }),
  );
  expect(lockOwner(home)).toBe(process.pid);
  await sup.shutdown();
  expect(existsSync(lockPath(home))).toBe(false);
});

test("an FRM_HOME of 150+ characters starts: its sockets go to a short private dir", async () => {
  const home = join(tempHome(), "h".repeat(150));
  const sockets = dirname(socketPath(home));
  homes.push(sockets);
  expect(home.length).toBeGreaterThan(150);
  expect(sockets).toMatch(/\/frm-(\d+-)?[0-9a-f]{12}$/);
  expect(sockets.startsWith(dirname(home))).toBe(false);
  expect(dirname(relaySocketPath(home))).toBe(sockets);
  expect(
    dirname(dirname(tmuxSocketPath(home, "01ARZ3NDEKTSV4RRFFQ69G5FAV"))),
  ).toBe(sockets);
  const sup = unwrap(
    await startSupervisor({
      home,
      clock: new FakeClock(T0),
      log,
      version: "0.1.0",
    }),
  );
  try {
    expect(lstatSync(sockets).mode & 0o777).toBe(0o700);
    expect(lstatSync(socketPath(home)).isSocket()).toBe(true);
    await wake(socketPath(home));
    expect(existsSync(join(home, "foreman.db"))).toBe(true);
  } finally {
    await sup.shutdown();
  }
  expect(existsSync(socketPath(home))).toBe(false);
});

test("a socket dir someone else could open is refused before the database, in plain words", async () => {
  const home = join(tempHome(), "o".repeat(150));
  const sockets = dirname(socketPath(home));
  homes.push(sockets);
  mkdirSync(sockets, { mode: 0o700 });
  chmodSync(sockets, 0o777);
  const started = await startSupervisor({
    home,
    clock: new FakeClock(T0),
    log,
    version: "0.1.0",
  });
  expect(started.ok ? null : started.error.class).toBe("validation");
  expect(started.ok ? "" : started.error.message).toContain("chmod 700");
  expect(existsSync(join(home, "foreman.db"))).toBe(false);
});
