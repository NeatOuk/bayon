import { FakeClock } from "@bayon/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SlotCounter } from "../slots.js";
import type { Argv, Proc } from "../types.js";
import { LocalExecutor } from "./local.js";

// Executor.exitedAt and releasePipes on real processes: a
// child exits while a grandchild in its own session (detached: setsid) keeps the child's stdout,
// stderr, or both. The exit is seen at once; the streams end only when released, and the reader
// gets everything written before, then EOF.
//
// The child exits only when the test closes its stdin: exec resolves after it minted the ref (a
// read of the process's start time), and a child that exited on its own could be gone by then, so
// a "before the exit" state would be a race. The grandchild's stdin is ignored: only the test
// holds the child's.

const clock = new FakeClock(1_700_000_000_000);
const ex = new LocalExecutor({
  id: "local",
  slots: new SlotCounter(4),
  clock,
});

const grandchildren: number[] = [];
afterEach(() => {
  for (const pid of grandchildren.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

type Held = "inherit" | "ignore";
/**
 * A child that starts a setsid grandchild holding the chosen pipes, prints its pid and a stderr
 * line, then exits once its stdin closes.
 */
const child = (stdout: Held, stderr: Held): Argv => [
  process.execPath,
  "-e",
  [
    "const { spawn } = require('node:child_process');",
    `const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'],`,
    `  { detached: true, stdio: ['ignore', '${stdout}', '${stderr}'] });`,
    "g.unref();",
    "process.stdout.write('grandchild ' + g.pid + '\\n');",
    "process.stderr.write('child stderr\\n');",
    "process.stdin.on('data', () => {});",
    "process.stdin.on('end', () => process.exit(0));",
  ].join("\n"),
];

const readAll = async (s: AsyncIterable<Uint8Array>): Promise<string> => {
  const parts: Buffer[] = [];
  for await (const chunk of s) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts).toString("utf8");
};

async function run(stdout: Held, stderr: Held): Promise<Proc> {
  return ex.exec(child(stdout, stderr), {
    cwd: process.cwd(),
    env: { PATH: process.env["PATH"] ?? "" },
    stdin: "pipe",
  });
}

/** Lets the child exit: closes its stdin, then waits for its own exit. */
async function letExit(proc: Proc): Promise<void> {
  if (proc.stdin === null) throw new Error("the child's stdin is not piped");
  await proc.stdin.end();
  await proc.exited;
}

const pidIn = (text: string): number =>
  Number(/grandchild (\d+)/.exec(text)?.[1] ?? Number.NaN);

/**
 * A release while the reader still pulls the last chunk is `draining`, by design: the watchdog asks
 * again on its next tick. So does this, until it is released.
 */
const releaseOnceDrained = (ref: string): Promise<void> =>
  vi.waitFor(() => {
    expect(ex.releasePipes(ref).state).toBe("released");
  });

describe("a grandchild holding the child's pipes", () => {
  test("stdout and stderr: the exit is seen, and a release ends both with every byte read", async () => {
    const proc = await run("inherit", "inherit");
    const out = readAll(proc.stdout);
    const err = readAll(proc.stderr);
    // Its stdin is still open, so the child still runs: nothing to release yet.
    expect(ex.exitedAt(proc.ref)).toBeNull();
    expect(ex.releasePipes(proc.ref).state).toBe("unknown");
    await letExit(proc);
    expect(ex.exitedAt(proc.ref)).toBe(clock.now());
    await releaseOnceDrained(proc.ref);
    const text = await out;
    grandchildren.push(pidIn(text));
    expect(text).toMatch(/^grandchild \d+\n$/);
    // Ended normally: no premature-close error reaches the reader (escape 4).
    await expect(err).resolves.toBe("child stderr\n");
  });

  test("stderr only: stdout ends by itself, and the release ends stderr", async () => {
    const proc = await run("ignore", "inherit");
    const out = readAll(proc.stdout);
    const err = readAll(proc.stderr);
    await letExit(proc);
    // The child held stdout alone: its exit ended it.
    const text = await out;
    grandchildren.push(pidIn(text));
    await releaseOnceDrained(proc.ref);
    await expect(err).resolves.toBe("child stderr\n");
  });

  test("stdout only: stderr ends by itself, and the release ends stdout (escape 1)", async () => {
    const proc = await run("inherit", "ignore");
    const out = readAll(proc.stdout);
    const err = readAll(proc.stderr);
    await letExit(proc);
    // The child held stderr alone: its exit ended it.
    await expect(err).resolves.toBe("child stderr\n");
    await releaseOnceDrained(proc.ref);
    const text = await out;
    grandchildren.push(pidIn(text));
    expect(text).toMatch(/^grandchild \d+\n$/);
  });

  test("a reader that never reads keeps it draining until forced", async () => {
    const proc = await ex.exec(
      [
        process.execPath,
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'],",
          "  { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
          "g.unref();",
          "process.stderr.write('grandchild ' + g.pid + '\\n');",
          // More than the PassThrough's high-water mark, less than the pipe and buffers hold, so the
          // child can finish writing and exit while nobody reads.
          "process.stdout.write('x'.repeat(40 * 1024));",
        ].join("\n"),
      ],
      {
        cwd: process.cwd(),
        env: { PATH: process.env["PATH"] ?? "" },
        stdin: "ignore",
      },
    );
    const err = readAll(proc.stderr);
    await proc.exited;
    const behind = ex.releasePipes(proc.ref);
    expect(behind.state).toBe("draining");
    expect(behind.pendingBytes).toBeGreaterThan(0);
    const forced = ex.releasePipes(proc.ref, { force: true });
    expect(forced.state).toBe("released");
    grandchildren.push(pidIn(await err));
  });

  test("an unknown ref is unknown", () => {
    expect(ex.releasePipes("local:1:1")).toEqual({
      state: "unknown",
      pendingBytes: 0,
    });
    expect(ex.exitedAt("local:1:1")).toBeNull();
  });
});
