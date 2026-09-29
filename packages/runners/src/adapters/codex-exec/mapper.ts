// The pure mapper from the turn host's stdout to canonical events (§5.2, App. B; design
// §7): Codex's JSONL plus the host's four frames. Record by record, every record is zod-parsed
// against its frame first; state is replaced, never edited, and depends only on the records seen,
// so the same records with the same `ts` give the same events (L2). It never throws (L3).
import { createHash } from "node:crypto";
import {
  UNKNOWN_RUNNER_TYPE,
  canonicalJson,
  parseCanonical,
  type CanonicalEvent,
  type FrmError,
  type JsonValue,
  type Usage,
} from "@bayon/core";
import type { MapInput, Mapper, ModelRow } from "../../adapter.js";
import { UNPARSED, capToRecord } from "../../record-events.js";
import { price, reported, type Spend } from "../../spend.js";
import {
  AgentMessageItem,
  CommandExecutionItem,
  ErrorItem,
  FileChangeItem,
  HOST_EXIT,
  HOST_INTERRUPT,
  HOST_START,
  HOST_TURN,
  HostExit,
  HostInterrupt,
  HostStart,
  HostTurn,
  ItemEvent,
  McpToolCallError,
  McpToolCallItem,
  ReasoningItem,
  StreamError,
  ThreadStarted,
  TodoListItem,
  TurnCompleted,
  TurnFailed,
  TurnStarted,
  WebSearchItem,
  type CodexUsage,
  type ItemEventType,
} from "./frames.js";

/** §5.2 amendment: the one terminal an adapter may write, from its own interrupt + the exit. */
export const INTERRUPT_EXIT_BASIS = "interrupt+exit";

/**
 * Whether `turn.completed.usage` is the thread's running total, as 0.154.0's source says (fact 3),
 * or the process's. The live check pins it (design §12); "process" resets the baseline per turn.
 */
export type UsageScope = "thread" | "process";
export const USAGE_SCOPE: UsageScope = "thread";

/** The tool name a Codex shell command maps to (§5.2 `tool_call`). */
export const SHELL_TOOL = "shell";
const WEB_SEARCH_TOOL = "web_search";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
/** An event before it is stamped with the record's `ts` and validated. */
type Draft = DistributiveOmit<CanonicalEvent, "ts">;

type State = {
  /** Ours, from `frm.host.start`: session_init's runner session id (design Q3). */
  readonly rsid?: string;
  readonly model?: string;
  /** The thread's totals already billed: the host's baseline, then each `turn.completed`. */
  readonly billed?: CodexUsage;
  /** The run the current Codex process serves. */
  readonly runId?: string;
  /** This process's run already has the runner's terminal. */
  readonly ended: boolean;
  /** The run the host logged an interrupt for. */
  readonly interrupted?: string;
  /** Tool calls opened by this process, by call id, with the `ts` that opened them. */
  readonly calls: ReadonlyMap<string, number>;
};
type Stepped = { readonly state: State; readonly drafts: readonly Draft[] };

const START: State = { ended: false, calls: new Map() };
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

const same = (state: State, ...drafts: Draft[]): Stepped => ({ state, drafts });

/** Codex counts cached and cache-written tokens inside `input_tokens`; `spend` keeps them apart. */
export function tokensOf(u: CodexUsage): Usage {
  const cached = u.cached_input_tokens;
  const written = u.cache_write_input_tokens ?? 0;
  return {
    tokens_in: Math.max(0, u.input_tokens - cached - written),
    tokens_out: u.output_tokens,
    tokens_cache_read: cached,
    tokens_cache_write: written,
  };
}

const usageOf = (s: Spend): Usage => ({
  tokens_in: s.tokens_in,
  tokens_out: s.tokens_out,
  tokens_cache_read: s.tokens_cache_read,
  tokens_cache_write: s.tokens_cache_write,
});

