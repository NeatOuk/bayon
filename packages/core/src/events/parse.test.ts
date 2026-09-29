import { describe, expect, test } from "vitest";
import { FakeClock } from "../clock.js";
import { UNKNOWN_RUNNER_TYPE, parseCanonical } from "./parse.js";
import { CanonicalEvent, EventKind, type CanonicalEventOf } from "./schema.js";

const NOW = 1_800_000_000_000;
const clock = new FakeClock(NOW);
const base = {
  ts: 1_700_000_000_000,
  runner_type: "fixture.line",
  run_id: "01J0000000000000000000RUN1",
};
const usage = {
  tokens_in: 1_200,
  tokens_out: 340,
  tokens_cache_read: 9_000,
  tokens_cache_write: 0,
};

// One fully-populated event per §5.2 kind; `satisfies` fails to compile if a kind is missing.
const FIXTURES = {
  session_init: {
    ...base,
    kind: "session_init",
    payload: {
      runner_session_id: "rs-1",
      model: "model-a",
      cwd: "/work",
      tools: ["read", "shell"],
      mcp_servers: [{ name: "foreman", status: "connected" }],
    },
  },
  turn_start: { ...base, kind: "turn_start", payload: {} },
  turn_end: {
    ...base,
    kind: "turn_end",
    payload: { usage, stop_reason: "end_turn" },
  },
  assistant_text: {
    ...base,
    kind: "assistant_text",
    text: "done",
    payload: {},
  },
  reasoning: {
    ...base,
    kind: "reasoning",
    text: "compare the two",
    payload: { summary_only: true },
  },
  tool_call: {
    ...base,
    kind: "tool_call",
    tool_name: "shell",
    payload: { call_id: "c1", input: { cmd: "ls" } },
  },
  tool_result: {
    ...base,
    kind: "tool_result",
    tool_name: "shell",
    status: "error",
    exit_code: 2,
    payload: {
      call_id: "c1",
      output_path: "logs/tool/c1.txt",
      head: "first",
      tail: "last",
    },
  },
  file_change: {
    ...base,
    kind: "file_change",
    payload: {
      repo: "app",
      path: "README.md",
      change: "modify",
      lines_added: 2,
      lines_removed: 1,
    },
  },
  command: {
    ...base,
    kind: "command",
    exit_code: 1,
    payload: {
      argv: ["pnpm", "test"],
      cwd: "/work",
      duration_ms: 1_250,
      output_path: "logs/tool/c2.txt",
    },
  },
  todo: {
    ...base,
    kind: "todo",
    payload: {
      items: [
        { text: "write tests", status: "completed" },
        { text: "implement", status: "in_progress" },
        { text: "ship", status: "pending" },
      ],
    },
  },
  mcp_call: {
    ...base,
    kind: "mcp_call",
    tool_name: "ticket.get",
    payload: { server: "foreman", args_digest: "ab12" },
  },
  approval_request: {
    ...base,
    kind: "approval_request",
    tool_name: "shell",
    payload: { input: { cmd: "rm -rf dist" }, risk: "high" },
  },
  usage: { ...base, kind: "usage", payload: { usage, cost_usd: 0.12 } },
  error: {
    ...base,
    kind: "error",
    text: "rate limited",
    payload: {
      class: "runner_error",
      message: "rate limited",
      retryable: true,
    },
  },
  terminal: {
    ...base,
    kind: "terminal",
    payload: {
      outcome: "failed",
      error: {
        class: "runner_exited_without_terminal",
        message: "stream ended",
        retryable: false,
      },
      usage,
      cost_usd: 0.3,
    },
  },
  runner_native: {
    ...base,
    kind: "runner_native",
    payload: { raw: { type: "brand_new", n: 1 } },
  },
} satisfies { [K in EventKind]: CanonicalEventOf<K> };

