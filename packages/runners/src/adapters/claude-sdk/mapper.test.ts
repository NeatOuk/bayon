import { readFileSync, readdirSync } from "node:fs";
import { CanonicalEvent, type EventKind } from "@bayon/core";
import { describe, expect, test } from "vitest";
import type { MapInput, MappedEvent } from "../../adapter.js";
import { AssistantFrame, InitFrame, ResultFrame, UserFrame } from "./frames.js";
import { capToRecord } from "../../record-events.js";
import { createMapper } from "./mapper.js";
import { MODELS } from "./registration.js";

const DIR = new URL("../../../fixtures/claude-sdk/", import.meta.url);
const TS = 1_800_000_000_000;
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".jsonl"))
  .toSorted();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Line = MapInput & { readonly json: unknown };
type Mapped = MappedEvent & { readonly raw_offset: number };
type Of<K extends EventKind> = Extract<Mapped, { kind: K }>;

const jsonOf = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return undefined;
  }
};
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;

/** A fixture as the raw log holds it: lines at byte offsets. The marker line is not a runner record. */
function load(name: string): { meta: unknown; records: Line[] } {
  const bytes = readFileSync(new URL(name, DIR));
  const lines: Line[] = [];
  for (let start = 0; start < bytes.length;) {
    const nl = bytes.indexOf(0x0a, start);
    const end = nl === -1 ? bytes.length : nl;
    const line = new Uint8Array(bytes.subarray(start, end));
    lines.push({
      offset: start,
      bytes: line,
      ts: TS,
      json: jsonOf(line),
      ...(nl === -1 ? { partial: true } : {}),
    });
    start = end + 1;
  }
  const [meta, ...records] = lines;
  return { meta: meta?.json, records };
}

function mapAll(records: readonly MapInput[]): Mapped[][] {
  const mapper = createMapper({ prices: MODELS });
  return records.map((r) =>
    mapper
      .map(r)
      .map((e) => ({ ...e, raw_offset: r.offset + e.ordinal }) as Mapped),
  );
}

const events = (name: string): Mapped[] => mapAll(load(name).records).flat();
const kinds = (list: readonly Mapped[]): string[] => list.map((e) => e.kind);
const ofKind = <K extends EventKind>(list: readonly Mapped[], kind: K) =>
  list.filter((e): e is Of<K> => e.kind === kind);
const line = (value: unknown, offset = 0): MapInput => {
  const bytes = encoder.encode(
    typeof value === "string" ? value : JSON.stringify(value),
  );
  return { offset, bytes, ts: TS };
};
const mapOne = (value: unknown): readonly MappedEvent[] =>
  createMapper({ prices: MODELS }).map(line(value));

const GOLDEN: Readonly<Record<string, readonly EventKind[]>> = {
  "plain-turn.jsonl": [
    "session_init",
    "turn_start",
    "reasoning",
    "assistant_text",
    "turn_end",
    "usage",
    "terminal",
  ],
  "tools-file-change.jsonl": [
    "session_init",
    ...["turn_start", "assistant_text", "tool_call", "turn_end", "tool_result"],
    ...["turn_start", "tool_call", "turn_end", "tool_result", "file_change"],
    ...["turn_start", "tool_call", "turn_end", "tool_result", "file_change"],
    ...["turn_start", "tool_call", "turn_end", "tool_result", "command"],
    ...["turn_start", "assistant_text", "turn_end", "usage", "terminal"],
  ] as EventKind[],
  "shell-commands.jsonl": [
    "session_init",
    ...["turn_start", "tool_call", "turn_end", "tool_result", "command"],
    ...["turn_start", "tool_call", "turn_end", "tool_result", "command"],
    ...["turn_start", "tool_call", "turn_end", "tool_result", "command"],
    ...["turn_start", "assistant_text", "turn_end", "usage", "terminal"],
  ] as EventKind[],
  "parallel-subagent.jsonl": [
    "session_init",
    ...["turn_start", "assistant_text", "tool_call", "tool_call", "tool_call"],
    ...["turn_end", "tool_result", "tool_result", "tool_result", "todo"],
    "runner_native", // system/status
    ...["turn_start", "tool_call"], // the Task step stays open while its subagent works
    ...[
      "tool_call",
      "tool_result",
      "mcp_call",
      "tool_result",
      "assistant_text",
    ],
    ...["turn_end", "tool_result"],
    ...["turn_start", "assistant_text", "turn_end", "usage", "terminal"],
    "runner_native", // system/session_state_changed, after the result
  ] as EventKind[],
  "error-turn.jsonl": [
    ...["session_init", "turn_start", "tool_call", "turn_end", "tool_result"],
    ...["command", "error", "usage", "error", "terminal"],
  ] as EventKind[],
  "two-runs.jsonl": [
    ...["session_init", "turn_start", "assistant_text", "turn_end", "usage"],
    "terminal",
    ...["runner_native", "turn_start", "assistant_text", "turn_end", "usage"],
    "terminal",
  ] as EventKind[],
  "zeroed-then-next.jsonl": [
    ...["session_init", "turn_start", "assistant_text", "turn_end", "usage"],
    "terminal",
    ...["runner_native", "turn_start", "assistant_text", "turn_end", "usage"],
    "terminal",
  ] as EventKind[],
  "crash-zeroed.jsonl": [
    ...["session_init", "turn_start", "assistant_text", "turn_end", "usage"],
    ...["error", "terminal", "runner_native"],
  ] as EventKind[],
  "no-terminal.jsonl": ["session_init", "turn_start", "tool_call"],
};