/** The run's spend: the growth of the thread's totals since the last billed ones (§8.9). */
function bill(
  state: State,
  total: CodexUsage,
  prices: readonly ModelRow[],
): Spend {
  const model = state.model ?? UNKNOWN_RUNNER_TYPE;
  const priced = (u: CodexUsage) => price(prices, model, tokensOf(u)).totals;
  const previous =
    state.billed === undefined ? {} : { [model]: priced(state.billed) };
  return reported({ previous, carry: {} }, { [model]: priced(total) }).spend;
}

const PATTERNS: readonly {
  readonly kind: string;
  readonly retryable: boolean;
  readonly test: RegExp;
}[] = [
  { kind: "usage_limit", retryable: false, test: /usage limit|quota|billing/i },
  {
    kind: "rate_limit",
    retryable: true,
    test: /rate.?limit|\b429\b|too many requests/i,
  },
  {
    kind: "context_window",
    retryable: false,
    test: /context (window|length)|maximum context|too many tokens/i,
  },
  {
    kind: "auth",
    retryable: false,
    test: /\b401\b|unauthori[sz]ed|authenticat|api key|log ?in/i,
  },
  {
    kind: "sandbox",
    retryable: false,
    test: /sandbox|permission denied|not permitted/i,
  },
  {
    kind: "server",
    retryable: true,
    test: /\b5\d\d\b|overloaded|server error|disconnected|timed? ?out/i,
  },
];

/** A failure's class from its payload, never its exit code (App. B: exit codes are 0/1 only). */
export function classify(message: string): FrmError {
  const hit = PATTERNS.find((p) => p.test.test(message));
  return {
    class: "runner_error",
    message,
    retryable: hit?.retryable ?? false,
    ...opt("cause", hit === undefined ? undefined : { kind: hit.kind }),
  };
}

function argsDigest(input: unknown): string {
  return createHash("sha256")
    .update(canonicalJson((input ?? null) as JsonValue))
    .digest("hex");
}

function onHost(
  state: State,
  type: string,
  raw: unknown,
  scope: UsageScope,
): Stepped {
  switch (type) {
    case HOST_START: {
      const f = HostStart.safeParse(raw);
      if (!f.success) return same(state, invalid(type, raw, f.error));
      return same({
        ...START,
        rsid: f.data.runner_session_id,
        ...(scope === "thread" && f.data.usage_total !== null
          ? { billed: f.data.usage_total }
          : {}),
      });
    }
    case HOST_TURN: {
      const f = HostTurn.safeParse(raw);
      if (!f.success) return same(state, invalid(type, raw, f.error));
      // A new process: its calls and interrupt start empty; the thread's billed totals carry over
      // only when they are the thread's (usage scope).
      const next: State = {
        ...opt("rsid", state.rsid),
        ...(scope === "thread" ? opt("billed", state.billed) : {}),
        model: f.data.model,
        runId: f.data.run_id,
        ended: false,
        calls: new Map(),
      };
      return same(next, {
        kind: "turn_start",
        runner_type: type,
        payload: { model: f.data.model, resume: f.data.resume },
      });
    }
    case HOST_INTERRUPT: {
      const f = HostInterrupt.safeParse(raw);
      if (!f.success) return same(state, invalid(type, raw, f.error));
      return same({ ...state, interrupted: f.data.run_id });
    }
    default: {
      const f = HostExit.safeParse(raw);
      if (!f.success) return same(state, invalid(type, raw, f.error));
      const next: State = { ...state, ended: true, calls: new Map() };
      // §5.2 amendment: only our own logged interrupt, then the observed end, with no runner
      // terminal between. The exit code is never read for it.
      return state.interrupted === f.data.run_id && !state.ended
        ? same(next, {
            kind: "terminal",
            runner_type: type,
            payload: {
              outcome: "interrupted",
              basis: INTERRUPT_EXIT_BASIS,
              error: {
                class: "interrupted",
                message: "the run was interrupted",
                retryable: false,
              },
            },
          })
        : same(next);
    }
  }
}

