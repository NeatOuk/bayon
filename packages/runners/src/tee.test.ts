import type { Proc } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import { expect, test } from "vitest";
import type { RawRecord } from "./adapter.js";
import { STDERR_TAIL_BYTES, tee } from "./tee.js";

const decoder = new TextDecoder();
const text = (r: RawRecord) => decoder.decode(r.bytes);

const executor = new FakeExecutor({
  programs: {
    talk: async (io) => {
      io.stdout.write("a\nb");
      io.stderr.write("oops\n");
      return 3;
    },
    noisy: async (io) => {
      io.stderr.write(`${"x".repeat(20_000)}END`);
      return 0;
    },
    forever: (io) =>
      new Promise<number>((resolve) =>
        io.signal.addEventListener("abort", () => resolve(0)),
      ),
    lines: async (io) => {
      io.stdout.write("one\ntwo\n");
      return 0;
    },
  },
});
const run = (name: string): Promise<Proc> =>
  executor.exec([name], { cwd: "/", env: {} });

async function all(source: AsyncIterable<RawRecord>): Promise<RawRecord[]> {
  const out: RawRecord[] = [];
  for await (const r of source) out.push(r);
  return out;
}

test("records are stdout lines; exit info has the code and the stderr tail", async () => {
  const { records, exited } = tee(await run("talk"));
  const got = await all(records);
  expect(got.map((r) => [text(r), r.partial])).toEqual([
    ["a", false],
    ["b", true],
  ]);
  expect(await exited).toEqual({ code: 3, stderrTail: "oops\n" });
});

test("the stderr tail keeps the last 16 KB", async () => {
  const { exited } = tee(await run("noisy"));
  const { stderrTail } = await exited;
  expect(stderrTail).toHaveLength(STDERR_TAIL_BYTES);
  expect(stderrTail.endsWith("END")).toBe(true);
});

test("a killed process reports its signal, not a code", async () => {
  const proc = await run("forever");
  const { exited, records } = tee(proc);
  proc.kill("SIGKILL");
  expect(await exited).toEqual({ signal: "SIGKILL", stderrTail: "" });
  expect(await all(records)).toEqual([]);
});

test("a line reaches records before forward, and reading waits for a slow reader", async () => {
  const forwarded: string[] = [];
  let wake: (() => void) | undefined;
  const forwardedAgain = () =>
    new Promise<void>((resolve) => {
      wake = resolve;
    });
  const proc = await run("lines");
  const { records, drained } = tee(proc, {
    highWater: 1,
    forward: (r) => {
      forwarded.push(text(r));
      wake?.();
    },
  });
  await proc.exited;
  await new Promise((resolve) => setImmediate(resolve));
  // "one" is queued but over the mark: nothing is forwarded until the reader takes it.
  expect(forwarded).toEqual([]);
  const reader = records[Symbol.asyncIterator]();
  const first = forwardedAgain();
  expect(text((await reader.next()).value as RawRecord)).toBe("one");
  await first;
  expect(forwarded).toEqual(["one"]);
  const second = forwardedAgain();
  expect(text((await reader.next()).value as RawRecord)).toBe("two");
  await second;
  await drained;
  expect(forwarded).toEqual(["one", "two"]);
  expect((await reader.next()).done).toBe(true);
});

test("observe sees each line before any reader can take it", async () => {
  const seen: string[] = [];
  const { records } = tee(await run("lines"), {
    observe: (r) => {
      seen.push(text(r));
    },
  });
  for await (const r of records) expect(seen).toContain(text(r));
  expect(seen).toEqual(["one", "two"]);
});

test("a promise from observe holds its line, and the ones after it, until it settles", async () => {
  const done: string[] = [];
  let release: (() => void) | undefined;
  const { records } = tee(await run("lines"), {
    observe: (r) =>
      text(r) === "one"
        ? new Promise<void>((resolve) => {
            release = () => {
              done.push("one's work");
              resolve();
            };
          })
        : undefined,
  });
  const reader = records[Symbol.asyncIterator]();
  let queued = false;
  const first = reader.next().then((r) => {
    queued = true;
    return r;
  });
  await expect.poll(() => release).toBeDefined();
  expect(queued).toBe(false); // nothing reaches a reader while its work is pending
  release?.();
  expect(text((await first).value as RawRecord)).toBe("one");
  expect(done).toEqual(["one's work"]);
  expect(text((await reader.next()).value as RawRecord)).toBe("two");
});
