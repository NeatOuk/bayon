// The pure mapper from the runner's stdout records to canonical events (§5.2, contract 2).
// Record by record: state is replaced, never edited, and depends only on the records seen, so the
// same records with the same `ts` always give the same events (law L2). It never throws (L3).
import { createHash } from "node:crypto";
import {
  UNKNOWN_RUNNER_TYPE,
  canonicalJson,
  parseCanonical,
  type CanonicalEvent,
  type ContextTotals,
  type FrmError,
  type JsonValue,
  type RunOutcome,
  type Usage,
} from "@bayon/core";
import type { MapInput, Mapper, ModelRow } from "../../adapter.js";
import {
  SPEND_START,
  estimated,
  isZero,
  price,
  reported,
  type ByModel,
  type Spend,
  type SpendState,
  type Totals,
} from "../../spend.js";
import { CONTEXT_FRAME_TYPE, foldContextRecord } from "../../context-frames.js";
import { UNPARSED, capToRecord } from "../../record-events.js";
import {
  AssistantFrame,
  BashInput,
  BashOutput,
  ControlRequestFrame,
  FileEditOutput,
  InitFrame,
  NotebookEditInput,
  ResultFrame,
  TextBlock,
  ThinkingBlock,
  TodoWriteOutput,
  ToolResultBlock,
  ToolUseBlock,
  UserFrame,
  type ApiUsage,
} from "./frames.js";
import { STRUCTURED_OUTPUT_TOOL, splitTools } from "./tool-names.js";
import { streamPrices } from "./window.js";

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const TRANSPORT = new Set([
  "keep_alive",
  "control_response",
  "control_cancel_request",
]);
const RETRYABLE_API_ERRORS = new Set([
  "rate_limit",
  "overloaded",
  "server_error",
]);
const MCP_TOOL = /^mcp__(.+?)__(.+)$/;
const SHELL_TOOL = "Bash";
/** The Bash tool's error result for a non-zero exit starts with its code. */
const STATED_EXIT = /^Exit code (\d{1,10})(?:\n|$)/;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
/** An event before it is stamped with the record's `ts` and validated. */
type Draft = DistributiveOmit<CanonicalEvent, "ts">;

type Step = {
  readonly id: string;
  readonly model?: string;
  readonly usage?: Usage;
  readonly stopReason?: string;
};
/** A tool call, and the `ts` of the record that made it. */
type Call = {
  readonly name: string;
  readonly input: unknown;
  readonly ts: number;
};

/** Everything the mapper remembers, per process segment. */
type State = {
  readonly initSeen: boolean;
  readonly cwd?: string;
  /**
   * The process was started with a JSON schema: its init lists the tool that returns the answer,
   * and every run of it owes a `structured_output` (SpawnSpec.output).
   */
  readonly structured: boolean;
  /** The open top-level model step. */
  readonly open?: Step;
  /** This run's finished top-level steps, for estimating a zeroed result. */
  readonly closed: readonly Step[];
  /** Top-level message ids seen this run: a late frame of a closed step must not reopen it. */
  readonly seen: ReadonlySet<string>;
  /** Whether this run produced any assistant frame. */
  readonly active: boolean;
  /** This run's tool calls by call id. */
  readonly calls: ReadonlyMap<string, Call>;
  readonly spend: SpendState;
  /** This run's context proxy frames, folded (spec M12): the terminal carries them. */
  readonly context?: ContextTotals;
};
type Stepped = { readonly state: State; readonly drafts: readonly Draft[] };

const START: State = {
  initSeen: false,
  structured: false,
  closed: [],
  seen: new Set(),
  active: false,
  calls: new Map(),
  spend: SPEND_START,
};

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

const usageOf = (u: ApiUsage | undefined): Usage | undefined =>
  u === undefined
    ? undefined
    : {
        tokens_in: u.input_tokens ?? 0,
        tokens_out: u.output_tokens ?? 0,
        tokens_cache_read: u.cache_read_input_tokens ?? 0,
        tokens_cache_write: u.cache_creation_input_tokens ?? 0,
      };

const parentOf = (parent: string | null | undefined) =>
  opt("parent_call_id", parent);

function turnEnd(step: Step, fallbackStop: string | null | undefined): Draft {
  return {
    kind: "turn_end",
    runner_type: "assistant",
    payload: {
      message_id: step.id,
      ...opt("usage", step.usage),
      ...opt("stop_reason", step.stopReason ?? fallbackStop),
    },
  };
}

