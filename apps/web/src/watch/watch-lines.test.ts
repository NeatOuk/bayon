import type { EventItem } from "@bayon/proto";
import { describe, expect, test } from "vitest";
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
import { sanitize, watchLines } from "@/watch/watch-lines";
import { terminalTheme } from "@/lib/terminal-theme";

const ESC = "\x1b";
const RED = `${ESC}[31m`;
const GREEN = `${ESC}[32m`;
const MUTED = `${ESC}[90m`;

/** The lines without their ANSI styling: what the operator reads. */
const plain = (event: EventItem): string[] =>
  watchLines(event)
    // eslint-disable-next-line no-control-regex -- stripping the pane's own SGR codes
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .slice(0, -1);

describe("watchLines: each canonical event as terminal lines", () => {
  test("a turn is marked, in the theme's primary colour", () => {
    const out = watchLines(turnStart(1));
    expect(out.startsWith(GREEN)).toBe(true);
    expect(plain(turnStart(1))).toEqual(["── turn · 08:00:01 ──"]);
    expect(
      plain({
        ...turnStart(2),
        kind: "turn_end",
        payload: {
          stop_reason: "end_turn",
          usage: {
            tokens_in: 10,
            tokens_out: 3,
            tokens_cache_read: 0,
            tokens_cache_write: 0,
          },
        },
      }),
    ).toEqual(["── turn end · end_turn · 10 in · 3 out ──"]);
  });

  test("assistant text is shown as written, line by line", () => {
    expect(plain(text(1, "first line\nsecond line"))).toEqual([
      "first line",
      "second line",
    ]);
    expect(plain(reasoning(2, "thinking hard"))).toEqual([
      "(thinking · 13 chars)",
    ]);
  });

  test("a tool call is its name and its input on one line, cut at 160 characters", () => {
    expect(plain(toolCall(1))).toEqual(['▸ shell {"cmd":"pnpm test"}']);
    const long: EventItem = {
      id: 2,
      ts: 0,
      runner_type: "fixture.line",
      kind: "tool_call",
      tool_name: "shell",
      payload: { call_id: "c2", input: { cmd: "x".repeat(400) } },
    };
    const [line] = plain(long);
    expect(line?.endsWith("…")).toBe(true);
    expect(line?.length).toBeLessThan(180);
  });

  test("a result shows its status and the head of its output; an error result is red", () => {
    expect(plain(toolResult(1, "ok"))).toEqual([
      "  ↳ shell → ok",
      "    head 1",
    ]);
    const failed = watchLines(toolResult(2, "error", 1));
    expect(failed.startsWith(RED)).toBe(true);
    expect(plain(toolResult(2, "error", 1))[0]).toBe(
      "  ↳ shell → error · exit 1",
    );
    const many: EventItem = {
      id: 3,
      ts: 0,
      runner_type: "fixture.line",
      kind: "tool_result",
      tool_name: "shell",
      status: "ok",
      payload: {
        call_id: "c3",
        head: Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n"),
        output_path: "logs/tool/c3.txt",
      },
    };
    const lines = plain(many);
    expect(lines).toHaveLength(1 + 12 + 1 + 1);
    expect(lines.at(-2)).toBe("    … 8 more lines");
    expect(lines.at(-1)).toBe("    → logs/tool/c3.txt");
  });

  test("a command is its argv, exit and duration; a failed one is red", () => {
    expect(plain(command(1, 0))).toEqual(["$ pnpm test → exit 0 · 1.3s"]);
    expect(watchLines(command(2, 2)).startsWith(RED)).toBe(true);
  });

  test("file changes, errors and the run's end", () => {
    expect(plain(fileChange(1, "src/a.ts"))).toEqual(["  M src/a.ts +18 -4"]);
    expect(watchLines(error(2, "boom")).startsWith(RED)).toBe(true);
    expect(plain(error(2, "boom"))).toEqual(["✖ runner_error: boom"]);
    expect(plain(terminal(3, "ok"))).toEqual(["■ run ok"]);
    expect(watchLines(terminal(3, "ok")).startsWith(GREEN)).toBe(true);
    expect(watchLines(terminal(4, "failed")).startsWith(RED)).toBe(true);
  });

  test("usage is left to the spend screens: no line", () => {
    expect(
      watchLines({
        ...turnStart(1),
        kind: "usage",
        payload: {
          usage: {
            tokens_in: 1,
            tokens_out: 1,
            tokens_cache_read: 0,
            tokens_cache_write: 0,
          },
        },
      }),
    ).toBe("");
  });

  test("a truncated event names its size and where the rest is, and never more (§8.5)", () => {
    const capped = {
      ...toolResult(1, "ok"),
      truncated: true,
      bytes_original: 20_480,
      payload_path: "logs/tool/c1.txt",
    } satisfies EventItem;
    const lines = plain(capped);
    expect(lines.at(-1)).toBe("    … truncated · 20.0 KB → logs/tool/c1.txt");
    expect(watchLines(capped).split("\n").at(-2)?.startsWith(MUTED)).toBe(true);
  });
});

test("runner text cannot drive the operator's terminal: control sequences are stripped", () => {
  const hostile = text(1, `ok${ESC}]52;c;cHduZWQ=\x07 ${ESC}[2J\rgone\ttab`);
  const out = watchLines(hostile);
  expect(out).not.toContain(`${ESC}]`);
  expect(out).not.toContain(`${ESC}[2J`);
  expect(out).not.toContain("\r");
  expect(out).toBe("ok]52;c;cHduZWQ= [2Jgone\ttab\n");
  expect(sanitize("a\nb\tc\x00\x7f\x9b")).toBe("a\nb\tc");
});

test("no event field reaches the terminal unstripped: a model name or stop reason is runner text too", () => {
  const osc = `${ESC}]52;c;cHduZWQ=\x07`;
  const init = {
    ...turnStart(1),
    kind: "session_init",
    payload: { runner_session_id: "rs-1", model: `m${osc}` },
  } as unknown as EventItem;
  const end = {
    ...turnStart(2),
    kind: "turn_end",
    payload: {
      stop_reason: `end${ESC}[2J`,
      usage: {
        tokens_in: 1,
        tokens_out: 1,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
      },
    },
  } as unknown as EventItem;
  for (const event of [init, end]) {
    const out = watchLines(event);
    expect(out).not.toContain(`${ESC}]`);
    expect(out).not.toContain(`${ESC}[2J`);
    expect(out).not.toContain("\x07");
  }
});

test("the terminal's colours are the theme's tokens, read at runtime; an unset token keeps xterm's default", () => {
  const tokens: Readonly<Record<string, string>> = {
    card: "CARD",
    "card-foreground": "INK",
    danger: "DANGER",
    success: "GO",
    "muted-foreground": "QUIET",
  };
  const theme = terminalTheme(undefined, (name) => tokens[name] ?? "");
  expect(theme).toMatchObject({
    background: "CARD",
    foreground: "INK",
    red: "DANGER",
    brightRed: "DANGER",
    green: "GO",
    brightBlack: "QUIET",
  });
  expect(theme).not.toHaveProperty("selectionBackground");
});
