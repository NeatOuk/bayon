import { describe, expect, test } from "vitest";
import {
  categoriesOf,
  filterEvents,
  formatBytes,
  isError,
  lastErrorIndex,
} from "@/timeline/event-view";
import {
  command,
  error,
  fileChange,
  reasoning,
  terminal,
  text,
  toolCall,
  toolResult,
  turnStart,
} from "@/test/fixtures";

describe("isError", () => {
  test.each([
    ["an error event", error(1, "boom"), true],
    ["a failed tool result", toolResult(1, "error"), true],
    ["a tool result with a non-zero exit", toolResult(1, "ok", 2), true],
    ["a successful tool result", toolResult(1, "ok", 0), false],
    ["a command with a non-zero exit", command(1, 1), true],
    ["a command that passed", command(1, 0), false],
    ["a failed run", terminal(1, "failed"), true],
    ["a timed-out run", terminal(1, "timeout"), true],
    ["a run that passed", terminal(1, "ok"), false],
    ["text", text(1), false],
  ])("%s → %s", (_name, event, expected) => {
    expect(isError(event)).toBe(expected);
  });
});

describe("categoriesOf", () => {
  test.each([
    [toolCall(1), ["tools"]],
    [toolResult(1, "error"), ["tools", "errors"]],
    [command(1, 0), ["tools"]],
    [text(1), ["text"]],
    [reasoning(1, "hmm"), ["text"]],
    [fileChange(1, "a.ts"), ["files"]],
    [error(1, "boom"), ["errors"]],
    [turnStart(1), []],
  ])("%j", (event, expected) => {
    expect([...categoriesOf(event)].sort()).toEqual([...expected].sort());
  });
});

describe("filterEvents", () => {
  const items = [
    text(1),
    toolCall(2),
    toolResult(3, "error"),
    fileChange(4, "a.ts"),
    error(5, "boom"),
  ];

  test("no active filter shows everything", () => {
    expect(filterEvents(items, new Set())).toBe(items);
  });

  test("active filters combine as a union", () => {
    const shown = filterEvents(items, new Set(["errors", "files"] as const));
    expect(shown.map((item) => item.id)).toEqual([3, 4, 5]);
  });
});

test("lastErrorIndex finds the last error, or -1", () => {
  expect(
    lastErrorIndex([text(1), error(2, "a"), text(3), error(4, "b"), text(5)]),
  ).toBe(3);
  expect(lastErrorIndex([text(1)])).toBe(-1);
});

test("formatBytes", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(43_008)).toBe("42.0 KB");
  expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
});
