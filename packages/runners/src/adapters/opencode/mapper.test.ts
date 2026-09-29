import { readFileSync, readdirSync } from "node:fs";
import { CanonicalEvent, type EventKind } from "@bayon/core";
import { describe, expect, test } from "vitest";
import type { MapInput, MappedEvent } from "../../adapter.js";
import { classify, createOpencodeMapper, tokensOf } from "./mapper.js";
import { MODELS } from "./registration.js";

const DIR = new URL("../../../fixtures/opencode/", import.meta.url);
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

/** A fixture as the raw log holds it: lines at byte offsets. The meta line is not a record. */
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
  const mapper = createOpencodeMapper({ prices: MODELS });
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
const line = (value: unknown, offset = 0): MapInput => ({
  offset,
  bytes: encoder.encode(
    typeof value === "string" ? value : JSON.stringify(value),
  ),
  ts: TS,
});
const mapLines = (values: readonly unknown[]): MappedEvent[] => {
  const mapper = createOpencodeMapper({ prices: MODELS });
  return values.flatMap((v) => mapper.map(line(v)));
};

const SID = "ses_test";
const START = {
  type: "frm.host.start",
  v: 1,
  runner_session_id: SID,
  resumed: false,
  model: "ollama/gemma4:26b",
};
const turn = (n: number, rpc: number, output = false) => ({
  type: "frm.host.turn",
  run_id: `run-${n}`,
  rpc_id: rpc,
  model: "ollama/gemma4:26b",
  output,
});
const update = (u: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: { sessionId: SID, update: u },
});
const result = (id: number, r: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id,
  result: r,
});
const chunk = (messageId: string, text: string) =>
  update({
    sessionUpdate: "agent_message_chunk",
    messageId,
    content: { type: "text", text },
  });

const HEAD = ["session_init", "turn_start"] as const;
const TAIL = ["usage", "turn_end", "terminal"] as const;
const CALL = ["tool_call", "tool_result"] as const;
const SHELL = ["tool_call", "command", "tool_result"] as const;
/** The recorded model's glob-and-think loop (Ollama's 4096 context, spike fact 15). */
const wander = (n: number): EventKind[] =>
  Array.from({ length: n }, () => [...CALL, "reasoning" as const]).flat();
const GOLDEN: Readonly<Record<string, readonly EventKind[]>> = {
  "cancel-then-ok.jsonl": [
    ...HEAD,
    "reasoning",
    "tool_call",
    "assistant_text",
    "command",
    "tool_result",
    "turn_end",
    "terminal",
    "turn_start",
    "reasoning",
    "assistant_text",
    ...TAIL,
  ],
  "crash-no-terminal.jsonl": [...HEAD, "tool_call"],
  "edit-and-bash.jsonl": [
    ...HEAD,
    ...CALL,
    "file_change",
    ...SHELL,
    ...CALL,
    "todo",
    "assistant_text",
    ...TAIL,
  ],
  "mcp-then-deny.jsonl": [
    ...HEAD,
    "mcp_call",
    "reasoning",
    "assistant_text",
    ...TAIL,
    "turn_start",
    ...SHELL,
    "reasoning",
    "assistant_text",
    ...TAIL,
  ],
  "model-not-found.jsonl": ["error"],
  "partial-line.jsonl": [...HEAD, "runner_native"],
  "permission-asked.jsonl": [...HEAD, "error", ...CALL, ...TAIL],
  "plain-turn.jsonl": [...HEAD, "assistant_text", ...TAIL],
  "prompt-error.jsonl": [...HEAD, "error", "terminal"],
  "resume-new-process.jsonl": [...HEAD, "reasoning", "assistant_text", ...TAIL],
  "structured-invalid.jsonl": [
    ...HEAD,
    "assistant_text",
    "turn_end",
    "error",
    "terminal",
  ],
  "structured-review.jsonl": [...HEAD, "assistant_text", ...TAIL],
  "write-and-wander.jsonl": [
    ...HEAD,
    ...CALL,
    "file_change",
    "reasoning",
    ...wander(3),
    "assistant_text",
    ...wander(6),
    "assistant_text",
    ...TAIL,
    "turn_start",
    ...wander(5),
    "assistant_text",
    ...TAIL,
  ],
};