const withoutOpen = ({ open, ...rest }: State): State =>
  open === undefined ? rest : { ...rest, closed: [...rest.closed, open] };

function argsDigest(input: unknown): string {
  return createHash("sha256")
    .update(canonicalJson((input ?? null) as JsonValue))
    .digest("hex");
}

function blockDrafts(
  block: unknown,
  parent: string | null | undefined,
): Draft[] {
  const nested = parentOf(parent);
  const text = TextBlock.safeParse(block);
  if (text.success) {
    return [
      {
        kind: "assistant_text",
        runner_type: "assistant",
        text: text.data.text,
        payload: nested,
      },
    ];
  }
  const thinking = ThinkingBlock.safeParse(block);
  if (thinking.success) {
    return [
      {
        kind: "reasoning",
        runner_type: "assistant",
        text: thinking.data.thinking,
        payload: nested,
      },
    ];
  }
  if ((block as { type?: unknown }).type === "redacted_thinking") {
    return [
      {
        kind: "reasoning",
        runner_type: "assistant",
        text: "",
        payload: { ...nested, redacted: true },
      },
    ];
  }
  const use = ToolUseBlock.safeParse(block);
  if (!use.success) return [native("assistant", block, nested)];
  const mcp = MCP_TOOL.exec(use.data.name);
  if (mcp?.[1] !== undefined && mcp[2] !== undefined) {
    return [
      {
        kind: "mcp_call",
        runner_type: "assistant",
        tool_name: mcp[2],
        payload: {
          server: mcp[1],
          call_id: use.data.id,
          args_digest: argsDigest(use.data.input),
          ...nested,
        },
      },
    ];
  }
  return [
    {
      kind: "tool_call",
      runner_type: "assistant",
      tool_name: use.data.name,
      payload: { call_id: use.data.id, input: use.data.input, ...nested },
    },
  ];
}

function callsOf(content: readonly unknown[], ts: number): [string, Call][] {
  return content.flatMap((block) => {
    const use = ToolUseBlock.safeParse(block);
    return use.success
      ? [[use.data.id, { name: use.data.name, input: use.data.input, ts }]]
      : [];
  });
}

function onAssistant(state: State, raw: unknown, ts: number): Stepped {
  const parsed = AssistantFrame.safeParse(raw);
  if (!parsed.success) {
    return {
      state,
      drafts: [native("assistant", raw, { issues: issuesOf(parsed.error) })],
    };
  }
  const f = parsed.data;
  const active = { ...state, active: true };
  if (f.error !== undefined) {
    // A synthetic API-error message: an error, not a model step.
    const message = f.message.content.flatMap((b) => {
      const t = TextBlock.safeParse(b);
      return t.success ? [t.data.text] : [];
    });
    return {
      state: active,
      drafts: [
        {
          kind: "error",
          runner_type: "assistant",
          payload: {
            class: "runner_error",
            message: message.join("\n") || f.error,
            retryable: RETRYABLE_API_ERRORS.has(f.error),
            runner_error: f.error,
            ...parentOf(f.parent_tool_use_id),
          },
        },
      ],
    };
  }
  const calls = new Map([...state.calls, ...callsOf(f.message.content, ts)]);
  const blocks = f.message.content.flatMap((b) =>
    blockDrafts(b, f.parent_tool_use_id),
  );
  const usage = usageOf(f.message.usage);
  const topLevel =
    f.parent_tool_use_id === null || f.parent_tool_use_id === undefined;
  const { id } = f.message;

  if (!topLevel || (state.open?.id !== id && state.seen.has(id))) {
    // A subagent's frame, or a late frame of a step that already ended: no turn events.
    return { state: { ...active, calls }, drafts: blocks };
  }
  if (state.open?.id === id) {
    const open: Step = {
      ...state.open,
      ...opt("usage", usage ?? state.open.usage),
      ...opt("stopReason", f.message.stop_reason ?? state.open.stopReason),
    };
    return { state: { ...active, calls, open }, drafts: blocks };
  }
  const step: Step = {
    id,
    ...opt("model", f.message.model),
    ...opt("usage", usage),
    ...opt("stopReason", f.message.stop_reason),
  };
  const ending =
    state.open === undefined ? [] : [turnEnd(state.open, undefined)];
  return {
    state: {
      ...withoutOpen(active),
      calls,
      open: step,
      seen: new Set([...state.seen, id]),
    },
    drafts: [
      ...ending,
      {
        kind: "turn_start",
        runner_type: "assistant",
        payload: { message_id: id, ...opt("model", f.message.model) },
      },
      ...blocks,
    ],
  };
}