const invalid = (
  type: string,
  raw: unknown,
  error: Parameters<typeof issuesOf>[0],
): Draft => native(type, raw, { issues: issuesOf(error) });

function onTurnCompleted(
  state: State,
  raw: unknown,
  prices: readonly ModelRow[],
): Stepped {
  const f = TurnCompleted.safeParse(raw);
  if (!f.success) return same(state, invalid("turn.completed", raw, f.error));
  const total = f.data.usage;
  const spend = bill(state, total, prices);
  const model = state.model ?? UNKNOWN_RUNNER_TYPE;
  return same(
    { ...state, billed: total, ended: true },
    {
      kind: "usage",
      runner_type: "turn.completed",
      payload: {
        usage: tokensOf(total),
        cost_usd: price(prices, model, tokensOf(total)).totals.cost_usd,
        thread_total: true,
      },
    },
    {
      kind: "turn_end",
      runner_type: "turn.completed",
      payload: { usage: usageOf(spend), stop_reason: "completed" },
    },
    {
      kind: "terminal",
      runner_type: "turn.completed",
      payload: {
        outcome: "ok",
        spend,
        usage: usageOf(spend),
        cost_usd: spend.cost_usd,
      },
    },
  );
}

function onTurnFailed(state: State, raw: unknown): Stepped {
  const f = TurnFailed.safeParse(raw);
  if (!f.success) return same(state, invalid("turn.failed", raw, f.error));
  // A failed turn reports no usage: its tokens land on the next completed run (design §8).
  const error = classify(f.data.error.message);
  return same(
    { ...state, ended: true },
    { kind: "error", runner_type: "turn.failed", payload: error },
    {
      kind: "terminal",
      runner_type: "turn.failed",
      payload: { outcome: "failed", error },
    },
  );
}

const warning = (type: string, message: string): Draft => ({
  kind: "error",
  runner_type: type,
  status: "warning",
  payload: { class: "runner_error", message, retryable: false },
});

/** A command's `tool_call`, unless this process already opened that call id. */
const openCall = (
  state: State,
  type: string,
  callId: string,
  tool: string,
  input: Readonly<Record<string, unknown>>,
  ts: number,
): Stepped =>
  state.calls.has(callId)
    ? same(state)
    : same(
        { ...state, calls: new Map([...state.calls, [callId, ts]]) },
        {
          kind: "tool_call",
          runner_type: type,
          tool_name: tool,
          payload: { call_id: callId, input },
        },
      );

function onCommand(
  state: State,
  type: ItemEventType,
  raw: unknown,
  item: unknown,
  ts: number,
): Stepped {
  const f = CommandExecutionItem.safeParse(item);
  if (!f.success) return same(state, invalid(type, raw, f.error));
  const c = f.data;
  if (type === "item.updated") return same(state);
  const opened = openCall(
    state,
    type,
    c.id,
    SHELL_TOOL,
    { command: c.command },
    ts,
  );
  if (type === "item.started") return opened;
  const startedAt = opened.state.calls.get(c.id) ?? ts;
  const calls = new Map(opened.state.calls);
  calls.delete(c.id);
  return same(
    { ...opened.state, calls },
    ...opened.drafts,
    {
      kind: "command",
      runner_type: type,
      tool_name: SHELL_TOOL,
      status: c.status,
      // Only a stated exit code: null means Codex never saw one.
      ...opt("exit_code", c.exit_code),
      payload: {
        // One shell command line, verbatim: splitting it would guess at shell quoting.
        argv: [c.command],
        call_id: c.id,
        ...opt("duration_ms", ts >= startedAt ? ts - startedAt : undefined),
      },
    },
    {
      kind: "tool_result",
      runner_type: type,
      tool_name: SHELL_TOOL,
      status: c.status === "completed" ? "ok" : "error",
      // The command's output, whole: ingest caps it and spills the rest (§8.5, Invariant 9).
      ...opt(
        "text",
        c.aggregated_output === "" ? undefined : c.aggregated_output,
      ),
      payload: { call_id: c.id },
    },
  );
}

