// The records the turn host's stdout carries: `opencode acp` 1.18.32's
// newline-delimited JSON-RPC 2.0 (packages/opencode/src/acp/*.ts @ v1.18.32), relayed byte for
// byte, and the host's own five frames. Loose objects: a field opencode adds is kept, a field it
// drops fails the frame and the line lands as runner_native (Invariant 4).
import { z } from "zod";

const id = z.string().min(1);
const count = z.number().int().nonnegative();

// --- JSON-RPC envelopes ---------------------------------------------------------------------------

const RpcId = z.union([z.number().int(), z.string()]);

/** An agent → client notification (no id). */
export const Notification = z.looseObject({
  jsonrpc: z.literal("2.0"),
  method: id,
  params: z.unknown().optional(),
});

/** An agent → client request (an id and a method): the host answers it. */
export const AgentRequest = z.looseObject({
  jsonrpc: z.literal("2.0"),
  id: RpcId,
  method: id,
  params: z.unknown().optional(),
});

export const RpcError = z.looseObject({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});

/** A response to one of the host's requests: its result, or its error. */
export const ResultResponse = z.looseObject({
  jsonrpc: z.literal("2.0"),
  id: RpcId,
  result: z.unknown(),
});
export const ErrorResponse = z.looseObject({
  jsonrpc: z.literal("2.0"),
  id: RpcId,
  error: RpcError,
});

// --- session/update --------------------------------------------------------------------------------

export const SessionUpdate = z.looseObject({
  sessionId: id,
  update: z.looseObject({ sessionUpdate: id }),
});

const TextContent = z.looseObject({
  type: z.literal("text"),
  text: z.string(),
});

/** `agent_message_chunk` / `agent_thought_chunk`: one streamed piece of a message's text. */
export const ChunkUpdate = z.looseObject({
  sessionUpdate: z.enum(["agent_message_chunk", "agent_thought_chunk"]),
  messageId: id.optional(),
  content: TextContent,
});

const ToolStatus = z.enum(["pending", "in_progress", "completed", "failed"]);

/** `tool_call`: opencode sends it `pending`, with the tool's id as its title (acp/tool.ts). */
export const ToolCall = z.looseObject({
  sessionUpdate: z.literal("tool_call"),
  toolCallId: id,
  title: id,
  status: ToolStatus.optional(),
  rawInput: z.unknown().optional(),
});

export const ToolCallUpdate = z.looseObject({
  sessionUpdate: z.literal("tool_call_update"),
  toolCallId: id,
  status: ToolStatus.optional(),
  title: z.string().optional(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
  content: z.array(z.looseObject({ type: id })).optional(),
});

/** ACP's `plan` (opencode 1.18.32 sends none; mapped should a later patch start to). */
export const PlanUpdate = z.looseObject({
  sessionUpdate: z.literal("plan"),
  entries: z.array(
    z.looseObject({
      content: z.string(),
      status: z.enum(["pending", "in_progress", "completed"]),
    }),
  ),
});

/** Known updates that map to nothing: the raw log keeps them. */
export const QUIET_UPDATES: readonly string[] = [
  "available_commands_update",
  "config_option_update",
  "current_mode_update",
  "session_info_update",
  "usage_update",
  "user_message_chunk",
];

// --- tool outputs opencode puts in rawOutput --------------------------------------------------------

export const BashOutput = z.looseObject({
  output: z.string().optional(),
  metadata: z
    .looseObject({ exit: z.number().int().nullable().optional() })
    .optional(),
});

export const WriteOutput = z.looseObject({
  metadata: z.looseObject({ filepath: id, exists: z.boolean() }),
});

export const EditOutput = z.looseObject({
  metadata: z.looseObject({
    filediff: z.looseObject({
      file: id,
      additions: count,
      deletions: count,
    }),
  }),
});

export const PatchOutput = z.looseObject({
  metadata: z.looseObject({
    files: z.array(
      z.looseObject({
        filePath: id,
        type: z.enum(["add", "update", "delete", "move"]),
        additions: count.optional(),
        deletions: count.optional(),
        movePath: id.optional(),
      }),
    ),
  }),
});

export const TodoOutput = z.looseObject({
  metadata: z.looseObject({
    todos: z.array(
      z.looseObject({
        content: z.string(),
        status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
      }),
    ),
  }),
});

export const ErrorOutput = z.looseObject({ error: z.string() });
export const TextOutput = z.looseObject({ output: z.string() });

// --- the prompt's result -----------------------------------------------------------------------------

export const PromptUsage = z.looseObject({
  inputTokens: count,
  outputTokens: count,
  totalTokens: count.optional(),
  thoughtTokens: count.optional(),
  cachedReadTokens: count.optional(),
  cachedWriteTokens: count.optional(),
});
export type PromptUsage = z.infer<typeof PromptUsage>;

export const PromptResult = z.looseObject({
  stopReason: id,
  usage: PromptUsage.optional(),
});

/** A failed prompt's `data` (acp/error.ts `ServiceFailureError`). */
export const PromptErrorData = z.looseObject({
  service: z.string().optional(),
  errorName: z.string().optional(),
});

// --- the turn host's frames (design §3): the only non-runner lines in the raw log ----------------------

export const HOST_START = "frm.host.start";
export const HOST_TURN = "frm.host.turn";
export const HOST_OUTPUT = "frm.host.output";
export const HOST_INTERRUPT = "frm.host.interrupt";
export const HOST_EXIT = "frm.host.exit";
export const HOST_FRAMES: readonly string[] = [
  HOST_START,
  HOST_TURN,
  HOST_OUTPUT,
  HOST_INTERRUPT,
  HOST_EXIT,
];

/** Written once the ACP handshake is done: the session is opencode's `ses_…` id. */
export const HostStart = z.looseObject({
  type: z.literal(HOST_START),
  v: z.literal(1),
  runner_session_id: id,
  resumed: z.boolean(),
  model: id,
});
export type HostStart = z.infer<typeof HostStart>;

/** Written before each `session/prompt`: `rpc_id` names the response that ends the run. */
export const HostTurn = z.looseObject({
  type: z.literal(HOST_TURN),
  run_id: id,
  rpc_id: RpcId,
  model: id,
  output: z.boolean(),
});

/** The structured-output check (design §6), written before the prompt response is relayed. */
export const HostOutput = z.looseObject({
  type: z.literal(HOST_OUTPUT),
  run_id: id,
  ok: z.boolean(),
  path: z.string().nullable(),
  issues: z.array(z.string()),
});

/** Written just before the host sends `session/cancel`. */
export const HostInterrupt = z.looseObject({
  type: z.literal(HOST_INTERRUPT),
  run_id: id,
});

/** opencode exited (after its stdout closed). Forensics: nothing reads `code` for an outcome. */
export const HostExit = z.looseObject({
  type: z.literal(HOST_EXIT),
  code: z.number().int().nullable(),
  signal: z.string().nullable(),
});