function outputText(content: ToolResultBlock["content"]): string | undefined {
  if (typeof content === "string") return content;
  const texts = (content ?? []).flatMap((b) => {
    const t = TextBlock.safeParse(b);
    return t.success ? [t.data.text] : [];
  });
  return texts.length === 0 ? undefined : texts.join("\n");
}

const relativeTo = (cwd: string | undefined, path: string): string =>
  cwd !== undefined && path.startsWith(`${cwd}/`)
    ? path.slice(cwd.length + 1)
    : path;

const countLines = (text: string): number =>
  text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

function fileChange(call: Call, output: unknown, cwd: string | undefined) {
  if (call.name === "NotebookEdit") {
    const input = NotebookEditInput.safeParse(call.input);
    return input.success
      ? {
          path: relativeTo(cwd, input.data.notebook_path),
          change: "modify" as const,
        }
      : undefined;
  }
  const parsed = FileEditOutput.safeParse(output);
  if (!parsed.success) return undefined;
  const r = parsed.data;
  const patch = r.structuredPatch?.flatMap((hunk) => hunk.lines) ?? [];
  const lines = r.gitDiff
    ? { lines_added: r.gitDiff.additions, lines_removed: r.gitDiff.deletions }
    : patch.length > 0
      ? {
          lines_added: patch.filter((l) => l.startsWith("+")).length,
          lines_removed: patch.filter((l) => l.startsWith("-")).length,
        }
      : r.type === "create" && r.content !== undefined
        ? { lines_added: countLines(r.content), lines_removed: 0 }
        : {};
  const created = r.type === "create" || r.gitDiff?.status === "added";
  return {
    path: r.gitDiff?.filename ?? relativeTo(cwd, r.filePath),
    change: created ? ("add" as const) : ("modify" as const),
    ...lines,
  };
}

function resultDrafts(
  block: ToolResultBlock,
  call: Call | undefined,
  output: unknown,
  parent: string | null | undefined,
  cwd: string | undefined,
): Draft[] {
  const nested = parentOf(parent);
  const status = block.is_error === true ? ("error" as const) : ("ok" as const);
  const result: Draft = {
    kind: "tool_result",
    runner_type: "user",
    status,
    ...opt("tool_name", call?.name),
    ...opt("text", outputText(block.content)),
    payload: { call_id: block.tool_use_id, ...nested },
  };
  if (status === "error" || call === undefined) return [result];
  const change = FILE_TOOLS.has(call.name)
    ? fileChange(call, output, cwd)
    : undefined;
  if (change !== undefined) {
    return [
      result,
      {
        kind: "file_change",
        runner_type: "user",
        payload: { ...change, call_id: block.tool_use_id, ...nested },
      },
    ];
  }
  const todos =
    call.name === "TodoWrite" ? TodoWriteOutput.safeParse(output) : undefined;
  if (todos?.success === true) {
    const items = todos.data.newTodos.map((t) => ({
      text: t.content,
      status: t.status,
    }));
    return [
      result,
      {
        kind: "todo",
        runner_type: "user",
        payload: { items, call_id: block.tool_use_id, ...nested },
      },
    ];
  }
  return [result];
}

type ShellEnd = {
  readonly status: "ok" | "error" | "interrupted" | "timeout" | "background";
  readonly exitCode?: number;
  /** Still running in the background: it has no duration yet. */
  readonly running?: boolean;
};

/** How a Bash command ended, from what its result states. An unstated exit code is left out. */
function shellEnd(block: ToolResultBlock, output: unknown): ShellEnd {
  if (block.is_error === true) {
    const code = STATED_EXIT.exec(outputText(block.content) ?? "")?.[1];
    return code === undefined
      ? { status: "error" }
      : { status: "error", exitCode: Number(code) };
  }
  const parsed = BashOutput.safeParse(output);
  if (!parsed.success) return { status: "ok" };
  const out = parsed.data;
  if (out.interrupted) return { status: "interrupted" };
  if (out.timedOutAfterMs !== undefined)
    return { status: "timeout", running: true };
  if (out.backgroundTaskId !== undefined)
    return { status: "background", running: true };
  // A success states no exit code, and gate evidence never rests on an inferred 0 (Invariant 10).
  return { status: "ok" };
}