function onFileChange(
  state: State,
  type: ItemEventType,
  raw: unknown,
  item: unknown,
): Stepped {
  const f = FileChangeItem.safeParse(item);
  if (!f.success) return same(state, invalid(type, raw, f.error));
  if (type !== "item.completed" || f.data.status === "in_progress")
    return same(state);
  if (f.data.status === "failed") {
    return same(
      state,
      warning(
        type,
        `patch failed: ${f.data.changes.map((c) => c.path).join(", ")}`,
      ),
    );
  }
  return same(
    state,
    ...f.data.changes.map((c): Draft => ({
      kind: "file_change",
      runner_type: type,
      payload: {
        path: c.path,
        change: c.kind === "update" ? "modify" : c.kind,
        call_id: f.data.id,
      },
    })),
  );
}

function onMcp(
  state: State,
  type: ItemEventType,
  raw: unknown,
  item: unknown,
): Stepped {
  const f = McpToolCallItem.safeParse(item);
  if (!f.success) return same(state, invalid(type, raw, f.error));
  if (type !== "item.completed" || f.data.status === "in_progress")
    return same(state);
  const ok = f.data.status === "completed";
  // A failed call's reason is its only trace: Codex refuses an unapproved call itself, before any
  // request. Read apart from the frame, so an error of another shape costs only this.
  const error = ok ? undefined : McpToolCallError.safeParse(f.data["error"]);
  // One event with its outcome and no tool_result, so tool_call/tool_result pairs stay paired.
  return same(state, {
    kind: "mcp_call",
    runner_type: type,
    tool_name: f.data.tool,
    status: ok ? "ok" : "error",
    ...opt("text", error?.success === true ? error.data.message : undefined),
    payload: {
      server: f.data.server,
      call_id: f.data.id,
      args_digest: argsDigest(f.data.arguments),
      outcome: ok ? "ok" : "failed",
    },
  });
}

function onWebSearch(
  state: State,
  type: ItemEventType,
  raw: unknown,
  item: unknown,
  ts: number,
): Stepped {
  const f = WebSearchItem.safeParse(item);
  if (!f.success) return same(state, invalid(type, raw, f.error));
  if (type === "item.updated") return same(state);
  const opened = openCall(
    state,
    type,
    f.data.id,
    WEB_SEARCH_TOOL,
    { query: f.data.query },
    ts,
  );
  if (type === "item.started") return opened;
  const calls = new Map(opened.state.calls);
  calls.delete(f.data.id);
  return same({ ...opened.state, calls }, ...opened.drafts, {
    kind: "tool_result",
    runner_type: type,
    tool_name: WEB_SEARCH_TOOL,
    status: "ok",
    payload: { call_id: f.data.id },
  });
}

/** Parses `item` against `schema`, then maps it only when the event is `item.completed`. */
function onCompleted<T>(
  state: State,
  type: ItemEventType,
  raw: unknown,
  parsed:
    | { success: true; data: T }
    | { success: false; error: Parameters<typeof issuesOf>[0] },
  map: (data: T) => Draft,
): Stepped {
  if (!parsed.success) return same(state, invalid(type, raw, parsed.error));
  return type === "item.completed"
    ? same(state, map(parsed.data))
    : same(state);
}

