// A kill -9 can land anywhere in the program, inside a state save too: between the
// save's truncate and its write, a plain writeFileSync leaves the state file empty, and the resumed
// process then exits 3 ("no state to resume"). §15 #8 kills right after a run's tool_call is out,
// which is exactly when that event's save runs. The state must survive: the last save, whole.
import { afterEach, expect, test, vi } from "vitest";
import { removeTempDirs, start, untilTerminal } from "./program-harness.js";
import type { FixtureScriptInput } from "./program.js";

afterEach(removeTempDirs);

const kill = vi.hoisted(() => ({ fired: 0 }));

/** The save that follows the slow run's tool_call: run 1, its second event. */
const TOOL_CALL_SAVE = '"runIndex":1,"eventIndex":2';

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    // SIGKILL between open(O_TRUNC) and write(2): the file written is left empty and nothing after
    // it runs. The throw ends runFixture as the kill ends the process.
    writeFileSync: (...args: Parameters<typeof real.writeFileSync>) => {
      const [path, data] = args;
      if (typeof data === "string" && data.includes(TOOL_CALL_SAVE)) {
        kill.fired += 1;
        real.writeFileSync(path, "");
        throw new Error("killed mid-save");
      }
      real.writeFileSync(...args);
    },
  };
});

const step = (kind: string, extra: Record<string, unknown> = {}) => ({
  kind,
  runner_type: "t",
  payload: {},
  ...extra,
});
const script: FixtureScriptInput = {
  runs: [
    { events: [step("turn_start"), step("turn_end")] },
    {
      events: [step("turn_start"), step("tool_call", { tool_name: "shell" })],
      then: "hang",
    },
    {
      events: [
        step("turn_start"),
        step("assistant_text", { text: "recalled" }),
        step("turn_end"),
      ],
    },
  ],
};

test("a kill mid-save leaves the last whole state, and the resumed process recalls", async () => {
  const first = start({ script });
  first.op({ op: "send", runId: "run-1", text: "remember" });
  await untilTerminal(first);
  first.op({ op: "send", runId: "run-2", text: "slow" });
  await expect(first.exit).rejects.toThrow("killed mid-save");
  expect(first.lines().map((l) => l["kind"])).toContain("tool_call");
  expect(kill.fired).toBe(1);

  const resumed = start({ script, resume: true, home: first.home });
  resumed.op({ op: "send", runId: "run-3", text: "recall" });
  const lines = await untilTerminal(resumed);
  expect(lines.map((l) => l["kind"])).toEqual([
    "session_init",
    "turn_start",
    "assistant_text",
    "turn_end",
    "terminal",
  ]);
  expect(lines[2]).toMatchObject({ text: "recalled" });
  resumed.eof();
  expect(await resumed.exit).toBe(0);
});
