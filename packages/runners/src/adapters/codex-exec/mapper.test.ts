import { readFileSync, readdirSync } from "node:fs";
import { CanonicalEvent, type EventKind } from "@bayon/core";
import { describe, expect, test } from "vitest";
import type { MapInput, MappedEvent } from "../../adapter.js";
import { isInterruptExit } from "../../conformance/tests/define.js";
import {
  classify,
  createCodexMapper,
  tokensOf,
  type UsageScope,
} from "./mapper.js";
import { MODELS } from "./registration.js";

const DIR = new URL("../../../fixtures/codex-exec/", import.meta.url);
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

/** A fixture as the raw log holds it: lines at byte offsets. The marker line is not a record. */
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

function mapAll(
  records: readonly MapInput[],
  usageScope?: UsageScope,
): Mapped[][] {
  const mapper = createCodexMapper({
    prices: MODELS,
    ...(usageScope === undefined ? {} : { usageScope }),
  });
  return records.map((r) =>
    mapper
      .map(r)
      .map((e) => ({ ...e, raw_offset: r.offset + e.ordinal }) as Mapped),
  );
}

const events = (name: string, scope?: UsageScope): Mapped[] =>
  mapAll(load(name).records, scope).flat();
const kinds = (list: readonly Mapped[]): string[] => list.map((e) => e.kind);
const ofKind = <K extends EventKind>(list: readonly Mapped[], kind: K) =>
  list.filter((e): e is Of<K> => e.kind === kind);
const line = (value: unknown, offset = 0): MapInput => ({
  offset,
  bytes: encoder.encode(
    typeof value === "string" ? value : JSON.stringify(value),
  ),
  ts: TS,
});
const mapLines = (values: readonly unknown[]): MappedEvent[] => {
  const mapper = createCodexMapper({ prices: MODELS });
  return values.flatMap((v) => mapper.map(line(v)));
};

const START = {
  type: "frm.host.start",
  v: 1,
  runner_session_id: "rsid-1",
  thread_id: null,
  usage_total: null,
};
const TURN = {
  type: "frm.host.turn",
  run_id: "run-1",
  model: "gpt-5.6-luna",
  resume: false,
  argv: ["codex", "exec", "--json", "-"],
};
const USAGE = {
  input_tokens: 100,
  cached_input_tokens: 40,
  cache_write_input_tokens: 10,
  output_tokens: 5,
  reasoning_output_tokens: 1,
};

const TAIL = ["assistant_text", "usage", "turn_end", "terminal"] as const;
const HEAD = ["turn_start", "session_init"] as const;
const SHELL = ["tool_call", "command", "tool_result"] as const;
const GOLDEN: Readonly<Record<string, readonly EventKind[]>> = {
  "crash-no-terminal.jsonl": [...HEAD, "tool_call"],
  "file-change.jsonl": [
    ...HEAD,
    "file_change",
    "file_change",
    "file_change",
    "error",
    ...TAIL,
  ],
  "interrupted.jsonl": [...HEAD, "tool_call", "terminal"],
  "mcp-call.jsonl": [...HEAD, "mcp_call", "mcp_call", ...TAIL],
  "partial-line.jsonl": [...HEAD, "runner_native"],
  "plain-turn.jsonl": [...HEAD, "reasoning", ...TAIL],
  "resume-two-turns.jsonl": [...HEAD, ...TAIL, ...HEAD, ...TAIL],
  "review-hang.jsonl": [...HEAD, "reasoning", "error"],
  "shell-commands.jsonl": [...HEAD, ...SHELL, ...SHELL, ...SHELL, ...TAIL],
  "structured-review.jsonl": [...HEAD, ...TAIL],
  "todo-plan.jsonl": [...HEAD, "todo", "todo", "todo", ...TAIL],
  "turn-failed-usage-limit.jsonl": [...HEAD, "error", "error", "terminal"],
  "unknown-items.jsonl": [
    ...HEAD,
    ...Array.from({ length: 6 }, () => "runner_native" as const),
    ...TAIL,
  ],
};

describe("fixtures", () => {
  test("every fixture has a golden sequence, and every golden sequence a fixture", () => {
    expect(Object.keys(GOLDEN).toSorted()).toEqual(FILES);
  });

  test.each(FILES)("%s is marked hand-authored", (file) => {
    expect(load(file).meta).toMatchObject({
      type: "fixture_meta",
      hand_authored: true,
    });
  });

  test.each(FILES)("%s maps to its golden kind sequence", (file) => {
    expect(kinds(events(file))).toEqual(GOLDEN[file]);
  });

  test.each(FILES)("%s: every event is canonical", (file) => {
    for (const e of events(file)) {
      expect(CanonicalEvent.safeParse(e).success).toBe(true);
    }
  });
});

