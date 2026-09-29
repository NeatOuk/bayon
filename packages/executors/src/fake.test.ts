import { describe, expect, test } from "vitest";
import { describeExecutorContract, readAll } from "./contract.js";
import { FakeExecutor, type FakeProgram } from "./fake.js";
import { SlotCounter } from "./slots.js";

const programs: Record<string, FakeProgram> = {
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
    stdout.write(`${cwd}\n${env.FOO ?? ""}\n${env.HOME ?? "-"}\n`);
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
  crash: () => {
    throw new Error("boom");
  },
};

describeExecutorContract("fake", () => {
  const slots = new SlotCounter(2);
  return {
    slots,
    executor: new FakeExecutor({ slots, programs }),
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

describe("FakeExecutor", () => {
  const executor = new FakeExecutor({ programs });

  test("a program that throws exits 1 with its message on stderr", async () => {
    const proc = await executor.exec(["crash"], { cwd: "/w", env: {} });
    expect(await readAll(proc.stderr)).toBe("boom\n");
    expect(await proc.exited).toEqual({ code: 1, signal: null });
  });

  test("programs see their argv", async () => {
    const echo = new FakeExecutor({
      programs: {
        echo: ({ argv, stdout }) => {
          stdout.write(argv.slice(1).join(" "));
          return 0;
        },
      },
    });
    const proc = await echo.exec(["echo", "a", "b"], { cwd: "/w", env: {} });
    expect(await readAll(proc.stdout)).toBe("a b");
  });

  test("probe: a ref it never minted is dead; a malformed one is refused", async () => {
    expect(await executor.probe("fake:999")).toBe("dead");
    await expect(executor.probe("local:1:2")).rejects.toMatchObject({
      class: "validation",
    });
  });

  test("capacity defaults to the spec's 4 slots", () => {
    expect(executor.capacity()).toEqual({ slots: 4, used: 0 });
  });
});
