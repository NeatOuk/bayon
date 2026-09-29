// A bad call's text: zod's issues with their field paths, and a
// tool's length hint only when a string argument was too long, all inside the one cap (§8.5).
import { HANDOFF_LIMITS, mcpTool, type McpTool } from "@bayon/proto";
import { z } from "zod";
import { describe, expect, test } from "vitest";
import { INVALID_ARGS_CAP, invalidArguments } from "./invalid-args.js";

const toolOf = (wire: string): McpTool => {
  const t = mcpTool(wire);
  if (t === undefined) throw new Error(`no tool ${wire}`);
  return t;
};
const WRITE = toolOf("handoff_write");
const HINT =
  "Shorten each item to 300 characters or fewer (goal_line 200). Put longer detail in a file and list its path under pointers.";

const PACKET = {
  goal_line: "Make the writer path single.",
  decisions: ["guard in the service"],
  traps: [],
  next_steps: ["catch the violation", "fix the fixture", "re-run the tests"],
};

/** The text a bad call to `tool` with `args` gets back. */
function textFor(tool: McpTool, args: Record<string, unknown>): string {
  const parsed = tool.input.safeParse(args);
  if (parsed.success) throw new Error("expected a bad call");
  return invalidArguments(tool, parsed.error);
}

describe("handoff_write: a too-long string gets the hint on its own last line", () => {
  test("an item over 300 characters: zod's text with its path, then the hint", () => {
    const text = textFor(WRITE, { ...PACKET, traps: ["t".repeat(301)] });
    expect(text).toBe(
      "invalid arguments: ✖ Too big: expected string to have <=300 characters\n" +
        `  → at traps[0]\n${HINT}`,
    );
  });

  test("a goal_line over 200 characters: its path, then the hint", () => {
    const text = textFor(WRITE, { ...PACKET, goal_line: "g".repeat(201) });
    expect(text).toContain("<=200 characters\n  → at goal_line");
    expect(text.endsWith(`\n${HINT}`)).toBe(true);
  });

  test("a long item beside a bad count: every issue is kept, and the hint is added once", () => {
    const text = textFor(WRITE, {
      ...PACKET,
      next_steps: ["a", "n".repeat(301)],
    });
    expect(text).toContain("exactly 3 items\n  → at next_steps");
    expect(text).toContain("  → at next_steps[1]");
    expect(text.split(HINT)).toHaveLength(2);
  });

  test("an error longer than the cap is cut before the hint, never through it", () => {
    const long = (n: number) =>
      Array<string>(n).fill("x".repeat(HANDOFF_LIMITS.item + 1));
    const args = {
      goal_line: "g".repeat(HANDOFF_LIMITS.goalLine + 1),
      decisions: long(HANDOFF_LIMITS.decisions),
      traps: long(HANDOFF_LIMITS.traps),
      next_steps: long(HANDOFF_LIMITS.nextSteps),
      open_questions: long(HANDOFF_LIMITS.openQuestions),
      pointers: long(HANDOFF_LIMITS.pointers),
    };
    const parsed = WRITE.input.safeParse(args);
    if (parsed.success) throw new Error("expected a bad call");
    // The case is only worth having if zod's own text is over the cap.
    expect(z.prettifyError(parsed.error).length).toBeGreaterThan(
      INVALID_ARGS_CAP,
    );
    const text = invalidArguments(WRITE, parsed.error);
    expect(text.length).toBeLessThanOrEqual(INVALID_ARGS_CAP);
    expect(text.startsWith("invalid arguments: ✖ Too big")).toBe(true);
    expect(text.endsWith(`\n${HINT}`)).toBe(true);
  });
});

describe("no hint where the length is not the problem", () => {
  test.each([
    ["two next steps", { ...PACKET, next_steps: ["a", "b"] }, "at next_steps"],
    [
      "seven decisions",
      { ...PACKET, decisions: Array<string>(7).fill("d") },
      "at decisions",
    ],
    [
      "an unknown key",
      { ...PACKET, ticket: "T" },
      'Unrecognized key: "ticket"',
    ],
  ])("handoff_write with %s: zod's text alone", (_, args, detail) => {
    const text = textFor(WRITE, args);
    expect(text).toMatch(/^invalid arguments: ✖ /);
    expect(text).toContain(detail);
    expect(text).not.toContain("Shorten");
  });

  test("another tool's too-long string: zod's text alone", () => {
    const text = textFor(toolOf("ticket_comment"), {
      ticket: "T1",
      body_md: "b".repeat(4001),
    });
    expect(text).toBe(
      "invalid arguments: ✖ Too big: expected string to have <=4000 characters\n  → at body_md",
    );
  });

  test("without a hint the text is capped as before", () => {
    const text = textFor(toolOf("ticket_comment"), {
      ticket: "T1",
      body_md: 7,
      ...Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => [`extra_${i}`, i]),
      ),
    });
    expect(text).toHaveLength(INVALID_ARGS_CAP);
  });
});
