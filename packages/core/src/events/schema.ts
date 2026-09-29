import { z } from "zod";
import { ContextTotals } from "../context/frame.js";
import { FrmError } from "../errors.js";
import { RunOutcome } from "../states.js";

/** The canonical event kinds of §5.2. */
export const EventKind = z.enum([
  "session_init",
  "turn_start",
  "turn_end",
  "assistant_text",
  "reasoning",
  "tool_call",
  "tool_result",
  "file_change",
  "command",
  "todo",
  "mcp_call",
  "approval_request",
  "usage",
  "error",
  "terminal",
  "runner_native",
]);
export type EventKind = z.infer<typeof EventKind>;

/** Epoch millis, UTC. */
export const EpochMs = z.int().nonnegative();

const count = z.int().nonnegative();
const name = z.string().min(1);
const costUsd = z.number().nonnegative();

/** Token counts, named after the `spend` columns. */
export const Usage = z.object({
  tokens_in: count,
  tokens_out: count,
  tokens_cache_read: count,
  tokens_cache_write: count,
});
export type Usage = z.infer<typeof Usage>;

/**
 * The `events` columns (§4) that every canonical event carries. The supervisor adds `session_id`,
 * `raw_offset` and the payload-on-disk columns at ingest. Optional fields are absent, never null.
 */
const Envelope = z.object({
  ts: EpochMs,
  run_id: name.optional(),
  /** The runner's own event type, verbatim, for forensics. */
  runner_type: name,
  tool_name: name.optional(),
  status: name.optional(),
  exit_code: z.int().optional(),
  /** A human-readable projection. */
  text: z.string().optional(),
});

// Payloads keep the fields they do not name, so a runner's extras are stored, not dropped.
const NoPayload = z.looseObject({});

/** The §5.2 taxonomy, discriminated on `kind`. Parse untrusted input with `parseCanonical`. */
export const CanonicalEvent = z.discriminatedUnion("kind", [
  Envelope.extend({
    kind: z.literal("session_init"),
    payload: z.looseObject({
      runner_session_id: name,
      model: name.optional(),
      cwd: name.optional(),
      tools: z.array(name).optional(),
      mcp_servers: z.array(z.looseObject({ name, status: name })).optional(),
      /** The session's MCP tools the runner exposes, by wire name (runner-neutral). */
      mcp_tools: z.array(name).optional(),
      /** Every other tool it exposes, by the runner's name: none for an MCP-only spawn. */
      builtin_tools: z.array(name).optional(),
    }),
  }),
  Envelope.extend({ kind: z.literal("turn_start"), payload: NoPayload }),
  Envelope.extend({
    kind: z.literal("turn_end"),
    payload: z.looseObject({
      usage: Usage.optional(),
      stop_reason: name.optional(),
    }),
  }),
  Envelope.extend({
    kind: z.literal("assistant_text"),
    text: z.string(),
    payload: NoPayload,
  }),
  Envelope.extend({
    kind: z.literal("reasoning"),
    text: z.string(),
    payload: z.looseObject({ summary_only: z.boolean().optional() }),
  }),
  Envelope.extend({
    kind: z.literal("tool_call"),
    tool_name: name,
    payload: z.looseObject({ call_id: name, input: z.unknown().optional() }),
  }),
  Envelope.extend({
    kind: z.literal("tool_result"),
    status: z.enum(["ok", "error"]),
    payload: z.looseObject({
      call_id: name,
      output_path: name.optional(),
      head: z.string().optional(),
      tail: z.string().optional(),
    }),
  }),
  Envelope.extend({
    kind: z.literal("file_change"),
    payload: z.looseObject({
      repo: name.optional(),
      path: name,
      change: z.enum(["add", "modify", "delete"]),
      lines_added: count.optional(),
      lines_removed: count.optional(),
    }),
  }),
  Envelope.extend({
    kind: z.literal("command"),
    payload: z.looseObject({
      argv: z.array(z.string()).min(1),
      cwd: name.optional(),
      duration_ms: count.optional(),
      output_path: name.optional(),
    }),
  }),
  Envelope.extend({
    kind: z.literal("todo"),
    payload: z.looseObject({
      items: z.array(
        z.looseObject({
          text: z.string(),
          status: z.enum(["pending", "in_progress", "completed"]),
        }),
      ),
    }),
  }),
  Envelope.extend({
    kind: z.literal("mcp_call"),
    tool_name: name,
    payload: z.looseObject({ server: name, args_digest: name.optional() }),
  }),
  Envelope.extend({
    kind: z.literal("approval_request"),
    tool_name: name,
    payload: z.looseObject({
      input: z.unknown().optional(),
      risk: name.optional(),
    }),
  }),
  Envelope.extend({
    kind: z.literal("usage"),
    payload: z.looseObject({ usage: Usage, cost_usd: costUsd.optional() }),
  }),
  Envelope.extend({ kind: z.literal("error"), payload: FrmError.loose() }),
  Envelope.extend({
    kind: z.literal("terminal"),
    payload: z.looseObject({
      outcome: RunOutcome,
      error: FrmError.optional(),
      usage: Usage.optional(),
      cost_usd: costUsd.optional(),
      /** The run's context compression totals (M12): absent when compression was off. */
      context: ContextTotals.optional(),
    }),
  }),
  Envelope.extend({
    kind: z.literal("runner_native"),
    payload: z.looseObject({
      raw: z.unknown(),
      issues: z.array(z.string()).optional(),
    }),
  }),
]);
export type CanonicalEvent = z.infer<typeof CanonicalEvent>;
export type CanonicalEventOf<K extends EventKind> = Extract<
  CanonicalEvent,
  { kind: K }
>;