describe("fixtures", () => {
  test("every fixture has a golden sequence, and every golden sequence a fixture", () => {
    expect(Object.keys(GOLDEN).toSorted()).toEqual(FILES);
  });

  test.each(FILES)("%s is marked recorded or hand-authored", (file) => {
    const meta = load(file).meta as Record<string, unknown>;
    expect(meta["type"]).toBe("fixture_meta");
    expect(meta["recorded"] === true || meta["hand_authored"] === true).toBe(
      true,
    );
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
    const mapper = createOpencodeMapper({ prices: MODELS });
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
  test("session_init carries opencode's session id and the model, from the host's start frame", () => {
    const [init] = ofKind(events("plain-turn.jsonl"), "session_init");
    expect(init?.payload).toMatchObject({
      runner_session_id: "ses_f28a6e905ffeYF5qSGkHWVH4Oo",
      model: "ollama/gemma4:26b",
      resumed: false,
    });
    const [resumed] = ofKind(
      events("resume-new-process.jsonl"),
      "session_init",
    );
    expect(resumed?.payload).toMatchObject({ resumed: true });
  });

  test("a reply streamed as chunks is one assistant_text per message", () => {
    const [text] = ofKind(events("plain-turn.jsonl"), "assistant_text");
    expect(text?.text).toBe("OK");
    const evs = mapLines([
      START,
      turn(1, 3),
      chunk("m1", "Hel"),
      chunk("m1", "lo"),
      chunk("m2", "again"),
      result(3, { stopReason: "end_turn" }),
    ]);
    expect(
      ofKind(evs as Mapped[], "assistant_text").map((e) => e.text),
    ).toEqual(["Hello", "again"]);
  });

  test("the run's terminal is opencode's answer to the prompt the turn frame names, and nothing else", () => {
    const evs = mapLines([
      START,
      turn(1, 7),
      result(3, { stopReason: "end_turn" }),
      result(7, { stopReason: "end_turn" }),
      result(7, { stopReason: "end_turn" }),
    ]);
    expect(evs.filter((e) => e.kind === "terminal")).toHaveLength(1);
  });

  test("end_turn bills the reported usage at the model's row price, as reported spend", () => {
    const evs = events("plain-turn.jsonl");
    const [terminal] = ofKind(evs, "terminal");
    expect(terminal?.payload).toMatchObject({
      outcome: "ok",
      spend: {
        tokens_in: 5,
        tokens_out: 6,
        tokens_cache_read: 2046,
        cost_usd: 0,
        cost_source: "reported",
      },
    });
    const [usage] = ofKind(evs, "usage");
    expect(usage?.payload).toMatchObject({ scope: "last_model_call" });
  });

  test("tokensOf keeps reasoning with the output and cache reads apart", () => {
    expect(
      tokensOf({
        inputTokens: 10,
        outputTokens: 5,
        thoughtTokens: 3,
        cachedReadTokens: 7,
        cachedWriteTokens: 2,
      }),
    ).toEqual({
      tokens_in: 10,
      tokens_out: 8,
      tokens_cache_read: 7,
      tokens_cache_write: 2,
    });
  });

  test("cancelled is opencode's own interrupted terminal, with no basis of ours", () => {
    const [terminal] = ofKind(events("cancel-then-ok.jsonl"), "terminal");
    expect(terminal?.payload).toMatchObject({
      outcome: "interrupted",
      error: { class: "interrupted" },
    });
    expect(terminal?.payload).not.toHaveProperty("basis");
  });

  test("a command carries its exit code only when opencode stated one", () => {
    const [aborted] = ofKind(events("cancel-then-ok.jsonl"), "command");
    expect(aborted?.exit_code).toBeUndefined();
    expect(aborted?.payload.argv).toEqual(["sleep 38"]);
    const [ran] = ofKind(events("edit-and-bash.jsonl"), "command");
    expect(ran).toMatchObject({ exit_code: 0, status: "completed" });
  });

  test("a denied command is a failed tool_result the model sees, never an ok one", () => {
    const evs = events("mcp-then-deny.jsonl");
    const [denied] = ofKind(evs, "tool_result");
    expect(denied?.status).toBe("error");
    expect(denied?.text).toContain(
      "prevents you from using this specific tool call",
    );
  });

  test("file tools map to file_change: edit with its line counts, write as add", () => {
    const [edit] = ofKind(events("edit-and-bash.jsonl"), "file_change");
    expect(edit?.payload).toMatchObject({
      path: "/work/repo/add.js",
      change: "modify",
      lines_added: 1,
      lines_removed: 1,
    });
    const [write] = ofKind(events("write-and-wander.jsonl"), "file_change");
    expect(write?.payload).toMatchObject({
      path: "/work/repo/NOTES.md",
      change: "add",
    });
  });

  test("apply_patch maps each file it touched, a move as delete plus add", () => {
    const evs = mapLines([
      START,
      turn(1, 3),
      update({
        sessionUpdate: "tool_call",
        toolCallId: "p1",
        title: "apply_patch",
      }),
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "p1",
        status: "completed",
        rawOutput: {
          output: "ok",
          metadata: {
            files: [
              { filePath: "/r/a", type: "add", additions: 2, deletions: 0 },
              { filePath: "/r/b", type: "update", additions: 1, deletions: 1 },
              { filePath: "/r/c", type: "delete" },
              { filePath: "/r/d", type: "move", movePath: "/r/e" },
            ],
          },
        },
      }),
    ]);
    expect(
      evs.flatMap((e) =>
        e.kind === "file_change"
          ? [`${e.payload.change} ${e.payload.path}`]
          : [],
      ),
    ).toEqual([
      "add /r/a",
      "modify /r/b",
      "delete /r/c",
      "delete /r/d",
      "add /r/e",
    ]);
  });

  test("a todowrite's list is a todo event", () => {
    const [todo] = ofKind(events("edit-and-bash.jsonl"), "todo");
    expect(todo?.payload.items).toEqual([
      { text: "fix add", status: "completed" },
      { text: "run tests", status: "pending" },
    ]);
  });

  test("an MCP call is one mcp_call under its wire name, with no tool_call or tool_result", () => {
    const evs = events("mcp-then-deny.jsonl");
    const [call] = ofKind(evs, "mcp_call");
    expect(call).toMatchObject({
      tool_name: "conformance_echo",
      status: "ok",
      payload: { server: "foreman", outcome: "ok" },
    });
    expect(call?.payload.args_digest).toMatch(/^[0-9a-f]{64}$/);
    const firstRun = evs.slice(
      0,
      evs.findIndex((e) => e.kind === "terminal"),
    );
    expect(firstRun.some((e) => e.kind === "tool_call")).toBe(false);
  });

  test("a tool is announced when it starts running, with its input (conformance tests 7 and 8)", () => {
    const evs = mapLines([
      START,
      turn(1, 3),
      update({
        sessionUpdate: "tool_call",
        toolCallId: "c1",
        title: "bash",
        rawInput: {},
      }),
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        status: "in_progress",
        title: "sleep 30",
        rawInput: { command: "sleep 30" },
      }),
    ]);
    expect(evs.at(-1)).toMatchObject({
      kind: "tool_call",
      tool_name: "bash",
      payload: { call_id: "c1", input: { command: "sleep 30" } },
    });
  });

  test("a prompt error is error + terminal{failed}, classified from what opencode said", () => {
    const evs = events("prompt-error.jsonl");
    const [terminal] = ofKind(evs, "terminal");
    expect(terminal?.payload).toMatchObject({
      outcome: "failed",
      error: {
        class: "runner_error",
        retryable: true,
        cause: { kind: "connection", error_name: "APIError" },
      },
    });
  });

  test("classify reads opencode's error name first, then the message; never an exit code", () => {
    expect(classify("x", "ContextOverflowError").cause).toEqual({
      kind: "context_window",
      error_name: "ContextOverflowError",
    });
    expect(classify("HTTP 429 Too Many Requests")).toMatchObject({
      retryable: true,
      cause: { kind: "rate_limit" },
    });
    expect(classify("something odd")).toEqual({
      class: "runner_error",
      message: "something odd",
      retryable: false,
    });
  });

  test("a structured answer the host refused fails the run; one it wrote passes", () => {
    const [bad] = ofKind(events("structured-invalid.jsonl"), "terminal");
    expect(bad?.payload).toMatchObject({
      outcome: "failed",
      error: { cause: { kind: "structured_output" } },
    });
    expect(String(bad?.payload.error?.message)).toContain(
      "the answer is not JSON",
    );
    const [good] = ofKind(events("structured-review.jsonl"), "terminal");
    expect(good?.payload.outcome).toBe("ok");
  });

  test("a run that expected output and got no check at all fails too", () => {
    const evs = mapLines([
      START,
      turn(1, 3, true),
      result(3, { stopReason: "end_turn" }),
    ]);
    expect(evs.at(-1)).toMatchObject({
      kind: "terminal",
      payload: { outcome: "failed" },
    });
  });

  test("other stop reasons fail the run with the reason as its cause", () => {
    const evs = mapLines([
      START,
      turn(1, 3),
      result(3, { stopReason: "max_tokens" }),
    ]);
    expect(evs.at(-1)).toMatchObject({
      kind: "terminal",
      payload: { outcome: "failed", error: { cause: { kind: "max_tokens" } } },
    });
  });

  test("opencode exiting mid-run writes no terminal (Invariant 3); buffered text is kept", () => {
    const evs = mapLines([
      START,
      turn(1, 3),
      chunk("m1", "partial"),
      { type: "frm.host.exit", code: null, signal: "SIGKILL" },
    ]);
    expect(evs.map((e) => e.kind)).toEqual([
      "session_init",
      "turn_start",
      "assistant_text",
    ]);
  });

  test("unknown updates, methods and records are stored as runner_native, never dropped (Invariant 4)", () => {
    const evs = mapLines([
      START,
      turn(1, 3),
      update({ sessionUpdate: "frm_unknown", x: 1 }),
      { jsonrpc: "2.0", method: "frm/unknown", params: {} },
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "t",
        status: "exploded",
      }),
      { type: "frm.conformance.unknown" },
      "not json",
      [1, 2],
      { jsonrpc: "2.0", id: 9, method: "fs/read_text_file", params: {} },
    ]);
    expect(evs.slice(2).map((e) => [e.kind, e.runner_type])).toEqual([
      ["runner_native", "session/update:frm_unknown"],
      ["runner_native", "frm/unknown"],
      ["runner_native", "session/update:tool_call_update"],
      ["runner_native", "frm.conformance.unknown"],
      ["runner_native", "unparsed"],
      ["runner_native", "unparsed"],
      ["runner_native", "fs/read_text_file"],
    ]);
  });

  test("known updates with nothing canonical in them map to nothing", () => {
    const evs = mapLines([
      START,
      update({
        sessionUpdate: "available_commands_update",
        availableCommands: [],
      }),
      update({ sessionUpdate: "usage_update", used: 1, size: 2 }),
    ]);
    expect(evs.map((e) => e.kind)).toEqual(["session_init"]);
  });

  test("a host frame that fails its shape is runner_native with its issues", () => {
    const [bad] = mapLines([{ type: "frm.host.turn", run_id: "" }]);
    expect(bad).toMatchObject({
      kind: "runner_native",
      runner_type: "frm.host.turn",
    });
    const issues = bad?.kind === "runner_native" ? bad.payload.issues : [];
    expect(issues?.length).toBeGreaterThan(0);
  });
});
