// The pure mapper from the turn host's stdout to canonical events (§5.2):
// opencode's ACP JSON-RPC lines plus the host's five frames. Every record is zod-parsed against its
// frame first; state is replaced, never edited, and depends only on the records seen, so the same
// records with the same `ts` give the same events (L2). It never throws (L3). A run ends only on
// the runner's own answer to its `session/prompt` (Invariant 3).
import { createHash } from "node:crypto";
import {
  UNKNOWN_RUNNER_TYPE,
  canonicalJson,
  parseCanonical,
  type CanonicalEvent,
  type ContextTotals,
  type FrmError,
  type JsonValue,
  type Usage,
} from "@bayon/core";
import type { MapInput, Mapper, ModelRow } from "../../adapter.js";
import { CONTEXT_FRAME_TYPE, foldContextRecord } from "../../context-frames.js";
import { UNPARSED, capToRecord } from "../../record-events.js";
import { price, reported, SPEND_START, type Spend } from "../../spend.js";
import {
  AgentRequest,
  BashOutput,
  ChunkUpdate,
  EditOutput,
  ErrorOutput,
  HOST_FRAMES,
  HOST_INTERRUPT,
  HOST_OUTPUT,
  HOST_START,
  HOST_TURN,
  HostExit,
  HostInterrupt,
  HostOutput,
  HostStart,
  HostTurn,
  Notification,
  PatchOutput,
  PlanUpdate,
  PromptErrorData,
  PromptResult,
  QUIET_UPDATES,
  ErrorResponse,
  ResultResponse,
  SessionUpdate,
  TextOutput,
  TodoOutput,
  ToolCall,
  ToolCallUpdate,
  WriteOutput,
  type PromptUsage,
} from "./frames.js";
import {
  FILE_TOOLS,
  MCP_SERVER,
  SHELL_TOOL,
  TODO_TOOL,
  mcpWireName,
} from "./tool-names.js";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
/** An event before it is stamped with the record's `ts` and validated. */
type Draft = DistributiveOmit<CanonicalEvent, "ts">;

/** A tool call this process has seen, by its id. */
type Call = {
  readonly tool: string;
  readonly input: unknown;
  /** The `ts` of its first record, for a command's duration. */
  readonly since: number;
  /** Its `tool_call` event is out (MCP calls never get one: they map to one `mcp_call`). */
  readonly announced: boolean;
};

/** Text streamed as chunks, held until its message ends. */
type Buffered = {
  readonly kind: "assistant_text" | "reasoning";
  readonly messageId: string;
  readonly text: string;
};

type Run = {
  readonly runId: string;
  readonly rpcId: number | string;
  readonly output: boolean;
  /** The host's structured-output verdict (design §6), once written. */
  readonly checked?: {
    readonly ok: boolean;
    readonly issues: readonly string[];
  };
  /** This run already has its terminal. */
  readonly ended: boolean;
};

type State = {
  readonly model?: string;
  readonly run?: Run;
  readonly calls: ReadonlyMap<string, Call>;
  readonly buffer?: Buffered;
  /** This run's context proxy frames, folded (spec M12): the terminal carries them. */
  readonly context?: ContextTotals;
};
type Stepped = { readonly state: State; readonly drafts: readonly Draft[] };

const START: State = { calls: new Map() };
const decoder = new TextDecoder();

/** `{ key: value }`, or `{}` when the value is absent: optional fields are absent, never null. */
const opt = <K extends string, V>(
  key: K,
  value: V | null | undefined,
): { [P in K]?: V } =>
  (value === undefined || value === null ? {} : { [key]: value }) as {
    [P in K]?: V;
  };

