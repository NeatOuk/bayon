// The packet file goes through the executor only: a
// FakeExecutor records every program, and nothing touches the local filesystem.
import { existsSync } from "node:fs";
import { FakeClock } from "@bayon/core";
import { FakeExecutor, type FakeIo } from "@bayon/executors/testing";
import { expect, test } from "vitest";
import type { ExecCtx } from "./exec.js";
import { writePacketFile } from "./packet-file.js";
import { DEFAULT_SETTINGS } from "./settings.js";

const DIR = "/nonexistent/worktree";
const REL = ".foreman/handoff-2.md";
const ctx: ExecCtx = {
  settings: DEFAULT_SETTINGS,
  clock: new FakeClock(0),
  frmHome: "/nonexistent/home",
  path: "/usr/bin:/bin",
  log: { info: () => undefined, warn: () => undefined, error: () => undefined },
};

async function readStdin(io: FakeIo): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of io.stdin)
    text += decoder.decode(chunk, { stream: true });
  return text;
}

function recording(tee: (io: FakeIo) => Promise<number>) {
  const calls: (readonly string[])[] = [];
  const record =
    (fn: (io: FakeIo) => Promise<number> = async () => 0) =>
    async (io: FakeIo) => {
      calls.push([...io.argv]);
      return fn(io);
    };
  const executor = new FakeExecutor({
    programs: { mkdir: record(), tee: record(tee), mv: record() },
  });
  return { calls, executor };
}

test("writePacketFile runs mkdir, tee to a temp file, then mv, all on the executor", async () => {
  let teed = "";
  const { calls, executor } = recording(async (io) => {
    teed = await readStdin(io);
    return 0;
  });
  const written = await writePacketFile(ctx, executor, DIR, REL, "# packet\n");
  expect(written).toEqual({ ok: true, value: undefined });
  expect(calls).toEqual([
    ["mkdir", "-p", `${DIR}/.foreman`],
    ["tee", `${DIR}/${REL}.tmp`],
    ["mv", "-f", `${DIR}/${REL}.tmp`, `${DIR}/${REL}`],
  ]);
  expect(teed).toBe("# packet\n");
  expect(existsSync(DIR)).toBe(false);
});

test("a step that fails stops the write, and nothing is renamed over the packet", async () => {
  const { calls, executor } = recording(async (io) => {
    await readStdin(io);
    io.stderr.write("No space left on device\n");
    return 1;
  });
  const written = await writePacketFile(ctx, executor, DIR, REL, "# packet\n");
  expect(written).toMatchObject({
    ok: false,
    error: { class: "spawn_failed" },
  });
  expect(written.ok ? "" : written.error.message).toContain("No space left");
  expect(calls.map((c) => c[0])).toEqual(["mkdir", "tee"]);
});
