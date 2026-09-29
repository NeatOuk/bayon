// The runner's stdout frames the mapper reads (SDK 0.3.269 shapes, `sdk.d.ts` / `sdk-tools.d.ts`;
// 0.3.283 only adds optional fields to them).
// Loose on purpose: only the fields the mapper uses are named, the rest pass through, so a frame
// that becomes `runner_native` is stored whole. Parse with `safeParse`; the mapper never throws.
import { z } from "zod";

const id = z.string().min(1);
const count = z.number().nonnegative();

/** A content block of any type. Specific blocks are parsed one by one. */
export const Block = z.looseObject({ type: z.string() });

/** The Messages API usage object carried by each assistant frame. */
export const ApiUsage = z.looseObject({
  input_tokens: count.optional(),
  output_tokens: count.optional(),
  cache_read_input_tokens: count.nullable().optional(),
  cache_creation_input_tokens: count.nullable().optional(),
});
export type ApiUsage = z.infer<typeof ApiUsage>;

/** `system/init`: written at the start of every run. */
export const InitFrame = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: id,
  model: z.string().optional(),
  cwd: z.string().optional(),
  tools: z.array(z.string()).optional(),
  mcp_servers: z
    .array(z.looseObject({ name: z.string(), status: z.string() }))
    .optional(),
  claude_code_version: z.string().optional(),
  permissionMode: z.string().optional(),
});

/** One assistant frame: usually a single block of a model step, keyed by `message.id`. */
export const AssistantFrame = z.looseObject({
  type: z.literal("assistant"),
  message: z.looseObject({
    id,
    model: z.string().optional(),
    content: z.array(Block),
    stop_reason: z.string().nullable().optional(),
    usage: ApiUsage.optional(),
  }),
  /** Set on a subagent's frames: the Task call that spawned it. */
  parent_tool_use_id: z.string().nullable().optional(),
  /** Set on a synthetic API-error message. */
  error: z.string().optional(),
});

/** A user frame: tool results for the model, with the tool's structured output alongside. */
export const UserFrame = z.looseObject({
  type: z.literal("user"),
  message: z.looseObject({
    content: z.union([z.string(), z.array(Block)]),
  }),
  parent_tool_use_id: z.string().nullable().optional(),
  tool_use_result: z.unknown().optional(),
});

/** A per-model running total in `result.modelUsage`. */
export const ModelUsage = z.looseObject({
  inputTokens: count,
  outputTokens: count,
  cacheReadInputTokens: count,
  cacheCreationInputTokens: count,
  costUSD: count,
});

/** `result/*`: exactly one per run, interrupted runs included. */
export const ResultFrame = z.looseObject({
  type: z.literal("result"),
  subtype: id,
  is_error: z.boolean(),
  num_turns: z.int().nonnegative(),
  duration_ms: count,
  total_cost_usd: count,
  modelUsage: z.record(z.string(), ModelUsage),
  terminal_reason: z.string().optional(),
  stop_reason: z.string().nullable().optional(),
  result: z.string().optional(),
  errors: z.array(z.string()).optional(),
  api_error_status: z.number().nullable().optional(),
  /** A process started with a JSON schema: the run's answer, which the adapter writes out. */
  structured_output: z.unknown().optional(),
});
export type ResultFrame = z.infer<typeof ResultFrame>;

/** A request from the runner to its host, e.g. asking to run a tool. */
export const ControlRequestFrame = z.looseObject({
  type: z.literal("control_request"),
  request_id: id,
  request: z.looseObject({
    subtype: z.string(),
    tool_name: z.string().optional(),
    input: z.unknown().optional(),
  }),
});

export const TextBlock = z.looseObject({
  type: z.literal("text"),
  text: z.string(),
});
export const ThinkingBlock = z.looseObject({
  type: z.literal("thinking"),
  thinking: z.string(),
});
export const ToolUseBlock = z.looseObject({
  type: z.literal("tool_use"),
  id,
  name: id,
  input: z.unknown(),
});
export const ToolResultBlock = z.looseObject({
  type: z.literal("tool_result"),
  tool_use_id: id,
  content: z.union([z.string(), z.array(Block)]).optional(),
  is_error: z.boolean().optional(),
});
export type ToolResultBlock = z.infer<typeof ToolResultBlock>;

/** Write / Edit / MultiEdit output (`FileWriteOutput`, `FileEditOutput`). */
export const FileEditOutput = z.looseObject({
  filePath: id,
  /** Write only: whether the file was created or overwritten. */
  type: z.string().optional(),
  content: z.string().optional(),
  structuredPatch: z
    .array(z.looseObject({ lines: z.array(z.string()) }))
    .optional(),
  gitDiff: z
    .looseObject({
      filename: id,
      status: z.string(),
      additions: z.int().nonnegative(),
      deletions: z.int().nonnegative(),
    })
    .optional(),
});

/** Bash input (`BashInput`): one shell command line, run by the tool's shell. */
export const BashInput = z.looseObject({ command: z.string().min(1) });

/**
 * Bash output (`BashOutput`): how the command ended. It names no exit code; only an error result
 * states one (`Exit code N`).
 */
export const BashOutput = z.looseObject({
  stdout: z.string(),
  stderr: z.string(),
  interrupted: z.boolean(),
  backgroundTaskId: z.string().optional(),
  /** Hit its timeout and was moved to the background. */
  timedOutAfterMs: z.number().optional(),
});

/** NotebookEdit input: the output names no path. */
export const NotebookEditInput = z.looseObject({ notebook_path: id });

/** TodoWrite output (`TodoWriteOutput`). */
export const TodoWriteOutput = z.looseObject({
  newTodos: z.array(
    z.looseObject({
      content: z.string(),
      status: z.enum(["pending", "in_progress", "completed"]),
    }),
  ),
});
