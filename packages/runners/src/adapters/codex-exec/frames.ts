// The records the turn host's stdout carries: Codex's `exec --json` events,
// from codex-rs/exec/src/exec_events.rs @ rust-v0.154.0, and the host's own four frames. Loose
// objects: a field Codex adds is kept, a field it drops fails the frame and lands as runner_native.
import { z } from "zod";

const count = z.int().nonnegative();
const id = z.string().min(1);

/** `turn.completed.usage`: the thread's running totals (ThreadTokenUsage.total, fact 3). */
export const CodexUsage = z.looseObject({
  input_tokens: count,
  cached_input_tokens: count,
  cache_write_input_tokens: count.optional(),
  output_tokens: count,
  reasoning_output_tokens: count.optional(),
});
export type CodexUsage = z.infer<typeof CodexUsage>;

export const ThreadStarted = z.looseObject({
  type: z.literal("thread.started"),
  thread_id: id,
});
export const TurnStarted = z.looseObject({ type: z.literal("turn.started") });
export const TurnCompleted = z.looseObject({
  type: z.literal("turn.completed"),
  usage: CodexUsage,
});
export const TurnFailed = z.looseObject({
  type: z.literal("turn.failed"),
  error: z.looseObject({ message: z.string() }),
});
/** A top-level `error`: every server error, retries included; never ends a turn (fact 4). */
export const StreamError = z.looseObject({
  type: z.literal("error"),
  message: z.string(),
});

export const ITEM_EVENTS = ["item.started", "item.updated", "item.completed"];
export const ItemEvent = z.looseObject({
  type: z.enum(["item.started", "item.updated", "item.completed"]),
  item: z.looseObject({ id, type: id }),
});
export type ItemEventType = z.infer<typeof ItemEvent>["type"];

const item = <T extends string>(type: T) =>
  z.looseObject({ id, type: z.literal(type) });

export const AgentMessageItem = item("agent_message").extend({
  text: z.string(),
});
export const ReasoningItem = item("reasoning").extend({ text: z.string() });
export const CommandExecutionItem = item("command_execution").extend({
  command: z.string(),
  aggregated_output: z.string(),
  exit_code: z.int().nullable(),
  status: z.enum(["in_progress", "completed", "failed", "declined"]),
});
export const FileChangeItem = item("file_change").extend({
  changes: z.array(
    z.looseObject({ path: id, kind: z.enum(["add", "delete", "update"]) }),
  ),
  status: z.enum(["in_progress", "completed", "failed"]),
});
export const McpToolCallItem = item("mcp_tool_call").extend({
  server: id,
  tool: id,
  arguments: z.unknown().optional(),
  status: z.enum(["in_progress", "completed", "failed"]),
});
/** A failed `mcp_tool_call`'s `error` (McpToolCallItemError): not part of the item's frame. */
export const McpToolCallError = z.looseObject({ message: z.string().min(1) });
export const WebSearchItem = item("web_search").extend({ query: z.string() });
export const TodoListItem = item("todo_list").extend({
  items: z.array(z.looseObject({ text: z.string(), completed: z.boolean() })),
});
export const ErrorItem = item("error").extend({ message: z.string() });

// --- the turn host's frames (design §2): the only non-runner lines in the raw log ---------------

export const HOST_START = "frm.host.start";
export const HOST_TURN = "frm.host.turn";
export const HOST_INTERRUPT = "frm.host.interrupt";
export const HOST_EXIT = "frm.host.exit";

/** The first line of every host: thread state from <home>/thread.json, for adopt and billing. */
export const HostStart = z.looseObject({
  type: z.literal(HOST_START),
  v: z.literal(1),
  runner_session_id: id,
  thread_id: id.nullable(),
  usage_total: CodexUsage.nullable(),
});
export type HostStart = z.infer<typeof HostStart>;

/** Written before each Codex process starts, with its argv (no secret: test 11 reads it here). */
export const HostTurn = z.looseObject({
  type: z.literal(HOST_TURN),
  run_id: id,
  model: id,
  resume: z.boolean(),
  argv: z.array(z.string()).min(1),
});

/** Written just before the host sends Codex SIGINT. */
export const HostInterrupt = z.looseObject({
  type: z.literal(HOST_INTERRUPT),
  run_id: id,
});

/** Written after Codex exited and its stdout closed. Forensics: nothing reads `code` for an outcome. */
export const HostExit = z.looseObject({
  type: z.literal(HOST_EXIT),
  run_id: id,
  code: z.int().nullable(),
  signal: z.string().nullable(),
});
