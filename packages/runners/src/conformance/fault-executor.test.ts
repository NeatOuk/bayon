import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutor, SlotCounter, type Argv } from "@bayon/executors";
import {
  describeExecutorContract,
  readAll,
  within,
} from "@bayon/executors/contract";
import { FakeExecutor, type FakeProgram } from "@bayon/executors/testing";
import { afterAll, describe, expect, test } from "vitest";
import { FaultExecutor } from "./fault-executor.js";

const node = (source: string): Argv => [process.execPath, "-e", source];

// The executor contract's programs, as the local and fake executors' own tests define them.
const LOCAL_PROGRAMS = {
  cat: node("process.stdin.pipe(process.stdout)"),
  interleave: node(`
    const rl = require("node:readline").createInterface({ input: process.stdin });
    const acks = rl[Symbol.asyncIterator]();
    (async () => {
      for (const [line, out] of [[1, process.stdout], [2, process.stderr], [3, process.stdout], [4, process.stderr]]) {
        out.write(line + "\\n");
        await acks.next();
      }
      rl.close();
      process.stdin.destroy();
    })();`),
  whereami: node(
    'process.stdout.write([process.cwd(), process.env.FOO, process.env.HOME ?? "-", ""].join("\\n"))',
  ),
  exit3: node("process.exit(3)"),
  forever: node("setInterval(() => {}, 1 << 30)"),
  missing: ["/nonexistent/frm-no-such-program"] as Argv,
  ptyEcho: node(`
    const size = () => process.stdout.write("size " + process.stdout.columns + "x" + process.stdout.rows + "\\n");
    process.stdout.on("resize", size);
    size();
    process.stdin.resume();`),
};

const FAKE_PROGRAMS: Record<string, FakeProgram> = {
  cat: async ({ stdin, stdout }) => {
    for await (const chunk of stdin) stdout.write(chunk);
    return 0;
  },
  interleave: async ({ stdin, stdout, stderr }) => {
    const acks = stdin[Symbol.asyncIterator]();
    for (const [line, out] of [
      ["1", stdout],
      ["2", stderr],
      ["3", stdout],
      ["4", stderr],
    ] as const) {
      out.write(`${line}\n`);
      await acks.next();
    }
    return 0;
  },
  whereami: ({ cwd, env, stdout }) => {
    stdout.write(`${cwd}\n${env["FOO"] ?? ""}\n${env["HOME"] ?? "-"}\n`);
    return 0;
  },
  exit3: () => 3,
  forever: () => new Promise<number>(() => {}),
  ptyEcho: async ({ pty, stdin, stdout }) => {
    if (pty === null) return 2;
    const size = () => stdout.write(`size ${pty.cols}x${pty.rows}\n`);
    pty.onResize(size);
    size();
    for await (const chunk of stdin) stdout.write(chunk);
    return 0;
  },
};

// With no fault armed, the wrapper must be invisible: the whole contract, over both executors.
describeExecutorContract("fault(local)", () => {
  const slots = new SlotCounter(2);
  return {
    slots,
    executor: new FaultExecutor(new LocalExecutor({ id: "local", slots })),
    programs: LOCAL_PROGRAMS,
  };
});

describeExecutorContract("fault(fake)", () => {
  const slots = new SlotCounter(2);
  return {
    slots,
    executor: new FaultExecutor(
      new FakeExecutor({ programs: FAKE_PROGRAMS, slots }),
    ),
    programs: {
      cat: ["cat"],
      interleave: ["interleave"],
      whereami: ["whereami"],
      exit3: ["exit3"],
      forever: ["forever"],
      missing: ["missing"],
      ptyEcho: ["ptyEcho"],
    },
  };
});

describe("FaultExecutor faults", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "frm-fault-")));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** Writes its chunks in order, one per event-loop turn, so the wrapper sees them apart. */
  const chunks =
    (...parts: string[]): FakeProgram =>
    async ({ stdout }) => {
      for (const part of parts) {
        stdout.write(part);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return 0;
    };

  const fake = (programs: Record<string, FakeProgram>) =>
    new FaultExecutor(new FakeExecutor({ programs }));

  test("inject lands after the first record, at a boundary, without splitting a line", async () => {
    const ex = fake({ p: chunks("rec1\nre", "c2\nrec3\n") });
    const armed = ex.inject(dir, [{ x: 1 }, { y: 2 }]);
    const proc = await ex.exec(["p"], { cwd: dir, env: {} });
    expect(await within(readAll(proc.stdout), "stdout")).toBe(
      'rec1\n{"x":1}\n{"y":2}\nrec2\nrec3\n',
    );
    await within(armed.fired, "fired");
  });

  test("afterRecords counts records split across chunks", async () => {
    const ex = fake({ p: chunks("rec1\nre", "c2\nrec3\n") });
    ex.inject(dir, [{ x: 1 }], { afterRecords: 2 });
    const proc = await ex.exec(["p"], { cwd: dir, env: {} });
    expect(await within(readAll(proc.stdout), "stdout")).toBe(
      'rec1\nrec2\n{"x":1}\nrec3\n',
    );
  });

  test("stall drops everything after the first record but keeps draining: the program exits", async () => {
    const ex = new FaultExecutor(
      new LocalExecutor({ id: "local", slots: new SlotCounter(2) }),
    );
    const armed = ex.stall(dir);
    // A megabyte after the first line: an undrained pipe would block the program forever.
    const proc = await ex.exec(
      node(
        'process.stdout.write("one\\n"); process.stdout.write("x".repeat(1 << 20) + "\\n"); process.stdout.write("last\\n");',
      ),
      { cwd: dir, env: {}, stdin: "ignore" },
    );
    expect(await within(readAll(proc.stdout), "stdout")).toBe("one\n");
    expect(await within(proc.exited, "exit")).toEqual({
      code: 0,
      signal: null,
    });
    await within(armed.fired, "fired");
  });

  test("kill9 kills the latest process in a cwd; refs and argv are tracked per cwd, env never", async () => {
    const ex = fake({ forever: () => new Promise<number>(() => {}) });
    const first = await ex.exec(["forever", "--one"], {
      cwd: dir,
      env: { SECRET: "x" },
    });
    const second = await ex.exec(["forever", "--two"], { cwd: dir, env: {} });
    expect(ex.refOf(dir)).toBe(second.ref);
    expect(ex.argvOf(dir)).toEqual([
      ["forever", "--one"],
      ["forever", "--two"],
    ]);
    expect(ex.kill9(dir)).toBe(true);
    expect(await within(second.exited, "second")).toEqual({
      code: null,
      signal: "SIGKILL",
    });
    expect(await ex.exitedOf(dir)).toEqual({ code: null, signal: "SIGKILL" });
    expect(await ex.probe(first.ref)).toBe("alive");
    first.kill("SIGKILL");
    expect(ex.kill9(join(dir, "elsewhere"))).toBe(false);
    expect(ex.refOf(join(dir, "elsewhere"))).toBeUndefined();
    expect(ex.argvOf(join(dir, "elsewhere"))).toEqual([]);
  });
});