/** A Bash result as a canonical `command` (§5.2). Its output stays on the `tool_result` (§8.5). */
function commandDrafts(
  block: ToolResultBlock,
  call: Call | undefined,
  output: unknown,
  parent: string | null | undefined,
  ts: number,
): Draft[] {
  if (call?.name !== SHELL_TOOL) return [];
  const input = BashInput.safeParse(call.input);
  if (!input.success) return [];
  const end = shellEnd(block, output);
  const duration =
    end.running === true || ts < call.ts ? undefined : ts - call.ts;
  return [
    {
      kind: "command",
      runner_type: "user",
      tool_name: call.name,
      status: end.status,
      ...opt("exit_code", end.exitCode),
      payload: {
        // One shell command line, verbatim: splitting it would guess at shell quoting.
        argv: [input.data.command],
        call_id: block.tool_use_id,
        ...opt("duration_ms", duration),
        ...parentOf(parent),
      },
    },
  ];
}

function onUser(state: State, raw: unknown, ts: number): Stepped {
  const parsed = UserFrame.safeParse(raw);
  if (!parsed.success) {
    return {
      state,
      drafts: [native("user", raw, { issues: issuesOf(parsed.error) })],
    };
  }
  const f = parsed.data;
  const results = Array.isArray(f.message.content)
    ? f.message.content.flatMap((b) => {
        const r = ToolResultBlock.safeParse(b);
        return r.success ? [r.data] : [];
      })
    : [];
  if (results.length === 0) return { state, drafts: [native("user", raw)] };
  const topLevel =
    f.parent_tool_use_id === null || f.parent_tool_use_id === undefined;
  const ending =
    topLevel && state.open !== undefined
      ? [turnEnd(state.open, "tool_use")]
      : [];
  // The structured output belongs to the frame's only result; with several it is ambiguous.
  const output = results.length === 1 ? f.tool_use_result : undefined;
  return {
    state: topLevel ? withoutOpen(state) : state,
    drafts: [
      ...ending,
      ...results.flatMap((b) =>
        resultDrafts(
          b,
          state.calls.get(b.tool_use_id),
          output,
          f.parent_tool_use_id,
          state.cwd,
        ),
      ),
      // Last in the record, so the events above keep the ordinals they had before commands.
      ...results.flatMap((b) =>
        commandDrafts(
          b,
          state.calls.get(b.tool_use_id),
          output,
          f.parent_tool_use_id,
          ts,
        ),
      ),
    ],
  };
}

const ZERO_USAGE: Usage = {
  tokens_in: 0,
  tokens_out: 0,
  tokens_cache_read: 0,
  tokens_cache_write: 0,
};
const addUsage = (a: Usage, b: Usage): Usage => ({
  tokens_in: a.tokens_in + b.tokens_in,
  tokens_out: a.tokens_out + b.tokens_out,
  tokens_cache_read: a.tokens_cache_read + b.tokens_cache_read,
  tokens_cache_write: a.tokens_cache_write + b.tokens_cache_write,
});
const tokensOf = (t: Totals): Usage => ({
  tokens_in: t.tokens_in,
  tokens_out: t.tokens_out,
  tokens_cache_read: t.tokens_cache_read,
  tokens_cache_write: t.tokens_cache_write,
});

function byModelOf(modelUsage: ResultFrame["modelUsage"]): ByModel {
  return Object.fromEntries(
    Object.entries(modelUsage).map(([model, m]) => [
      model,
      {
        tokens_in: m.inputTokens,
        tokens_out: m.outputTokens,
        tokens_cache_read: m.cacheReadInputTokens,
        tokens_cache_write: m.cacheCreationInputTokens,
        cost_usd: m.costUSD,
      },
    ]),
  );
}