const issuesOf = (error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}): string[] =>
  error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`);

const native = (
  runnerType: string,
  raw: unknown,
  extra: Readonly<Record<string, unknown>> = {},
): Draft => ({
  kind: "runner_native",
  runner_type: runnerType,
  payload: { raw, ...extra },
});

const invalid = (
  type: string,
  raw: unknown,
  error: Parameters<typeof issuesOf>[0],
): Draft => native(type, raw, { issues: issuesOf(error) });

const same = (state: State, ...drafts: Draft[]): Stepped => ({ state, drafts });

const warning = (type: string, message: string): Draft => ({
  kind: "error",
  runner_type: type,
  status: "warning",
  payload: { class: "runner_error", message, retryable: false },
});

/** The buffered message as its one event, and the state without it. */
function flush(state: State): Stepped {
  const b = state.buffer;
  if (b === undefined) return same(state);
  const rest: State = {
    calls: state.calls,
    ...opt("model", state.model),
    ...opt("run", state.run),
    ...opt("context", state.context),
  };
  return same(rest, {
    kind: b.kind,
    runner_type: `session/update:${b.kind === "assistant_text" ? "agent_message_chunk" : "agent_thought_chunk"}`,
    text: b.text,
    payload:
      b.kind === "reasoning"
        ? { summary_only: false, message_id: b.messageId }
        : { message_id: b.messageId },
  } as Draft);
}

/** `then` after flushing: the flushed text first, in stream order. */
function flushed(state: State, then: (s: State) => Stepped): Stepped {
  const f = flush(state);
  const next = then(f.state);
  return same(next.state, ...f.drafts, ...next.drafts);
}

// --- spend -----------------------------------------------------------------------------------------

/** ACP's usage (the turn's last model call, design §8) in the `spend` columns. */
export function tokensOf(u: PromptUsage): Usage {
  return {
    tokens_in: u.inputTokens,
    tokens_out: u.outputTokens + (u.thoughtTokens ?? 0),
    tokens_cache_read: u.cachedReadTokens ?? 0,
    tokens_cache_write: u.cachedWriteTokens ?? 0,
  };
}

function bill(
  model: string,
  usage: PromptUsage | undefined,
  prices: readonly ModelRow[],
): Spend {
  const totals = price(
    prices,
    model,
    tokensOf(usage ?? { inputTokens: 0, outputTokens: 0 }),
  ).totals;
  return reported(SPEND_START, { [model]: totals }).spend;
}

const usageOf = (s: Spend): Usage => ({
  tokens_in: s.tokens_in,
  tokens_out: s.tokens_out,
  tokens_cache_read: s.tokens_cache_read,
  tokens_cache_write: s.tokens_cache_write,
});

// --- failures --------------------------------------------------------------------------------------

const BY_NAME: Readonly<Record<string, { kind: string; retryable: boolean }>> =
  {
    ProviderAuthError: { kind: "auth", retryable: false },
    ContextOverflowError: { kind: "context_window", retryable: false },
    MessageOutputLengthError: { kind: "max_tokens", retryable: false },
    ContentFilterError: { kind: "refusal", retryable: false },
    StructuredOutputError: { kind: "structured_output", retryable: false },
    MessageAbortedError: { kind: "aborted", retryable: true },
  };

const PATTERNS: readonly {
  readonly kind: string;
  readonly retryable: boolean;
  readonly test: RegExp;
}[] = [
  {
    kind: "rate_limit",
    retryable: true,
    test: /rate.?limit|\b429\b|too many requests/i,
  },
  {
    kind: "auth",
    retryable: false,
    test: /\b401\b|unauthori[sz]ed|authenticat|api key/i,
  },
  {
    kind: "connection",
    retryable: true,
    test: /cannot connect|unable to connect|econnrefused|fetch failed|timed? ?out/i,
  },
  {
    kind: "server",
    retryable: true,
    test: /\b5\d\d\b|overloaded|server error/i,
  },
];

/** A failed turn's class from what opencode said, never from an exit code. */
export function classify(message: string, errorName?: string): FrmError {
  const named = errorName === undefined ? undefined : BY_NAME[errorName];
  const hit = named ?? PATTERNS.find((p) => p.test.test(message));
  return {
    class: "runner_error",
    message,
    retryable: hit?.retryable ?? false,
    ...opt(
      "cause",
      hit === undefined && errorName === undefined
        ? undefined
        : { ...opt("kind", hit?.kind), ...opt("error_name", errorName) },
    ),
  };
}

// --- tools -----------------------------------------------------------------------------------------

function argsDigest(input: unknown): string {
  return createHash("sha256")
    .update(canonicalJson((input ?? null) as JsonValue))
    .digest("hex");
}

const record = (v: unknown): Readonly<Record<string, unknown>> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

/** The text a finished tool reports: its output, or its error. */
function resultText(
  update: { rawOutput?: unknown },
  failed: boolean,
): string | undefined {
  const raw = update.rawOutput;
  if (failed) {
    const e = ErrorOutput.safeParse(raw);
    if (e.success) return e.data.error;
  }
  const t = TextOutput.safeParse(raw);
  return t.success && t.data.output !== "" ? t.data.output : undefined;
}

/** The `file_change` events a finished file tool reports (design §7 (c)). */
function fileChanges(
  type: string,
  tool: string,
  callId: string,
  raw: unknown,
): Draft[] {
  const change = (
    path: string,
    kind: "add" | "modify" | "delete",
    counts?: { added?: number; removed?: number },
  ): Draft => ({
    kind: "file_change",
    runner_type: type,
    payload: {
      path,
      change: kind,
      call_id: callId,
      ...opt("lines_added", counts?.added),
      ...opt("lines_removed", counts?.removed),
    },
  });
  if (tool === FILE_TOOLS.write) {
    const w = WriteOutput.safeParse(raw);
    return w.success
      ? [
          change(
            w.data.metadata.filepath,
            w.data.metadata.exists ? "modify" : "add",
          ),
        ]
      : [];
  }
  if (tool === FILE_TOOLS.edit) {
    const e = EditOutput.safeParse(raw);
    if (!e.success) return [];
    const d = e.data.metadata.filediff;
    return [
      change(d.file, "modify", { added: d.additions, removed: d.deletions }),
    ];
  }
  if (tool === FILE_TOOLS.patch) {
    const p = PatchOutput.safeParse(raw);
    if (!p.success) return [];
    return p.data.metadata.files.flatMap((f) => {
      const counts = { added: f.additions, removed: f.deletions };
      if (f.type === "add") return [change(f.filePath, "add", counts)];
      if (f.type === "delete") return [change(f.filePath, "delete", counts)];
      if (f.type === "move" && f.movePath !== undefined) {
        return [
          change(f.filePath, "delete"),
          change(f.movePath, "add", counts),
        ];
      }
      return [change(f.filePath, "modify", counts)];
    });
  }
  return [];
}

/** A finished todowrite's list, as a `todo` event. */
function todos(type: string, raw: unknown): Draft[] {
  const t = TodoOutput.safeParse(raw);
  if (!t.success) return [];
  return [
    {
      kind: "todo",
      runner_type: type,
      payload: {
        items: t.data.metadata.todos.map((i) => ({
          text: i.content,
          status: i.status === "cancelled" ? "completed" : i.status,
        })),
      },
    },
  ];
}

const announce = (type: string, callId: string, call: Call): Draft => ({
  kind: "tool_call",
  runner_type: type,
  tool_name: call.tool,
  payload: { call_id: callId, ...opt("input", call.input) },
});

function onToolCall(
  state: State,
  type: string,
  update: unknown,
  ts: number,
): Stepped {
  const f = ToolCall.safeParse(update);
  if (!f.success) return same(state, invalid(type, update, f.error));
  const known = state.calls.get(f.data.toolCallId);
  if (known !== undefined) return same(state);
  const call: Call = {
    tool: f.data.title,
    input: undefined,
    since: ts,
    announced: false,
  };
  return same({
    ...state,
    calls: new Map([...state.calls, [f.data.toolCallId, call]]),
  });
}

function onToolUpdate(
  state: State,
  type: string,
  update: unknown,
  ts: number,
): Stepped {
  const f = ToolCallUpdate.safeParse(update);
  if (!f.success) return same(state, invalid(type, update, f.error));
  const u = f.data;
  const id = u.toolCallId;
  const seen = state.calls.get(id);
  // An update for a call this process never saw announced (it predates a resume): its title is
  // the best name there is.
  const base: Call = seen ?? {
    tool: u.title ?? UNKNOWN_RUNNER_TYPE,
    input: undefined,
    since: ts,
    announced: false,
  };
  const call: Call =
    u.rawInput === undefined ? base : { ...base, input: u.rawInput };
  const wire = mcpWireName(call.tool);
  if (u.status !== "completed" && u.status !== "failed") {
    // Running (or a refresh): the call is visible from here, with its input (tests 7, 8).
    const announced = wire === undefined && !call.announced;
    const next: Call = { ...call, announced: call.announced || announced };
    return same(
      { ...state, calls: new Map([...state.calls, [id, next]]) },
      ...(announced ? [announce(type, id, next)] : []),
    );
  }
  const calls = new Map(state.calls);
  calls.delete(id);
  const failed = u.status === "failed";
  const text = resultText(u, failed);
  if (wire !== undefined) {
    // One event with its outcome and no tool_result, so tool_call/tool_result pairs stay paired.
    return same(
      { ...state, calls },
      {
        kind: "mcp_call",
        runner_type: type,
        tool_name: wire,
        status: failed ? "error" : "ok",
        ...opt("text", text),
        payload: {
          server: MCP_SERVER,
          call_id: id,
          args_digest: argsDigest(call.input),
          outcome: failed ? "failed" : "ok",
        },
      },
    );
  }
  const drafts: Draft[] = call.announced ? [] : [announce(type, id, call)];
  if (call.tool === SHELL_TOOL) {
    const command = record(call.input)["command"];
    const bash = BashOutput.safeParse(u.rawOutput);
    const exit = bash.success ? bash.data.metadata?.exit : undefined;
    if (typeof command === "string" && command !== "") {
      drafts.push({
        kind: "command",
        runner_type: type,
        tool_name: SHELL_TOOL,
        status: u.status,
        // Only a stated exit code: opencode reports null for an aborted command.
        ...opt("exit_code", typeof exit === "number" ? exit : undefined),
        payload: {
          argv: [command],
          call_id: id,
          ...opt("duration_ms", ts >= call.since ? ts - call.since : undefined),
        },
      });
    }
  }
  drafts.push({
    kind: "tool_result",
    runner_type: type,
    tool_name: call.tool,
    status: failed ? "error" : "ok",
    // The output, whole: ingest caps it and spills the rest (§8.5, Invariant 9).
    ...opt("text", text),
    payload: { call_id: id },
  });
  if (!failed) {
    drafts.push(...fileChanges(type, call.tool, id, u.rawOutput));
    if (call.tool === TODO_TOOL) drafts.push(...todos(type, u.rawOutput));
  }
  return same({ ...state, calls }, ...drafts);
}

function onChunk(state: State, type: string, update: unknown): Stepped {
  const f = ChunkUpdate.safeParse(update);
  if (!f.success) return same(state, invalid(type, update, f.error));
  const kind =
    f.data.sessionUpdate === "agent_message_chunk"
      ? "assistant_text"
      : "reasoning";
  const messageId = f.data.messageId ?? "";
  const b = state.buffer;
  if (b !== undefined && b.kind === kind && b.messageId === messageId) {
    return same({
      ...state,
      buffer: { ...b, text: b.text + f.data.content.text },
    });
  }
  return flushed(state, (s) =>
    same({ ...s, buffer: { kind, messageId, text: f.data.content.text } }),
  );
}

function onUpdate(state: State, raw: unknown, ts: number): Stepped {
  const f = SessionUpdate.safeParse((raw as { params?: unknown }).params);
  if (!f.success) return same(state, invalid("session/update", raw, f.error));
  const update: unknown = f.data.update;
  const kind = f.data.update.sessionUpdate;
  const type = `session/update:${kind}`;
  switch (kind) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
      return onChunk(state, type, update);
    case "tool_call":
      return flushed(state, (s) => onToolCall(s, type, update, ts));
    case "tool_call_update":
      return flushed(state, (s) => onToolUpdate(s, type, update, ts));
    case "plan": {
      const p = PlanUpdate.safeParse(update);
      if (!p.success) return same(state, invalid(type, raw, p.error));
      return same(state, {
        kind: "todo",
        runner_type: type,
        payload: {
          items: p.data.entries.map((e) => ({
            text: e.content,
            status: e.status,
          })),
        },
      });
    }
    default:
      // Updates opencode sends that carry nothing canonical: the raw log keeps them. Anything
      // else is stored, never dropped (Invariant 4).
      return QUIET_UPDATES.includes(kind)
        ? same(state)
        : same(state, native(type, raw));
  }
}

// --- the prompt's answer: the run's terminal ----------------------------------------------------------

function terminal(
  state: State,
  type: string,
  outcome: "ok" | "failed" | "interrupted",
  extra: Readonly<Record<string, unknown>>,
  ...before: Draft[]
): Stepped {
  const { run, context, ...rest } = state;
  return same(
    run === undefined ? rest : { ...rest, run: { ...run, ended: true } },
    ...before,
    {
      kind: "terminal",
      runner_type: type,
      payload: { outcome, ...extra, ...opt("context", context) },
    } as Draft,
  );
}

function onPromptResult(
  state: State,
  raw: unknown,
  result: unknown,
  prices: readonly ModelRow[],
): Stepped {
  const type = "rpc:result";
  const f = PromptResult.safeParse(result);
  if (!f.success) return same(state, invalid(type, raw, f.error));
  const model = state.model ?? UNKNOWN_RUNNER_TYPE;
  const usage = f.data.usage;
  const spend = bill(model, usage, prices);
  const reason = f.data.stopReason;
  const end: Draft = {
    kind: "turn_end",
    runner_type: type,
    payload: { usage: usageOf(spend), stop_reason: reason },
  };
  if (reason === "cancelled") {
    return terminal(
      state,
      type,
      "interrupted",
      {
        usage: usageOf(spend),
        error: {
          class: "interrupted",
          message: "the run was cancelled",
          retryable: false,
        },
      },
      end,
    );
  }
  const checked = state.run?.checked;
  if (
    reason === "end_turn" &&
    state.run?.output === true &&
    checked?.ok !== true
  ) {
    const error: FrmError = {
      class: "runner_error",
      message: `the final answer failed the output schema: ${(checked?.issues ?? ["no check was made"]).join("; ")}`,
      retryable: false,
      cause: { kind: "structured_output" },
    };
    return terminal(
      state,
      type,
      "failed",
      { error, spend, usage: usageOf(spend), cost_usd: spend.cost_usd },
      end,
      { kind: "error", runner_type: type, payload: error },
    );
  }
  if (reason === "end_turn") {
    return terminal(
      state,
      type,
      "ok",
      { spend, usage: usageOf(spend), cost_usd: spend.cost_usd },
      {
        kind: "usage",
        runner_type: type,
        payload: {
          usage: tokensOf(usage ?? { inputTokens: 0, outputTokens: 0 }),
          cost_usd: spend.cost_usd,
          scope: "last_model_call",
        },
      },
      end,
    );
  }
  // max_tokens, refusal, max_turn_requests, or a reason this version does not name.
  const error: FrmError = {
    class: "runner_error",
    message: `the turn stopped: ${reason}`,
    retryable: false,
    cause: { kind: reason },
  };
  return terminal(
    state,
    type,
    "failed",
    { error, spend, usage: usageOf(spend), cost_usd: spend.cost_usd },
    end,
    { kind: "error", runner_type: type, payload: error },
  );
}

function onResponse(
  state: State,
  raw: unknown,
  prices: readonly ModelRow[],
): Stepped {
  const run = state.run;
  const forRun = (id: number | string): boolean =>
    run !== undefined && !run.ended && run.rpcId === id;
  if (typeof raw === "object" && raw !== null && "error" in raw) {
    const type = "rpc:error";
    const f = ErrorResponse.safeParse(raw);
    if (!f.success) return same(state, invalid(type, raw, f.error));
    const data = PromptErrorData.safeParse(f.data.error.data);
    const error = classify(
      f.data.error.message,
      data.success ? data.data.errorName : undefined,
    );
    const e: Draft = { kind: "error", runner_type: type, payload: error };
    return forRun(f.data.id)
      ? flushed(state, (s) => terminal(s, type, "failed", { error }, e))
      : same(state, e);
  }
  const f = ResultResponse.safeParse(raw);
  if (!f.success) return same(state, invalid("rpc:result", raw, f.error));
  // The handshake's answers (initialize, session/new, set_config_option): the raw log keeps them.
  if (!forRun(f.data.id)) return same(state);
  const result: unknown = f.data.result;
  return flushed(state, (s) => onPromptResult(s, raw, result, prices));
}

// --- the host's frames -------------------------------------------------------------------------------

function onHost(state: State, type: string, raw: unknown): Stepped {
  switch (type) {
    case HOST_START: {
      const f = HostStart.safeParse(raw);
      if (!f.success) return same(state, invalid(type, raw, f.error));
      // A new process: its calls and text start empty.
      return same(
        { calls: new Map(), model: f.data.model },
        {
          kind: "session_init",
          runner_type: type,
          payload: {
            runner_session_id: f.data.runner_session_id,
            model: f.data.model,
            resumed: f.data.resumed,
          },
        },
      );
    }
    case HOST_TURN: {
      const f = HostTurn.safeParse(raw);
      if (!f.success) return same(state, invalid(type, raw, f.error));
      return flushed(state, (s) =>
        same(
          {
            ...s,
            model: f.data.model,
            run: {
              runId: f.data.run_id,
              rpcId: f.data.rpc_id,
              output: f.data.output,
              ended: false,
            },
          },
          {
            kind: "turn_start",
            runner_type: type,
            payload: { model: f.data.model, output: f.data.output },
          },
        ),
      );
    }
    case HOST_OUTPUT: {
      const f = HostOutput.safeParse(raw);
      if (!f.success) return same(state, invalid(type, raw, f.error));
      const run = state.run;
      if (run === undefined || run.runId !== f.data.run_id) return same(state);
      return same({
        ...state,
        run: { ...run, checked: { ok: f.data.ok, issues: f.data.issues } },
      });
    }
    case HOST_INTERRUPT: {
      const f = HostInterrupt.safeParse(raw);
      return f.success ? same(state) : same(state, invalid(type, raw, f.error));
    }
    default: {
      const f = HostExit.safeParse(raw);
      if (!f.success) return same(state, invalid(type, raw, f.error));
      // opencode is gone: what it streamed stands; a run it did not answer gets no terminal here.
      return flush({ ...state, calls: new Map() });
    }
  }
}

/** A context proxy frame: folded into the run's totals, no event of its own (spec M12). */
function onContext(state: State, raw: unknown): Stepped {
  const folded = foldContextRecord(state.context, raw);
  return folded.ok
    ? same({ ...state, context: folded.totals })
    : same(state, native(CONTEXT_FRAME_TYPE, raw, { issues: folded.issues }));
}

const unparsed = (state: State, text: string, reason: string): Stepped =>
  same(state, native(UNPARSED, text, { parse_error: reason }));

function step(
  state: State,
  input: MapInput,
  prices: readonly ModelRow[],
): Stepped {
  const text = decoder.decode(input.bytes);
  if (input.partial === true) return unparsed(state, text, "partial line");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return unparsed(
      state,
      text,
      e instanceof Error ? e.message : "invalid JSON",
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return unparsed(state, text, "not a JSON object");
  }
  const o = raw as {
    type?: unknown;
    jsonrpc?: unknown;
    method?: unknown;
    id?: unknown;
  };
  if (typeof o.type === "string" && HOST_FRAMES.includes(o.type)) {
    return onHost(state, o.type, raw);
  }
  if (o.type === CONTEXT_FRAME_TYPE) return onContext(state, raw);
  if (o.jsonrpc !== "2.0") {
    const kind =
      typeof o.type === "string" && o.type !== ""
        ? o.type
        : UNKNOWN_RUNNER_TYPE;
    return same(state, native(kind, raw));
  }
  if (o.method === undefined) return onResponse(state, raw, prices);
  if (o.id !== undefined) {
    const f = AgentRequest.safeParse(raw);
    if (!f.success) return same(state, invalid("rpc:request", raw, f.error));
    // The host answered it: a permission request means a rule fell through to `ask`.
    return f.data.method === "session/request_permission"
      ? same(
          state,
          warning(
            f.data.method,
            "opencode asked for a permission, and the host refused it: no-one is there to answer (every rule should be allow or deny)",
          ),
        )
      : same(state, native(f.data.method, raw));
  }
  const n = Notification.safeParse(raw);
  if (!n.success) return same(state, invalid("rpc:notification", raw, n.error));
  return n.data.method === "session/update"
    ? onUpdate(state, raw, input.ts)
    : same(state, native(n.data.method, raw));
}

/** A fresh mapper for one host segment. `prices` price the tokens opencode reports. */
export function createOpencodeMapper(options: {
  readonly prices: readonly ModelRow[];
}): Mapper {
  let state = START;
  return {
    map(input) {
      if (input.bytes.length === 0) return [];
      let stepped: Stepped;
      try {
        stepped = step(state, input, options.prices);
      } catch (e) {
        // Unreachable by design (every frame is safeParsed); kept so a bug never drops a record.
        stepped = unparsed(
          state,
          decoder.decode(input.bytes),
          `mapper failed: ${String(e)}`,
        );
      }
      state = stepped.state;
      const clock = { now: () => input.ts };
      return capToRecord(
        stepped.drafts.map((d) =>
          parseCanonical({ ...d, ts: input.ts }, clock),
        ),
        input.bytes,
        input.ts,
      );
    },
  };
}