describe.each(FILES)("%s obeys the mapper laws", (file) => {
  const { records } = load(file);
  const perRecord = mapAll(records);

  test("L1: ordinals run 0..n-1 below the record length, so raw offsets never collide", () => {
    perRecord.forEach((evs, i) => {
      expect(evs.map((e) => e.ordinal)).toEqual(evs.map((_, j) => j));
      expect(evs.length).toBeLessThanOrEqual(records[i]?.bytes.length ?? 0);
    });
    const offsets = perRecord.flat().map((e) => e.raw_offset);
    expect(new Set(offsets).size).toBe(offsets.length);
  });

  test("L2: two fresh mappers over the same bytes and ts give the same events", () => {
    expect(mapAll(records)).toEqual(perRecord);
  });

  test("L3: no prefix of any record makes the mapper throw", () => {
    const mapper = createCodexMapper({ prices: MODELS });
    for (const r of records) {
      for (let n = 0; n <= r.bytes.length; n += 7) {
        expect(() =>
          mapper.map({ ...r, bytes: r.bytes.subarray(0, n) }),
        ).not.toThrow();
      }
    }
  });

  test("L4: at most one terminal per record, and it is the record's last event", () => {
    for (const evs of perRecord) {
      const at = evs.findIndex((e) => e.kind === "terminal");
      expect(evs.filter((e) => e.kind === "terminal").length).toBeLessThan(2);
      if (at !== -1) expect(at).toBe(evs.length - 1);
    }
  });

  test("L5: at most one runner terminal per host turn", () => {
    let terminals = 0;
    for (const evs of perRecord) {
      for (const e of evs) {
        if (e.kind === "turn_start") terminals = 0;
        if (e.kind === "terminal") terminals += 1;
        expect(terminals).toBeLessThan(2);
      }
    }
  });
});