describe("fixtures", () => {
  test("every fixture has a golden sequence", () => {
    expect(Object.keys(GOLDEN).toSorted()).toEqual(FILES);
  });

  test.each(FILES)(
    "%s is marked hand-authored and every frame matches its schema",
    (file) => {
      const { meta, records } = load(file);
      expect(meta).toMatchObject({
        type: "fixture_meta",
        hand_authored: true,
      });
      for (const r of records.filter((r) => r.partial !== true)) {
        const type = field(r.json, "type");
        const subtype = field(r.json, "subtype");
        const schema =
          type === "assistant"
            ? AssistantFrame
            : type === "user"
              ? UserFrame
              : type === "result"
                ? ResultFrame
                : type === "system" && subtype === "init"
                  ? InitFrame
                  : undefined;
        if (schema !== undefined) {
          expect(schema.safeParse(r.json).success, `${file}@${r.offset}`).toBe(
            true,
          );
        }
      }
    },
  );

  test.each(Object.entries(GOLDEN))(
    "%s maps to its golden kind sequence",
    (file, expected) => {
      expect(kinds(events(file))).toEqual(expected);
    },
  );
});

describe.each(FILES)("%s obeys the mapper laws", (file) => {
  const { records } = load(file);
  const perRecord = mapAll(records);
  const all = perRecord.flat();

  test("every event is a valid canonical event stamped with the ingest time", () => {
    for (const e of all) {
      // The envelope strips keys it does not name, so `ordinal` and `raw_offset` are ignored.
      expect(CanonicalEvent.safeParse(e).success, JSON.stringify(e)).toBe(true);
      expect(e.ts).toBe(TS);
    }
  });

  test("L1: ordinals run 0..n-1 below the record length, so raw offsets never collide", () => {
    perRecord.forEach((list, i) => {
      expect(list.map((e) => e.ordinal)).toEqual(list.map((_, j) => j));
      expect(list.length).toBeLessThanOrEqual(records[i]?.bytes.length ?? 0);
    });
    const offsets = all.map((e) => e.raw_offset);
    expect(new Set(offsets).size).toBe(offsets.length);
  });

  test("L2: two fresh mappers over the same bytes and ts give the same events", () => {
    expect(mapAll(records)).toEqual(perRecord);
  });

  test("L3: no prefix of any record makes the mapper throw", () => {
    const mapper = createMapper({ prices: MODELS });
    for (const r of records) {
      for (let cut = 0; cut <= r.bytes.length; cut += 7) {
        expect(() =>
          mapper.map({ ...r, bytes: r.bytes.subarray(0, cut) }),
        ).not.toThrow();
      }
    }
  });

  test("L4: at most one terminal per record, and it is the record's last event", () => {
    for (const list of perRecord) {
      const at = list.flatMap((e, j) => (e.kind === "terminal" ? [j] : []));
      expect(at.length).toBeLessThanOrEqual(1);
      if (at.length === 1) expect(at[0]).toBe(list.length - 1);
    }
  });

  test("L5: each run's top-level turn_end count equals its num_turns", () => {
    const turnsByRun = records
      .filter((r) => field(r.json, "type") === "result")
      .map((r) => field(r.json, "num_turns"));
    const counted: number[] = [];
    let open = 0;
    for (const e of all) {
      if (e.kind === "turn_end" && e.payload["parent_call_id"] === undefined)
        open += 1;
      if (e.kind === "terminal") {
        counted.push(open);
        open = 0;
      }
    }
    expect(counted).toEqual(turnsByRun);
  });
});