function onItem(state: State, raw: unknown, ts: number): Stepped {
  const f = ItemEvent.safeParse(raw);
  const type =
    typeof (raw as { type?: unknown }).type === "string"
      ? String((raw as { type: string }).type)
      : UNKNOWN_RUNNER_TYPE;
  if (!f.success) return same(state, invalid(type, raw, f.error));
  const event = f.data.type;
  const item: unknown = f.data.item;
  switch (f.data.item.type) {
    case "command_execution":
      return onCommand(state, event, raw, item, ts);
    case "file_change":
      return onFileChange(state, event, raw, item);
    case "mcp_tool_call":
      return onMcp(state, event, raw, item);
    case "web_search":
      return onWebSearch(state, event, raw, item, ts);
    case "agent_message":
      return onCompleted(
        state,
        event,
        raw,
        AgentMessageItem.safeParse(item),
        (d) => ({
          kind: "assistant_text",
          runner_type: event,
          text: d.text,
          payload: {},
        }),
      );
    case "reasoning":
      return onCompleted(
        state,
        event,
        raw,
        ReasoningItem.safeParse(item),
        (d) => ({
          kind: "reasoning",
          runner_type: event,
          text: d.text,
          payload: { summary_only: true },
        }),
      );
    case "error":
      return onCompleted(state, event, raw, ErrorItem.safeParse(item), (d) =>
        warning(event, d.message),
      );
    case "todo_list": {
      const t = TodoListItem.safeParse(item);
      if (!t.success) return same(state, invalid(event, raw, t.error));
      return same(state, {
        kind: "todo",
        runner_type: event,
        payload: {
          items: t.data.items.map((i) => ({
            text: i.text,
            status: i.completed ? "completed" : "pending",
          })),
        },
      });
    }
    default:
      // collab_tool_call and any type 0.154.0 does not name: stored, never dropped (Invariant 4).
      return same(state, native(event, raw));
  }
}

const unparsed = (state: State, text: string, reason: string): Stepped =>
  same(state, native(UNPARSED, text, { parse_error: reason }));

function step(
  state: State,
  input: MapInput,
  prices: readonly ModelRow[],
  scope: UsageScope,
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
  const { type } = raw as { type?: unknown };
  const kind =
    typeof type === "string" && type !== "" ? type : UNKNOWN_RUNNER_TYPE;
  switch (kind) {
    case HOST_START:
    case HOST_TURN:
    case HOST_INTERRUPT:
    case HOST_EXIT:
      return onHost(state, kind, raw, scope);
    case "thread.started": {
      const f = ThreadStarted.safeParse(raw);
      if (!f.success) return same(state, invalid(kind, raw, f.error));
      return same(state, {
        kind: "session_init",
        runner_type: kind,
        payload: {
          runner_session_id: state.rsid ?? f.data.thread_id,
          thread_id: f.data.thread_id,
          ...opt("model", state.model),
        },
      });
    }
    case "turn.started": {
      // The run began at frm.host.turn (its turn_start); this one is kept in the raw log only.
      const f = TurnStarted.safeParse(raw);
      return f.success ? same(state) : same(state, invalid(kind, raw, f.error));
    }
    case "turn.completed":
      return onTurnCompleted(state, raw, prices);
    case "turn.failed":
      return onTurnFailed(state, raw);
    case "error": {
      const f = StreamError.safeParse(raw);
      if (!f.success) return same(state, invalid(kind, raw, f.error));
      // Never terminal: the known review hang starts with one of these (§5.2, App. B).
      return same(state, {
        kind: "error",
        runner_type: kind,
        payload: {
          class: "runner_error",
          message: f.data.message,
          retryable: false,
        },
      });
    }
    case "item.started":
    case "item.updated":
    case "item.completed":
      return onItem(state, raw, input.ts);
    default:
      return same(state, native(kind, raw));
  }
}

/** A fresh mapper for one host segment. `prices` price the tokens Codex reports. */
export function createCodexMapper(options: {
  readonly prices: readonly ModelRow[];
  readonly usageScope?: UsageScope;
}): Mapper {
  const scope = options.usageScope ?? USAGE_SCOPE;
  let state = START;
  return {
    map(input) {
      if (input.bytes.length === 0) return [];
      let stepped: Stepped;
      try {
        stepped = step(state, input, options.prices, scope);
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
