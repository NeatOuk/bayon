// The supervisor lock (Invariant 12): created whole by link(2), cleared only when its owner is
// provably dead, released only by its owner. Real processes lead their own process groups and
// are reaped in afterAll.
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { FakeClock } from "@bayon/core";
import { unwrap } from "@bayon/db/testing";
import { readProc, type ProcInfo } from "@bayon/executors";
import { pino } from "pino";
import { afterAll, expect, test, vi } from "vitest";
import { acquireLock } from "./lock.js";

const T0 = 1_700_000_000_000;
const dir = mkdtempSync("/tmp/frm-fix-sup-");
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
  rmSync(dir, { recursive: true, force: true });
});

const log = pino({ level: "silent" });
const clock = new FakeClock(T0);
const at = (name: string) => ({ path: join(dir, name), clock, log });
const read = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const lockFile = (o: {
  readonly pid: number;
  readonly started_at: number;
  readonly host?: string;
}): string =>
  `${JSON.stringify({ host: hostname(), acquired_at: T0, nonce: "other", ...o })}\n`;
/** Staging and set-aside files must not outlive an acquire. */
const leftovers = (name: string) =>
  readdirSync(dir).filter((f) => f.startsWith(`${name}.`));

async function startOf(pid: number): Promise<ProcInfo> {
  return vi.waitFor(async () => {
    const info = await readProc(pid);
    if (info === null) throw new Error(`pid ${pid} is not in the table yet`);
    return info;
  });
}
const ownStart = async (): Promise<number> =>
  (await startOf(process.pid)).start * 1000;

/** Runs `node -e <script>` in its own process group; with `wait`, to its end. */
function node(script: string): ChildProcess {
  const child = spawn(process.execPath, ["-e", script], {
    detached: true,
    stdio: "ignore",
  });
  children.add(child);
  return child;
}

test("an absent lock is created with this process's pid and start; release removes it", async () => {
  const lock = unwrap(await acquireLock(at("a.lock")));
  expect(read(lock.path)).toEqual({
    pid: process.pid,
    started_at: await ownStart(),
    host: hostname(),
    acquired_at: T0,
    nonce: expect.any(String),
  });
  expect(leftovers("a.lock")).toEqual([]);
  lock.release();
  lock.release(); // idempotent
  expect(existsSync(lock.path)).toBe(false);
});

test("a lock whose owner is alive is refused and left as it was", async () => {
  const child = node("setInterval(() => {}, 1 << 30)");
  const pid = child.pid ?? -1;
  const info = await startOf(pid);
  const path = join(dir, "b.lock");
  const content = lockFile({ pid, started_at: info.start * 1000 });
  writeFileSync(path, content);
  const refused = await acquireLock(at("b.lock"));
  expect(refused.ok ? null : refused.error).toMatchObject({
    class: "conflict",
    message: expect.stringContaining(
      `another supervisor holds ${path} (pid ${pid} `,
    ),
  });
  expect(readFileSync(path, "utf8")).toBe(content);
  expect(leftovers("b.lock")).toEqual([]);
});

test("a lock whose pid is gone is reclaimed", async () => {
  const child = node("");
  const pid = child.pid ?? -1;
  await new Promise((resolve) => child.once("exit", resolve));
  writeFileSync(join(dir, "c.lock"), lockFile({ pid, started_at: 0 }));
  const lock = unwrap(await acquireLock(at("c.lock")));
  expect(read(lock.path)).toMatchObject({ pid: process.pid });
  expect(leftovers("c.lock")).toEqual([]);
  lock.release();
});

test("a lock whose pid now names a process started later is stale and reclaimed", async () => {
  const earlier = (await ownStart()) - 60_000;
  writeFileSync(
    join(dir, "d.lock"),
    lockFile({ pid: process.pid, started_at: earlier }),
  );
  const lock = unwrap(await acquireLock(at("d.lock")));
  expect(read(lock.path)).toMatchObject({
    pid: process.pid,
    started_at: await ownStart(),
  });
  lock.release();
});

test("a file that is not a lock is refused and left alone", async () => {
  const path = join(dir, "e.lock");
  writeFileSync(path, "precious\n");
  const refused = await acquireLock(at("e.lock"));
  expect(refused.ok ? null : refused.error).toMatchObject({
    class: "conflict",
    message: expect.stringContaining("is not a supervisor lock"),
  });
  expect(readFileSync(path, "utf8")).toBe("precious\n");
  expect(leftovers("e.lock")).toEqual([]);
});

test("a lock from another host is refused: its owner cannot be probed from here", async () => {
  const path = join(dir, "f.lock");
  const content = lockFile({
    pid: 999_999,
    started_at: 0,
    host: `not-${hostname()}`,
  });
  writeFileSync(path, content);
  const refused = await acquireLock(at("f.lock"));
  expect(refused.ok ? null : refused.error).toMatchObject({
    class: "conflict",
    message: expect.stringContaining("on another host"),
  });
  expect(readFileSync(path, "utf8")).toBe(content);
});

test("release leaves a lock that is no longer this process's", async () => {
  const lock = unwrap(await acquireLock(at("g.lock")));
  const other = lockFile({ pid: 999_999, started_at: 0 });
  writeFileSync(lock.path, other);
  lock.release();
  expect(readFileSync(lock.path, "utf8")).toBe(other);
});

test("two takers at once over a stale lock: exactly one wins, and nothing is left behind", async () => {
  const path = join(dir, "h.lock");
  writeFileSync(path, lockFile({ pid: process.pid, started_at: 0 }));
  const both = await Promise.all([
    acquireLock(at("h.lock")),
    acquireLock(at("h.lock")),
  ]);
  const won = both.flatMap((r) => (r.ok ? [r.value] : []));
  expect(won).toHaveLength(1);
  expect(both.flatMap((r) => (r.ok ? [] : [r.error.class]))).toEqual([
    "conflict",
  ]);
  expect(read(path)).toMatchObject({
    pid: process.pid,
    started_at: await ownStart(),
  });
  expect(leftovers("h.lock")).toEqual([]);
  for (const lock of won) lock.release();
  expect(existsSync(path)).toBe(false);
});