describe("payloads", () => {
  test("session_init carries the runner's session, model, cwd, tools and servers", () => {
    const [init] = ofKind(events("plain-turn.jsonl"), "session_init");
    expect(init).toMatchObject({
      runner_type: "system/init",
      payload: {
        runner_session_id: "5f3d2c1b-0a9e-4d8c-b7a6-000000000001",
        model: "claude-sonnet-5",
        cwd: "/work/repo",
        tools: expect.arrayContaining(["Bash", "Edit"]),
        mcp_servers: [{ name: "foreman", status: "connected" }],
        cli_version: "2.1.269",
        permission_mode: "acceptEdits",
      },
    });
  });

  test("session_init splits the exposed tools: the session's MCP tools by wire name, the rest as built-in", () => {
    const init = (tools: string[]) =>
      mapOne({ type: "system", subtype: "init", session_id: "s1", tools })[0]
        ?.payload;
    expect(
      init([
        "mcp__foreman__pulse_report",
        "Bash",
        "mcp__other__x",
        "mcp__foreman__ticket_staff",
      ]),
    ).toMatchObject({
      mcp_tools: ["pulse_report", "ticket_staff"],
      builtin_tools: ["Bash", "mcp__other__x"],
    });
    // An MCP-only spawn (builtinTools none): nothing but the session's tools.
    expect(init(["mcp__foreman__pulse_report"])).toMatchObject({
      mcp_tools: ["pulse_report"],
      builtin_tools: [],
    });
  });

  test("a turn ends with its step's last usage and stop reason", () => {
    const list = events("plain-turn.jsonl");
    expect(ofKind(list, "turn_start")[0]?.payload).toEqual({
      message_id: "msg_plain_01",
      model: "claude-sonnet-5",
    });
    expect(ofKind(list, "turn_end")[0]?.payload).toEqual({
      message_id: "msg_plain_01",
      usage: {
        tokens_in: 12,
        tokens_out: 41,
        tokens_cache_read: 0,
        tokens_cache_write: 2048,
      },
      stop_reason: "end_turn",
    });
  });

  test("the terminal of a clean run is ok and carries the run's spend", () => {
    const [terminal] = ofKind(events("plain-turn.jsonl"), "terminal");
    expect(terminal).toMatchObject({
      runner_type: "result/success",
      payload: {
        outcome: "ok",
        terminal_reason: "completed",
        num_turns: 1,
        duration_ms: 4200,
        cost_usd: 0.005554,
        usage: {
          tokens_in: 12,
          tokens_out: 41,
          tokens_cache_read: 0,
          tokens_cache_write: 2048,
        },
        spend: {
          cost_source: "reported",
          model: "claude-sonnet-5",
          cost_usd: 0.005554,
        },
      },
    });
    expect(terminal?.payload.error).toBeUndefined();
  });

  test("the Done-when sequence appears in order in the tools fixture", () => {
    const want: EventKind[] = [
      "session_init",
      "turn_start",
      "tool_call",
      "tool_result",
      "file_change",
      "turn_end",
      "terminal",
    ];
    const seen = kinds(events("tools-file-change.jsonl"));
    let at = 0;
    for (const k of want) {
      at = seen.indexOf(k, at);
      expect(at, k).toBeGreaterThanOrEqual(0);
      at += 1;
    }
  });

  test("Edit and Write become file changes with line counts", () => {
    const list = events("tools-file-change.jsonl");
    expect(ofKind(list, "file_change").map((e) => e.payload)).toEqual([
      {
        path: "README.md",
        change: "modify",
        lines_added: 2,
        lines_removed: 0,
        call_id: "toolu_tfc_02",
      },
      {
        path: "new.txt",
        change: "add",
        lines_added: 2,
        lines_removed: 0,
        call_id: "toolu_tfc_03",
      },
    ]);
    expect(ofKind(list, "tool_call").map((e) => e.tool_name)).toEqual([
      "Read",
      "Edit",
      "Write",
      "Bash",
    ]);
    const bash = ofKind(list, "tool_result")[3];
    expect(bash).toMatchObject({
      status: "ok",
      tool_name: "Bash",
      text: " README.md | 2 ++\n 1 file changed, 2 insertions(+)",
      payload: { call_id: "toolu_tfc_04" },
    });
    expect(bash?.exit_code).toBeUndefined();
  });

  test("subagent activity names its parent call and never opens a turn", () => {
    const list = events("parallel-subagent.jsonl");
    const nested = list.filter(
      (e) => e.payload["parent_call_id"] === "toolu_ps_task",
    );
    expect(kinds(nested)).toEqual([
      "tool_call",
      "tool_result",
      "mcp_call",
      "tool_result",
      "assistant_text",
    ]);
    expect(
      list.filter(
        (e) =>
          (e.kind === "turn_start" || e.kind === "turn_end") &&
          e.payload["parent_call_id"] !== undefined,
      ),
    ).toEqual([]);
  });

  test("an MCP tool call becomes mcp_call with its server and an args digest", () => {
    const [mcp] = ofKind(events("parallel-subagent.jsonl"), "mcp_call");
    expect(mcp).toMatchObject({
      tool_name: "knowledge_search",
      payload: {
        server: "foreman",
        call_id: "toolu_ps_s2",
        args_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
  });

  test("TodoWrite becomes the new todo list", () => {
    const [todo] = ofKind(events("parallel-subagent.jsonl"), "todo");
    expect(todo?.payload).toEqual({
      call_id: "toolu_ps_c",
      items: [
        { text: "Read the files", status: "completed" },
        { text: "Find TODOs", status: "in_progress" },
      ],
    });
  });

  test("the cumulative usage snapshot keeps every model", () => {
    const [usage] = ofKind(events("parallel-subagent.jsonl"), "usage");
    expect(usage?.payload).toMatchObject({
      cost_usd: 0.0139,
      usage: { tokens_in: 2630, tokens_out: 272 },
      by_model: {
        "claude-sonnet-5": { tokens_in: 970, cost_usd: 0.0121 },
        "claude-haiku-4-5": { tokens_in: 1660, cost_usd: 0.0018 },
      },
    });
  });

  test("a failed tool, an API error frame and an error result map to errors and a failed run", () => {
    const list = events("error-turn.jsonl");
    expect(ofKind(list, "tool_result")[0]).toMatchObject({
      status: "error",
      tool_name: "Bash",
    });
    expect(ofKind(list, "error").map((e) => e.payload)).toEqual([
      expect.objectContaining({
        class: "runner_error",
        runner_error: "overloaded",
        retryable: true,
      }),
      expect.objectContaining({
        class: "runner_error",
        runner_error: "success",
        api_error_status: 529,
        retryable: true,
      }),
    ]);
    const [terminal] = ofKind(list, "terminal");
    expect(terminal?.payload).toMatchObject({
      outcome: "failed",
      terminal_reason: "api_error",
      error: { class: "runner_error", retryable: true },
    });
  });

  test("each Bash result is a command with the exit code its result states, and none otherwise", () => {
    const summary = (list: readonly Mapped[]) =>
      ofKind(list, "command").map((e) => ({
        tool_name: e.tool_name,
        status: e.status,
        exit_code: e.exit_code,
        payload: e.payload,
      }));
    expect(summary(events("shell-commands.jsonl"))).toEqual([
      {
        tool_name: "Bash",
        status: "ok",
        payload: {
          argv: ["pnpm test"],
          call_id: "toolu_sh_01",
          duration_ms: 0,
        },
      },
      {
        tool_name: "Bash",
        status: "error",
        exit_code: 1,
        payload: {
          argv: ["pnpm lint"],
          call_id: "toolu_sh_02",
          duration_ms: 0,
        },
      },
      {
        // returnCodeInterpretation: a non-zero exit the tool calls success, its number unstated.
        tool_name: "Bash",
        status: "ok",
        payload: {
          argv: ["grep -rn TODO src"],
          call_id: "toolu_sh_03",
          duration_ms: 0,
        },
      },
    ]);
    const [passed, , interpreted] = ofKind(
      events("shell-commands.jsonl"),
      "command",
    );
    expect(passed).not.toHaveProperty("exit_code");
    expect(interpreted).not.toHaveProperty("exit_code");
    expect(summary(events("tools-file-change.jsonl"))).toMatchObject([
      { status: "ok", payload: { argv: ["git diff --stat"] } },
    ]);
    // Gate evidence rests on stated codes only (Invariant 10): a success never gets an inferred 0.
    for (const file of FILES) {
      for (const c of ofKind(events(file), "command")) {
        if (c.status === "ok") expect(c, file).not.toHaveProperty("exit_code");
        expect(c.exit_code, file).not.toBe(0);
      }
    }
    expect(summary(events("error-turn.jsonl"))).toMatchObject([
      { status: "error", exit_code: 1, payload: { argv: ["npm test"] } },
    ]);
    // A call with no result yet has no command: it has not ended.
    expect(ofKind(events("no-terminal.jsonl"), "command")).toEqual([]);
  });

  test("two runs in one process bill each run's delta of the running totals", () => {
    const list = events("two-runs.jsonl");
    expect(ofKind(list, "runner_native")[0]?.runner_type).toBe("system/init");
    expect(ofKind(list, "terminal").map((e) => e.payload["spend"])).toEqual([
      expect.objectContaining({
        tokens_in: 1000,
        tokens_out: 100,
        cost_usd: 0.012,
      }),
      expect.objectContaining({
        tokens_in: 1500,
        tokens_out: 150,
        cost_usd: 0.018,
      }),
    ]);
  });

  test("a zeroed result is estimated, and the next real result does not bill it twice", () => {
    const terminals = ofKind(events("zeroed-then-next.jsonl"), "terminal");
    expect(terminals.map((e) => e.payload["spend"])).toEqual([
      expect.objectContaining({
        cost_source: "estimated",
        tokens_in: 400,
        tokens_out: 50,
        cost_usd: 0.0013,
      }),
      expect.objectContaining({
        cost_source: "reported",
        tokens_in: 600,
        tokens_out: 70,
        cost_usd: 0.0017,
      }),
    ]);
  });

  test("a crash with zeroed totals fails, is estimated, and its partial line is kept", () => {
    const list = events("crash-zeroed.jsonl");
    const [terminal] = ofKind(list, "terminal");
    expect(terminal?.payload).toMatchObject({
      outcome: "failed",
      error: {
        class: "runner_error",
        message: "Stream closed unexpectedly",
      },
      spend: {
        cost_source: "estimated",
        tokens_in: 800,
        tokens_out: 30,
        tokens_cache_write: 1024,
        cost_usd: 0.00446,
      },
    });
    expect(list.at(-1)).toMatchObject({
      kind: "runner_native",
      runner_type: "unparsed",
      payload: {
        raw: '{"type":"assistant","message":{"id":"msg_crash_02","con',
        parse_error: "partial line",
      },
    });
  });

  test("a stream that ends mid-run has no terminal: the supervisor writes one", () => {
    expect(ofKind(events("no-terminal.jsonl"), "terminal")).toEqual([]);
  });
});

describe("frames outside the fixtures", () => {
  const init = {
    type: "system",
    subtype: "init",
    session_id: "s-1",
    model: "m",
    cwd: "/work/repo",
    tools: [],
    mcp_servers: [],
  };
  const assistant = (id: string, content: unknown[], parent?: string) => ({
    type: "assistant",
    message: { id, model: "m", content },
    parent_tool_use_id: parent ?? null,
  });
  const user = (content: unknown, toolUseResult?: unknown) => ({
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    ...(toolUseResult === undefined ? {} : { tool_use_result: toolUseResult }),
  });
  const result = (extra: Record<string, unknown>) => ({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    duration_ms: 10,
    total_cost_usd: 0,
    modelUsage: {},
    ...extra,
  });
  /** Maps a sequence of frames with one mapper and returns every event. */
  const run = (...frames: unknown[]): MappedEvent[] => {
    const mapper = createMapper({ prices: MODELS });
    return frames.flatMap((f, i) => mapper.map(line(f, i * 1000)));
  };

  test("an unknown type is stored as runner_native with its raw payload", () => {
    expect(mapOne({ type: "zz_unknown", x: 1 })).toEqual([
      {
        kind: "runner_native",
        ts: TS,
        ordinal: 0,
        runner_type: "zz_unknown",
        payload: { raw: { type: "zz_unknown", x: 1 } },
      },
    ]);
  });

  test("a known type with the wrong shape is runner_native with the issues", () => {
    const [event] = mapOne({ type: "assistant", message: 7 });
    expect(event).toMatchObject({
      kind: "runner_native",
      runner_type: "assistant",
      payload: { raw: { type: "assistant", message: 7 } },
    });
    expect(event?.payload["issues"]).toEqual(
      expect.arrayContaining([expect.stringContaining("message")]),
    );
  });

  test.each([
    ["not JSON", "{nope", "JSON"],
    ["JSON that is not an object", "42", "not a JSON object"],
    ["an array", "[1]", "not a JSON object"],
  ])("%s is runner_native 'unparsed'", (_what, text, issue) => {
    expect(mapOne(text)).toEqual([
      {
        kind: "runner_native",
        ts: TS,
        ordinal: 0,
        runner_type: "unparsed",
        payload: { raw: text, parse_error: expect.stringContaining(issue) },
      },
    ]);
  });

  test("a blank line maps to nothing", () => {
    expect(mapOne("")).toEqual([]);
  });

  test("a partial line is unparsed even when it happens to be valid JSON", () => {
    const mapper = createMapper({ prices: MODELS });
    expect(
      mapper.map({ ...line({ type: "keep_alive" }), partial: true }),
    ).toEqual([
      expect.objectContaining({
        runner_type: "unparsed",
        payload: { raw: '{"type":"keep_alive"}', parse_error: "partial line" },
      }),
    ]);
  });

  test("transport frames map to nothing", () => {
    for (const type of [
      "keep_alive",
      "control_response",
      "control_cancel_request",
    ]) {
      expect(mapOne({ type, response: {} })).toEqual([]);
    }
  });

  test("a tool permission request becomes an approval request", () => {
    expect(
      mapOne({
        type: "control_request",
        request_id: "req-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "rm -rf /" },
        },
      }),
    ).toEqual([
      {
        kind: "approval_request",
        ts: TS,
        ordinal: 0,
        runner_type: "control_request",
        tool_name: "Bash",
        payload: { input: { command: "rm -rf /" }, request_id: "req-1" },
      },
    ]);
  });

  test("any other control request is runner_native", () => {
    expect(
      mapOne({
        type: "control_request",
        request_id: "r",
        request: { subtype: "mcp_message" },
      }),
    ).toEqual([
      expect.objectContaining({
        kind: "runner_native",
        runner_type: "control_request",
      }),
    ]);
  });

  test("a compaction boundary is runner_native flagged as compaction", () => {
    expect(mapOne({ type: "system", subtype: "compact_boundary" })).toEqual([
      expect.objectContaining({
        kind: "runner_native",
        runner_type: "system/compact_boundary",
        payload: expect.objectContaining({ compaction: true }),
      }),
    ]);
  });

  test("redacted thinking and unknown content blocks are kept", () => {
    const list = run(
      init,
      assistant("a1", [
        { type: "redacted_thinking", data: "xyz" },
        { type: "server_tool_use", id: "srv", name: "web_search", input: {} },
      ]),
    );
    expect(list.slice(2)).toEqual([
      expect.objectContaining({
        kind: "reasoning",
        text: "",
        payload: { redacted: true },
      }),
      expect.objectContaining({
        kind: "runner_native",
        runner_type: "assistant",
        payload: {
          raw: {
            type: "server_tool_use",
            id: "srv",
            name: "web_search",
            input: {},
          },
        },
      }),
    ]);
  });

  test("a frame of a step that already ended does not reopen it", () => {
    const list = run(
      init,
      assistant("a1", [
        { type: "tool_use", id: "t1", name: "Read", input: {} },
      ]),
      user([{ type: "tool_result", tool_use_id: "t1", content: "x" }]),
      assistant("a1", [{ type: "text", text: "late" }]),
    );
    expect(kinds(list as Mapped[])).toEqual([
      "session_init",
      "turn_start",
      "tool_call",
      "turn_end",
      "tool_result",
      "assistant_text",
    ]);
  });

  test("a result for an unknown call, and a user frame without tool results", () => {
    const list = run(
      init,
      user([
        {
          type: "tool_result",
          tool_use_id: "nobody",
          content: [{ type: "image" }],
        },
      ]),
      user("just text"),
    );
    expect(list[1]).toMatchObject({
      kind: "tool_result",
      status: "ok",
      payload: { call_id: "nobody" },
    });
    expect(list[1]?.tool_name).toBeUndefined();
    expect(list[1]?.text).toBeUndefined();
    expect(list[2]).toMatchObject({
      kind: "runner_native",
      runner_type: "user",
    });
  });

  const clean = { stdout: "", stderr: "", interrupted: false };
  const toolUse = (id: string, command: unknown) => ({
    type: "tool_use",
    id,
    name: "Bash",
    input: { command },
  });
  const bash = (id: string, command: unknown) =>
    assistant(`m-${id}`, [toolUse(id, command)]);
  const bashResult = (
    id: string,
    output: unknown,
    block: Readonly<Record<string, unknown>> = {},
  ) =>
    user(
      [{ type: "tool_result", tool_use_id: id, content: "out", ...block }],
      output,
    );
  const commandsOf = (list: readonly MappedEvent[]) =>
    list.flatMap((e) => (e.kind === "command" ? [e] : []));

  test("an interrupted, timed-out or backgrounded command has no exit code, and says why", () => {
    const list = commandsOf(
      run(
        init,
        bash("c1", "pnpm test"),
        bashResult("c1", { ...clean, interrupted: true }),
        bash("c2", "sleep 900"),
        bashResult("c2", {
          ...clean,
          backgroundTaskId: "b1",
          timedOutAfterMs: 120_000,
        }),
        bash("c3", "pnpm dev"),
        bashResult("c3", { ...clean, backgroundTaskId: "b2" }),
      ),
    );
    // Only the interrupted one has ended: the other two still run in the background.
    expect(
      list.map((e) => [e.status, e.exit_code, e.payload.duration_ms]),
    ).toEqual([
      ["interrupted", undefined, 0],
      ["timeout", undefined, undefined],
      ["background", undefined, undefined],
    ]);
  });

  test("an exit code the result does not state is none, never guessed", () => {
    const list = run(
      init,
      bash("d1", "rm -rf /"),
      bashResult("d1", undefined, {
        content: "Permission to use Bash has been denied.",
        is_error: true,
      }),
      bash("d2", "echo 'Exit code 3'"),
      bashResult("d2", undefined, { content: "Exit code 3" }),
      bash("d3", "make"),
      bashResult("d3", { weird: true }),
      bash("d4", "true"),
      bashResult("d4", clean),
      assistant("m-par", [toolUse("p1", "ls"), toolUse("p2", "false")]),
      // Two results in one frame: the structured output is ambiguous, so it is not used.
      user(
        [
          { type: "tool_result", tool_use_id: "p1", content: "a" },
          {
            type: "tool_result",
            tool_use_id: "p2",
            content: "Exit code 1",
            is_error: true,
          },
        ],
        clean,
      ),
    );
    expect(
      commandsOf(list).map((e) => [e.payload.argv, e.status, e.exit_code]),
    ).toEqual([
      [["rm -rf /"], "error", undefined],
      [["echo 'Exit code 3'"], "ok", undefined],
      [["make"], "ok", undefined],
      [["true"], "ok", undefined], // a clean success: still no code, never an inferred 0
      [["ls"], "ok", undefined],
      [["false"], "error", 1],
    ]);
    // Commands come last in their record, so the events before them keep their raw offsets.
    expect(list.slice(-5).map((e) => e.kind)).toEqual([
      "turn_end",
      "tool_result",
      "tool_result",
      "command",
      "command",
    ]);
  });

  test("a Bash call without a command string maps as before; an unreadable result frame stays runner_native", () => {
    const list = run(
      init,
      assistant("m-x", [
        { type: "tool_use", id: "x1", name: "Bash", input: { cmd: "ls" } },
      ]),
      bashResult("x1", clean),
      bash("x2", "ls"),
      { type: "user", message: 7, tool_use_result: clean },
    );
    expect(list.map((e) => e.kind)).toEqual([
      "session_init",
      ...["turn_start", "tool_call", "turn_end", "tool_result"],
      ...["turn_start", "tool_call", "runner_native"],
    ]);
  });

  test("a command's duration spans its call and result records, and a replay maps it the same", () => {
    const frames = [init, bash("r1", "pnpm build"), bashResult("r1", clean)];
    const replay = () => {
      const mapper = createMapper({ prices: MODELS });
      return frames.map((f, i) =>
        mapper.map({ ...line(f, i * 1000), ts: TS + i * 1500 }),
      );
    };
    const first = replay();
    // ordinal 2 of the record at offset 2000: raw_offset 2002 on every replay.
    expect(first[2]?.[2]).toMatchObject({
      kind: "command",
      ts: TS + 3000,
      ordinal: 2,
      status: "ok",
      payload: { argv: ["pnpm build"], call_id: "r1", duration_ms: 1500 },
    });
    expect(first[2]?.[2]).not.toHaveProperty("exit_code");
    expect(replay()).toEqual(first);
  });

  test("file changes without a git diff count lines from the patch or the content", () => {
    const list = run(
      init,
      assistant("a1", [
        { type: "tool_use", id: "e1", name: "Edit", input: {} },
        { type: "tool_use", id: "w1", name: "Write", input: {} },
        {
          type: "tool_use",
          id: "n1",
          name: "NotebookEdit",
          input: { notebook_path: "/work/repo/nb.ipynb" },
        },
        { type: "tool_use", id: "f1", name: "Edit", input: {} },
      ]),
      user([{ type: "tool_result", tool_use_id: "e1", content: "ok" }], {
        filePath: "/work/repo/src/a.ts",
        structuredPatch: [{ lines: [" keep", "-old", "+new", "+more"] }],
      }),
      user([{ type: "tool_result", tool_use_id: "w1", content: "ok" }], {
        type: "create",
        filePath: "/elsewhere/b.txt",
        content: "1\n2\n3",
        structuredPatch: [],
      }),
      user([{ type: "tool_result", tool_use_id: "n1", content: "ok" }], {
        new_source: "x",
      }),
      user(
        [
          {
            type: "tool_result",
            tool_use_id: "f1",
            content: "no",
            is_error: true,
          },
        ],
        {
          filePath: "/work/repo/c.ts",
        },
      ),
    );
    expect(
      list.filter((e) => e.kind === "file_change").map((e) => e.payload),
    ).toEqual([
      {
        path: "src/a.ts",
        change: "modify",
        lines_added: 2,
        lines_removed: 1,
        call_id: "e1",
      },
      {
        path: "/elsewhere/b.txt",
        change: "add",
        lines_added: 3,
        lines_removed: 0,
        call_id: "w1",
      },
      { path: "nb.ipynb", change: "modify", call_id: "n1" },
    ]);
  });

  test.each([
    [
      {
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "aborted_streaming",
      },
      "interrupted",
    ],
    [{ subtype: "error_max_turns", is_error: true }, "budget_stop"],
    [{ subtype: "error_max_budget_usd", is_error: true }, "budget_stop"],
    [{ subtype: "error_during_execution", is_error: true }, "failed"],
    [{ subtype: "success", is_error: false }, "ok"],
  ])("result %j ends the run as %s", (extra, outcome) => {
    const list = run(init, result(extra));
    expect(list.at(-1)).toMatchObject({
      kind: "terminal",
      payload: { outcome },
    });
  });

  test("an interrupted run's terminal carries the interrupted class", () => {
    const list = run(
      init,
      result({
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "aborted_tools",
      }),
    );
    expect(list.at(-1)?.payload["error"]).toEqual({
      class: "interrupted",
      message: "the run was interrupted",
      retryable: false,
    });
  });

  test("an error result with no text falls back to its subtype", () => {
    const list = run(
      init,
      result({ subtype: "error_during_execution", is_error: true, errors: [] }),
    );
    expect(list.find((e) => e.kind === "error")?.payload).toEqual({
      class: "runner_error",
      message: "error_during_execution",
      retryable: false,
      runner_error: "error_during_execution",
    });
  });

  test("an estimate for a model with no price row is flagged unpriced", () => {
    const list = run(
      init,
      {
        ...assistant("a1", [{ type: "text", text: "hi" }]),
        message: {
          id: "a1",
          model: "mystery-model",
          content: [{ type: "text", text: "hi" }],
          usage: { input_tokens: 5, output_tokens: 1 },
        },
      },
      result({}),
    );
    expect(list.at(-1)?.payload["spend"]).toEqual(
      expect.objectContaining({
        cost_source: "estimated",
        cost_usd: 0,
        unpriced: true,
        tokens_in: 5,
      }),
    );
  });

  // the complex row spawns `claude-opus-5-5[1m]`; the API echoes the bare id.
  test("an estimate for a `[1m]` row's bare id is priced at that row", () => {
    const list = run(
      init,
      {
        ...assistant("a1", [{ type: "text", text: "hi" }]),
        message: {
          id: "a1",
          model: "claude-opus-5-5",
          content: [{ type: "text", text: "hi" }],
          usage: { input_tokens: 500_000, output_tokens: 100_000 },
        },
      },
      result({}),
    );
    // 0.5 Mtok × $4 + 0.1 Mtok × $20.
    expect(list.at(-1)?.payload["spend"]).toEqual(
      expect.objectContaining({
        cost_source: "estimated",
        cost_usd: 4,
        tokens_in: 500_000,
      }),
    );
    expect(list.at(-1)?.payload["spend"]).not.toHaveProperty("unpriced");
  });

  test("a run with no activity and zero totals is reported as zero spend", () => {
    const list = run(init, result({}));
    expect(list.at(-1)?.payload["spend"]).toEqual({
      tokens_in: 0,
      tokens_out: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      cost_usd: 0,
      cost_source: "reported",
      by_model: {},
    });
  });
});

test("capToRecord collapses a record that would yield more events than it has bytes", () => {
  const bytes = encoder.encode("{}");
  const many = [0, 1, 2].map(() => ({
    kind: "assistant_text" as const,
    ts: TS,
    runner_type: "assistant",
    text: "",
    payload: {},
  }));
  expect(capToRecord(many, bytes, TS)).toEqual([
    {
      kind: "runner_native",
      ts: TS,
      ordinal: 0,
      runner_type: "unparsed",
      payload: { raw: "{}", issues: ["3 events from a 2-byte record"] },
    },
  ]);
  expect(
    capToRecord(many.slice(0, 2), bytes, TS).map((e) => e.ordinal),
  ).toEqual([0, 1]);
});