/** Prices the run's steps from their final per-step usage (§5.1 estimation path). */
function estimate(
  spend: SpendState,
  steps: readonly Step[],
  prices: readonly ModelRow[],
): { readonly state: SpendState; readonly spend: Spend } {
  const usage = steps.reduce<Readonly<Record<string, Usage>>>(
    (acc, s) =>
      s.usage === undefined
        ? acc
        : {
            ...acc,
            [s.model ?? UNKNOWN_RUNNER_TYPE]: addUsage(
              acc[s.model ?? UNKNOWN_RUNNER_TYPE] ?? ZERO_USAGE,
              s.usage,
            ),
          },
    {},
  );
  const priced = Object.entries(usage).map(
    ([model, u]) => [model, price(prices, model, u)] as const,
  );
  return estimated(
    spend,
    Object.fromEntries(priced.map(([model, p]) => [model, p.totals])),
    priced.some(([, p]) => p.unpriced),
  );
}

/** The runner gave up on a valid structured output: its own retries at the schema ran out. */
const retriesExhausted = (f: ResultFrame): boolean =>
  f.subtype === "error_max_structured_output_retries" ||
  f.terminal_reason === "structured_output_retry_exhausted";

/** A run that owed a structured output (`structured`) and ended "successfully" without one. */
const missingOutput = (f: ResultFrame, structured: boolean): boolean =>
  structured &&
  f.subtype === "success" &&
  !f.is_error &&
  f.structured_output === undefined;

function outcomeOf(f: ResultFrame, structured: boolean): RunOutcome {
  if (f.terminal_reason?.startsWith("aborted_") === true) return "interrupted";
  if (f.subtype === "error_max_turns" || f.subtype === "error_max_budget_usd")
    return "budget_stop";
  if (retriesExhausted(f) || missingOutput(f, structured)) return "failed";
  return f.subtype === "success" && !f.is_error ? "ok" : "failed";
}

function terminalError(
  outcome: RunOutcome,
  f: ResultFrame,
  structured: boolean,
  message: string,
  retryable: boolean,
): FrmError | undefined {
  if (outcome === "interrupted") {
    return {
      class: "interrupted",
      message: "the run was interrupted",
      retryable: false,
    };
  }
  if (outcome !== "failed") return undefined;
  // Structured output that never came is the runner's failure, and a retry of the same run
  // would ask the same model the same thing: not retryable here (a gate decides its own retries).
  if (retriesExhausted(f)) {
    return {
      class: "runner_error",
      message: `no valid structured output: the runner's retries ran out (${message})`,
      retryable: false,
    };
  }
  if (missingOutput(f, structured)) {
    return {
      class: "runner_error",
      message: "the run ended without its structured output",
      retryable: false,
    };
  }
  return { class: "runner_error", message, retryable };
}

function onResult(
  state: State,
  raw: unknown,
  prices: readonly ModelRow[],
): Stepped {
  const parsed = ResultFrame.safeParse(raw);
  const runnerType = `result/${String((raw as { subtype?: unknown }).subtype)}`;
  if (!parsed.success) {
    return {
      state,
      drafts: [native(runnerType, raw, { issues: issuesOf(parsed.error) })],
    };
  }
  const f = parsed.data;
  const ending =
    state.open === undefined ? [] : [turnEnd(state.open, f.stop_reason)];
  const steps = withoutOpen(state).closed;
  const current = byModelOf(f.modelUsage);
  // Crash results may carry zeroed totals: estimate rather than bill nothing (§5.1).
  const zeroed =
    isZero(current) && (state.active || !isZero(state.spend.previous));
  const billed = zeroed
    ? estimate(state.spend, steps, prices)
    : reported(state.spend, current);
  const outcome = outcomeOf(f, state.structured);
  const message =
    (f.errors ?? []).join("; ") ||
    (f.result !== undefined && f.result !== "" ? f.result : f.subtype);
  const status = f.api_error_status ?? undefined;
  const retryable = status !== undefined && (status === 429 || status >= 500);
  const snapshot = Object.values(current).reduce<Usage>(
    (sum, t) => addUsage(sum, tokensOf(t)),
    ZERO_USAGE,
  );
  const error: Draft[] = f.is_error
    ? [
        {
          kind: "error",
          runner_type: runnerType,
          payload: {
            class: "runner_error",
            message,
            retryable,
            runner_error: f.subtype,
            ...opt("api_error_status", status),
          },
        },
      ]
    : [];
  return {
    state: {
      ...START,
      initSeen: state.initSeen,
      structured: state.structured,
      ...opt("cwd", state.cwd),
      spend: billed.state,
    },
    drafts: [
      ...ending,
      {
        kind: "usage",
        runner_type: runnerType,
        payload: {
          usage: snapshot,
          cost_usd: f.total_cost_usd,
          by_model: current,
        },
      },
      ...error,
      {
        kind: "terminal",
        runner_type: runnerType,
        payload: {
          outcome,
          ...opt("terminal_reason", f.terminal_reason),
          num_turns: f.num_turns,
          duration_ms: f.duration_ms,
          spend: billed.spend,
          usage: tokensOf(billed.spend),
          cost_usd: billed.spend.cost_usd,
          ...opt(
            "error",
            terminalError(outcome, f, state.structured, message, retryable),
          ),
          ...opt("context", state.context),
        },
      },
    ],
  };
}