describe("payloads", () => {
  test("session_init carries our runner session id and Codex's thread id apart (design Q3)", () => {
    const [init] = ofKind(events("plain-turn.jsonl"), "session_init");
    expect(init?.payload).toMatchObject({
      runner_session_id: "rsid-1",
      thread_id: "0199a0b1-0000-7000-8000-000000000001",
      model: "gpt-5.6-luna",
    });
  });

  test("frm.host.turn opens the run; Codex's turn.started maps to nothing", () => {
    const evs = mapLines([START, TURN, { type: "turn.started" }]);
    expect(evs.map((e) => e.kind)).toEqual(["turn_start"]);
    expect(evs[0]?.payload).toMatchObject({
      model: "gpt-5.6-luna",
      resume: false,
    });
  });

  test("a command's exit code is carried only when Codex stated one", () => {
    const evs = events("shell-commands.jsonl");
    const commands = ofKind(evs, "command");
    expect(commands.map((c) => [c.status, c.exit_code])).toEqual([
      ["completed", 0],
      ["failed", 1],
      ["declined", undefined],
    ]);
    expect(commands.every((c) => !("exit_code" in c) || c.exit_code !== null));
    expect("exit_code" in (commands[2] ?? {})).toBe(false);
    expect(commands.map((c) => c.payload.argv)).toEqual([
      ["/bin/zsh -lc ls"],
      ["/bin/zsh -lc false"],
      ["/bin/zsh -lc 'rm -rf build'"],
    ]);
  });

  test("tool calls and results pair one-to-one, a declined command included", () => {
    const evs = events("shell-commands.jsonl");
    const calls = ofKind(evs, "tool_call").map((e) => e.payload.call_id);
    const results = ofKind(evs, "tool_result");
    expect(results.map((e) => e.payload.call_id)).toEqual(calls);
    expect(results.map((e) => e.status)).toEqual(["ok", "error", "error"]);
    expect(ofKind(evs, "tool_call").every((e) => e.tool_name === "shell")).toBe(
      true,
    );
  });

  test("file changes: update is modify, a failed patch is a warning", () => {
    const evs = events("file-change.jsonl");
    expect(
      ofKind(evs, "file_change").map((e) => [e.payload.path, e.payload.change]),
    ).toEqual([
      ["/work/NOTES.md", "add"],
      ["/work/add.js", "modify"],
      ["/work/gone.txt", "delete"],
    ]);
    const [warning] = ofKind(evs, "error");
    expect(warning).toMatchObject({
      status: "warning",
      payload: { class: "runner_error", message: "patch failed: /etc/hosts" },
    });
  });

  test("an MCP call is one mcp_call with its outcome and no unpaired tool_result", () => {
    const evs = events("mcp-call.jsonl");
    const calls = ofKind(evs, "mcp_call");
    expect(
      calls.map((c) => [c.tool_name, c.status, c.payload["outcome"]]),
    ).toEqual([
      ["ticket_read", "ok", "ok"],
      ["ticket_write", "error", "failed"],
    ]);
    expect(calls[0]?.payload).toMatchObject({
      server: "foreman",
      call_id: "item_1",
    });
    expect(calls[0]?.payload.args_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(ofKind(evs, "tool_result")).toEqual([]);
  });

  test("a failed MCP call keeps Codex's reason as its text; a completed one carries none", () => {
    const [done, failed] = ofKind(events("mcp-call.jsonl"), "mcp_call");
    expect(done?.text).toBeUndefined();
    expect(failed?.text).toBe("tool not allowed for this role");
    // Codex refuses an unapproved call itself (0.154.0): the reason is the only trace it leaves.
    const [refused] = mapLines([
      {
        type: "item.completed",
        item: {
          id: "item_9",
          type: "mcp_tool_call",
          server: "foreman",
          tool: "conformance_echo",
          arguments: { nonce: "n" },
          result: null,
          error: {
            message:
              "MCP tool call requires approval, but approval policy is never",
          },
          status: "failed",
        },
      },
    ]).filter((e) => e.kind === "mcp_call");
    expect(refused).toMatchObject({
      kind: "mcp_call",
      status: "error",
      text: "MCP tool call requires approval, but approval policy is never",
      payload: { outcome: "failed" },
    });
  });

  test("a to-do list maps its completed flags to statuses", () => {
    const todos = ofKind(events("todo-plan.jsonl"), "todo");
    expect(todos.map((t) => t.payload.items.map((i) => i.status))).toEqual([
      ["pending", "pending"],
      ["completed", "pending"],
      ["completed", "completed"],
    ]);
  });

  test("a completed turn bills its tokens, cached input apart, as reported spend", () => {
    const evs = events("plain-turn.jsonl");
    const [terminal] = ofKind(evs, "terminal");
    expect(terminal?.payload.outcome).toBe("ok");
    expect(terminal?.payload.usage).toEqual({
      tokens_in: 200,
      tokens_out: 20,
      tokens_cache_read: 1000,
      tokens_cache_write: 0,
    });
    expect(terminal?.payload["spend"]).toMatchObject({
      cost_source: "reported",
      model: "gpt-5.6-luna",
    });
    expect(terminal?.payload.cost_usd).toBeGreaterThan(0);
  });

  test("resumed turns bill the growth of the thread's totals from the host's baseline", () => {
    const terminals = ofKind(events("resume-two-turns.jsonl"), "terminal");
    expect(terminals.map((t) => t.payload.usage)).toEqual([
      {
        tokens_in: 100,
        tokens_out: 20,
        tokens_cache_read: 1100,
        tokens_cache_write: 0,
      },
      {
        tokens_in: 200,
        tokens_out: 25,
        tokens_cache_read: 1100,
        tokens_cache_write: 0,
      },
    ]);
    const inits = ofKind(events("resume-two-turns.jsonl"), "session_init");
    expect(new Set(inits.map((i) => i.payload.runner_session_id))).toEqual(
      new Set(["rsid-1"]),
    );
  });

  test("usage scope 'process' bills each turn's totals whole", () => {
    const terminals = ofKind(
      events("resume-two-turns.jsonl", "process"),
      "terminal",
    );
    expect(terminals.map((t) => t.payload.usage?.tokens_in)).toEqual([
      300, 500,
    ]);
  });

  test("a decrease in the thread's totals restarts the baseline instead of billing negative", () => {
    const evs = mapLines([
      { ...START, usage_total: { ...USAGE, input_tokens: 9_000 } },
      TURN,
      { type: "turn.completed", usage: USAGE },
    ]);
    const terminal = evs.find((e) => e.kind === "terminal");
    expect(terminal?.kind === "terminal" && terminal.payload.usage).toEqual(
      tokensOf(USAGE),
    );
  });

  test("tokensOf keeps cached and cache-written input apart, clamped at zero", () => {
    expect(tokensOf(USAGE)).toEqual({
      tokens_in: 50,
      tokens_out: 5,
      tokens_cache_read: 40,
      tokens_cache_write: 10,
    });
    expect(
      tokensOf({ ...USAGE, input_tokens: 10, cache_write_input_tokens: 30 })
        .tokens_in,
    ).toBe(0);
  });

  test("a failed turn is classified from its message, never an exit code, and bills nothing", () => {
    const evs = events("turn-failed-usage-limit.jsonl");
    const [terminal] = ofKind(evs, "terminal");
    expect(terminal?.payload).toMatchObject({
      outcome: "failed",
      error: {
        class: "runner_error",
        retryable: false,
        cause: { kind: "usage_limit" },
      },
    });
    expect(terminal?.payload.usage).toBeUndefined();
    const [streamError] = ofKind(evs, "error");
    expect(streamError?.payload.retryable).toBe(false);
  });

  test.each([
    ["Rate limit reached for requests (429)", "rate_limit", true],
    ["context window exceeded", "context_window", false],
    ["401 Unauthorized", "auth", false],
    ["sandbox denied the write", "sandbox", false],
    ["503 Service Unavailable", "server", true],
  ] as const)("classify(%j) → %s", (message, kind, retryable) => {
    expect(classify(message)).toEqual({
      class: "runner_error",
      message,
      retryable,
      cause: { kind },
    });
  });

  test("an unrecognised failure is a plain runner_error, not retryable", () => {
    expect(classify("something odd")).toEqual({
      class: "runner_error",
      message: "something odd",
      retryable: false,
    });
  });

  test("the interrupt terminal carries its basis, and the conformance suite recognises it", () => {
    const [terminal] = ofKind(events("interrupted.jsonl"), "terminal");
    expect(terminal?.payload).toMatchObject({
      outcome: "interrupted",
      basis: "interrupt+exit",
      error: { class: "interrupted" },
    });
    expect(terminal?.runner_type).toBe("frm.host.exit");
    if (terminal === undefined) throw new Error("no terminal");
    expect(isInterruptExit({ ...terminal, source: "runner", seq: 0 })).toBe(
      true,
    );
  });

  test("no terminal without our own interrupt, for another run, or after the runner's own", () => {
    const exit = {
      type: "frm.host.exit",
      run_id: "run-1",
      code: 1,
      signal: null,
    };
    const interrupt = { type: "frm.host.interrupt", run_id: "run-1" };
    const terminalsOf = (values: readonly unknown[]) =>
      mapLines(values).filter((e) => e.kind === "terminal");
    expect(terminalsOf([START, TURN, exit])).toEqual([]);
    expect(
      terminalsOf([
        START,
        TURN,
        { type: "frm.host.interrupt", run_id: "run-0" },
        exit,
      ]),
    ).toEqual([]);
    expect(
      terminalsOf([
        START,
        TURN,
        interrupt,
        { type: "turn.completed", usage: USAGE },
        exit,
      ]).map((e) => e.kind === "terminal" && e.payload.outcome),
    ).toEqual(["ok"]);
    expect(
      terminalsOf([START, TURN, interrupt]).map(
        (e) => e.kind === "terminal" && e.payload.outcome,
      ),
    ).toEqual([]);
  });

  test("the review hang and a crash map to no terminal: only the wall clock ends them", () => {
    expect(ofKind(events("review-hang.jsonl"), "terminal")).toEqual([]);
    expect(ofKind(events("crash-no-terminal.jsonl"), "terminal")).toEqual([]);
  });

  test("zod runs first: a known item that fails its frame is stored, even where valid ones map to nothing", () => {
    const natives = ofKind(events("unknown-items.jsonl"), "runner_native");
    expect(natives.map((n) => n.runner_type)).toEqual([
      "item.started",
      "item.completed",
      "item.completed",
      "item.updated",
      "thread.renamed",
      "frm.host.unknown",
    ]);
    expect(natives[2]?.payload.issues?.join(" ")).toContain("status");
    expect(natives[3]?.payload.issues?.join(" ")).toContain("text");
    expect(JSON.stringify(natives[1]?.payload.raw)).toContain("n-invented");
  });

  test("an invalid host frame is stored, and leaves the mapper's state alone", () => {
    const evs = mapLines([
      { ...START, v: 2 },
      { ...TURN, argv: [] },
      { type: "frm.host.interrupt" },
      { type: "frm.host.exit", run_id: "run-1" },
    ]);
    expect(evs.map((e) => e.kind)).toEqual([
      "runner_native",
      "runner_native",
      "runner_native",
      "runner_native",
    ]);
  });

  test("lines that are not JSON objects, or were cut off, are stored as unparsed", () => {
    const mapper = createCodexMapper({ prices: MODELS });
    for (const text of ["not json", "[1,2]", "42"]) {
      expect(mapper.map(line(text))).toMatchObject([
        { kind: "runner_native", runner_type: "unparsed" },
      ]);
    }
    expect(
      mapper.map({ ...line('{"type":"turn.sta'), partial: true }),
    ).toMatchObject([
      {
        kind: "runner_native",
        payload: { parse_error: "partial line" },
      },
    ]);
    expect(mapper.map(line(""))).toEqual([]);
  });

  test("a line with no type is stored as runner_native", () => {
    expect(mapLines([{ nonce: "x" }])).toMatchObject([
      { kind: "runner_native" },
    ]);
  });

  test("web searches pair a call with its result", () => {
    const search = (type: string) => ({
      type,
      item: { id: "ws_1", type: "web_search", query: "codex" },
    });
    const evs = mapLines([
      START,
      TURN,
      search("item.started"),
      search("item.updated"),
      search("item.completed"),
    ]);
    expect(evs.map((e) => e.kind)).toEqual([
      "turn_start",
      "tool_call",
      "tool_result",
    ]);
  });
});
