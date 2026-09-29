import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, systemClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { pollUntil } from "./deadline.js";
import {
  isAlive,
  logTail,
  reapAll,
  startChild,
  stopChild,
  type Child,
} from "./procs.js";

const dir = mkdtempSync(join(tmpdir(), "frm-procs-"));
afterAll(() => {
  reapAll();
  rmSync(dir, { recursive: true, force: true });
});

const node = (name: string, script: string): Child => {
  const started = startChild({
    name,
    argv: [process.execPath, "-e", script],
    env: process.env,
    logPath: join(dir, `${name}.log`),
  });
  if (!started.ok) throw new Error(started.error.message);
  return started.value;
};

/** Waits (with a deadline) for the child's first log line, and returns it. */
const firstLine = (child: Child) =>
  pollUntil(
    {
      clock: systemClock,
      timeoutMs: 10_000,
      intervalMs: 20,
      what: `${child.name} log`,
    },
    async () =>
      ok(readFileSync(child.logPath, "utf8").split("\n")[0] || undefined),
  );

test("stopChild: SIGTERM reaches the whole process group", async () => {
  const child = node(
    "parent",
    `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
     console.log(c.pid); setInterval(() => {}, 1000);`,
  );
  const grandchild = Number(
    (await firstLine(child)).ok && readFileSync(child.logPath, "utf8").trim(),
  );
  expect(isAlive(grandchild)).toBe(true);
  expect(await stopChild(child, systemClock, 5_000)).toEqual({
    code: null,
    signal: "SIGTERM",
  });
  const gone = await pollUntil(
    {
      clock: systemClock,
      timeoutMs: 10_000,
      intervalMs: 20,
      what: "grandchild gone",
    },
    async () => ok(isAlive(grandchild) ? undefined : true),
  );
  expect(gone).toEqual(ok(true));
  expect(child.status()).toEqual({ code: null, signal: "SIGTERM" });
});

test("stopChild escalates to SIGKILL when SIGTERM is ignored", async () => {
  const child = node(
    "stubborn",
    `process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);`,
  );
  await firstLine(child);
  expect(await stopChild(child, systemClock, 200)).toEqual({
    code: null,
    signal: "SIGKILL",
  });
});

test("a child that exits reports its code; logTail keeps the last lines", async () => {
  const child = node(
    "talker",
    `for (let i = 1; i <= 30; i++) console.log("line " + i); process.exit(3);`,
  );
  expect(await child.exited).toEqual({ code: 3, signal: null });
  expect(logTail(child.logPath, 2)).toBe("line 29\nline 30");
  expect(logTail(join(dir, "missing.log"))).toBe("(no log)");
});

test("an argv that cannot start is spawn_failed", () => {
  const started = startChild({
    name: "ghost",
    argv: [join(dir, "no-such-binary")],
    env: process.env,
    logPath: join(dir, "ghost.log"),
  });
  expect(started.ok ? null : started.error.class).toBe("spawn_failed");
});