function onInit(state: State, raw: unknown): Stepped {
  if (state.initSeen) return { state, drafts: [native("system/init", raw)] };
  const parsed = InitFrame.safeParse(raw);
  if (!parsed.success) {
    return {
      state,
      drafts: [native("system/init", raw, { issues: issuesOf(parsed.error) })],
    };
  }
  const f = parsed.data;
  return {
    state: {
      ...state,
      initSeen: true,
      structured: f.tools?.includes(STRUCTURED_OUTPUT_TOOL) === true,
      ...opt("cwd", f.cwd),
    },
    drafts: [
      {
        kind: "session_init",
        runner_type: "system/init",
        payload: {
          runner_session_id: f.session_id,
          ...opt("model", f.model),
          ...opt("cwd", f.cwd),
          ...opt("tools", f.tools),
          ...(f.tools === undefined ? {} : splitTools(f.tools)),
          ...opt("mcp_servers", f.mcp_servers),
          ...opt("cli_version", f.claude_code_version),
          ...opt("permission_mode", f.permissionMode),
        },
      },
    ],
  };
}

function onControlRequest(state: State, raw: unknown): Stepped {
  const parsed = ControlRequestFrame.safeParse(raw);
  const request = parsed.success ? parsed.data.request : undefined;
  if (
    !parsed.success ||
    request?.subtype !== "can_use_tool" ||
    request.tool_name === undefined
  ) {
    return { state, drafts: [native("control_request", raw)] };
  }
  return {
    state,
    drafts: [
      {
        kind: "approval_request",
        runner_type: "control_request",
        tool_name: request.tool_name,
        payload: { input: request.input, request_id: parsed.data.request_id },
      },
    ],
  };
}

/** A context proxy frame: folded into the run's totals, no event of its own (spec M12). */
function onContext(state: State, raw: unknown): Stepped {
  const folded = foldContextRecord(state.context, raw);
  return folded.ok
    ? { state: { ...state, context: folded.totals }, drafts: [] }
    : {
        state,
        drafts: [native(CONTEXT_FRAME_TYPE, raw, { issues: folded.issues })],
      };
}

const unparsed = (state: State, text: string, reason: string): Stepped => ({
  state,
  drafts: [native(UNPARSED, text, { parse_error: reason })],
});

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
  const { type, subtype } = raw as { type?: unknown; subtype?: unknown };
  const kind =
    typeof type === "string" && type !== "" ? type : UNKNOWN_RUNNER_TYPE;
  const runnerType =
    typeof subtype === "string" && subtype !== "" ? `${kind}/${subtype}` : kind;
  if (TRANSPORT.has(kind)) return { state, drafts: [] };
  if (kind === CONTEXT_FRAME_TYPE) return onContext(state, raw);
  switch (runnerType) {
    case "system/init":
      return onInit(state, raw);
    case "system/compact_boundary":
      return { state, drafts: [native(runnerType, raw, { compaction: true })] };
  }
  switch (kind) {
    case "assistant":
      return onAssistant(state, raw, input.ts);
    case "user":
      return onUser(state, raw, input.ts);
    case "result":
      return onResult(state, raw, prices);
    case "control_request":
      return onControlRequest(state, raw);
    default:
      return { state, drafts: [native(runnerType, raw)] };
  }
}

/**
 * A fresh mapper for one process segment. `prices` feed only the estimated-spend path, under every
 * name the stream gives a model (window.ts: a `[1m]` row prices its bare id too).
 */
export function createMapper(options: {
  readonly prices: readonly ModelRow[];
}): Mapper {
  const prices = streamPrices(options.prices);
  let state = START;
  return {
    map(input) {
      if (input.bytes.length === 0) return [];
      let stepped: Stepped;
      try {
        stepped = step(state, input, prices);
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