describe("CanonicalEvent", () => {
  test("the union covers exactly the §5.2 kinds", () => {
    const kinds = CanonicalEvent.options.map((o) => o.shape.kind.value);
    expect([...kinds].sort()).toEqual([...EventKind.options].sort());
    expect(Object.keys(FIXTURES).sort()).toEqual([...EventKind.options].sort());
  });

  test.each(Object.values(FIXTURES))(
    "$kind round-trips through JSON and parse",
    (event) => {
      const wire: unknown = JSON.parse(JSON.stringify(event));
      expect(parseCanonical(wire, clock)).toStrictEqual(event);
    },
  );

  test("the minimal envelope needs only kind, ts, runner_type and payload", () => {
    const event = { kind: "turn_start", ts: 0, runner_type: "t", payload: {} };
    expect(parseCanonical(event, clock)).toStrictEqual(event);
  });

  test("terminal outcomes are run states other than running", () => {
    const terminal = (outcome: string) => ({
      ...base,
      kind: "terminal",
      payload: { outcome },
    });
    for (const outcome of [
      "ok",
      "failed",
      "timeout",
      "interrupted",
      "budget_stop",
    ]) {
      expect(parseCanonical(terminal(outcome), clock).kind).toBe("terminal");
    }
    expect(parseCanonical(terminal("running"), clock).kind).toBe(
      "runner_native",
    );
  });

  test("a terminal's context totals are optional: an old payload still parses", () => {
    const old = {
      ...base,
      kind: "terminal",
      payload: { outcome: "ok", usage, cost_usd: 0.1 },
    };
    expect(parseCanonical(old, clock)).toStrictEqual(old);
    const context = {
      ruleset: "ctx1",
      calls: 3,
      blocks: 5,
      compressed: 2,
      failed: 0,
      chars_in: 90_000,
      chars_out: 20_000,
    };
    const withContext = { ...old, payload: { ...old.payload, context } };
    expect(parseCanonical(withContext, clock)).toStrictEqual(withContext);
    // Malformed totals are stored whole as runner_native; the mappers only write the fold's.
    const bad = {
      ...old,
      payload: { ...old.payload, context: { ...context, calls: -1 } },
    };
    expect(parseCanonical(bad, clock).kind).toBe("runner_native");
  });

  test("extra payload fields are kept; unknown envelope fields are dropped", () => {
    const event = {
      ...FIXTURES.tool_call,
      session_id: "s1",
      ordinal: 3,
      payload: { ...FIXTURES.tool_call.payload, runner_extra: { a: 1 } },
    };
    const parsed = parseCanonical(event, clock);
    expect(parsed).toStrictEqual({
      ...FIXTURES.tool_call,
      payload: { ...FIXTURES.tool_call.payload, runner_extra: { a: 1 } },
    });
  });
});

describe("parseCanonical fallback to runner_native (Invariant 4)", () => {
  test("an unknown kind is stored with the raw input, not dropped", () => {
    const input = {
      kind: "brand_new",
      ts: 42,
      runner_type: "x.brand_new",
      run_id: "r1",
      payload: { a: 1 },
    };
    expect(parseCanonical(input, clock)).toStrictEqual({
      kind: "runner_native",
      ts: 42,
      runner_type: "x.brand_new",
      run_id: "r1",
      payload: { raw: input, issues: [expect.stringMatching(/^kind: /)] },
    });
  });

  test("a known kind with an invalid payload falls back and says why", () => {
    const input = {
      ...base,
      kind: "tool_call",
      tool_name: "shell",
      payload: { input: {} },
    };
    const parsed = parseCanonical(input, clock);
    expect(parsed).toMatchObject({
      kind: "runner_native",
      ts: base.ts,
      runner_type: base.runner_type,
      run_id: base.run_id,
      payload: {
        raw: input,
        issues: [expect.stringMatching(/^payload\.call_id: /)],
      },
    });
  });

  test.each([
    [
      "tool_call without tool_name",
      { ...FIXTURES.tool_call, tool_name: undefined },
    ],
    [
      "tool_result with an unknown status",
      { ...FIXTURES.tool_result, status: "cancelled" },
    ],
    [
      "assistant_text without text",
      { ...FIXTURES.assistant_text, text: undefined },
    ],
    ["a null optional field", { ...FIXTURES.turn_start, run_id: null }],
    ["a fractional ts", { ...FIXTURES.turn_start, ts: 1.5 }],
  ])("%s falls back", (_name, input) => {
    expect(parseCanonical(input, clock).kind).toBe("runner_native");
  });

  test.each([null, undefined, "plain text line", 42, [1, 2], true])(
    "non-object input %j gets the clock's time and an unknown runner type",
    (input) => {
      expect(parseCanonical(input, clock)).toStrictEqual({
        kind: "runner_native",
        ts: NOW,
        runner_type: UNKNOWN_RUNNER_TYPE,
        payload: { raw: input, issues: [expect.any(String)] },
      });
    },
  );

  test("envelope fields that cannot be salvaged are replaced or left out", () => {
    const input = { kind: "brand_new", ts: -1, runner_type: "", run_id: 7 };
    expect(parseCanonical(input, clock)).toStrictEqual({
      kind: "runner_native",
      ts: NOW,
      runner_type: UNKNOWN_RUNNER_TYPE,
      payload: { raw: input, issues: expect.any(Array) },
    });
  });

  test("never throws, even when reading the input throws", () => {
    const hostile = {
      get kind(): string {
        throw new Error("boom");
      },
    };
    expect(parseCanonical(hostile, clock)).toStrictEqual({
      kind: "runner_native",
      ts: NOW,
      runner_type: UNKNOWN_RUNNER_TYPE,
      payload: { raw: hostile, issues: ["input could not be read"] },
    });
  });
});
