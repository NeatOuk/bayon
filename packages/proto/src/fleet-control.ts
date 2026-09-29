import { OperatorSettingKey, OperatorSettingsPatch } from "@bayon/core";
import { z } from "zod";

// The kill switch, the operator's whitelisted settings and the audit log (M4 §12.1).

const epochMs = z.int().nonnegative();

/** `POST /fleet/pause` and `POST /fleet/resume`: the state after the call. */
export const FleetPauseState = z.object({
  paused: z.boolean(),
  /** False when the fleet already was in that state: nothing was written or audited. */
  changed: z.boolean(),
  /** When `fleet.paused` was last written. */
  updated_at: epochMs,
});
export type FleetPauseState = z.infer<typeof FleetPauseState>;

/**
 * `POST /fleet/attention/:sessionId/ack`: the operator dismissed a finished session's
 * error from the attention strip, and it stays gone. Only an error exit can be dismissed; a stale
 * session is a live condition that clears itself, so the strip names its remedy instead.
 */
export const AttentionAck = z.object({
  session_id: z.string(),
  acked_at: epochMs,
  acked_by: z.string(),
});
export type AttentionAck = z.infer<typeof AttentionAck>;

/** One whitelisted setting (core OPERATOR_SETTINGS), as `GET /settings` shows it. */
export const OperatorSettingView = z.object({
  key: OperatorSettingKey,
  /** The stored value; null when there is no row or it is not a number. */
  value: z.number().nullable(),
  /** Whether the stored value keeps the whitelist's bounds. */
  valid: z.boolean(),
  /** The value the migrations seed. */
  default: z.number(),
  updated_at: epochMs.nullable(),
});
export type OperatorSettingView = z.infer<typeof OperatorSettingView>;

/** `GET /settings`, and the answer to `PUT /settings`: every whitelisted key, in its order. */
export const OperatorSettingsView = z.object({
  settings: z.array(OperatorSettingView),
  /**
   * `admission.require_certified`, read-only: a shell-only security control (core
   * SHELL_ONLY_SETTINGS), never in the whitelist. Null when missing or not a flag.
   */
  require_certified: z.boolean().nullable(),
});
export type OperatorSettingsView = z.infer<typeof OperatorSettingsView>;

/** `PUT /settings`: whitelisted keys only, at least one; any other key, or a value out of bounds, is 400. */
export const PutOperatorSettings = z.object({
  settings: OperatorSettingsPatch,
});
export type PutOperatorSettings = z.infer<typeof PutOperatorSettings>;

export const AUDIT_PAGE_DEFAULT_LIMIT = 50;
export const AUDIT_PAGE_MAX_LIMIT = 200;

/** An actor or action filter: exact, or a prefix when it ends in `*` (e.g. `session:*`, `mcp.*`). */
const AuditFilter = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^*]*\*?$/, "only a trailing * is allowed");

/** `GET /audit?before=&limit=&actor=&action=`: newest first; `before` is an exclusive row id. */
export const AuditQuery = z.object({
  before: z.coerce.number().pipe(z.int().positive()).optional(),
  limit: z.coerce
    .number()
    .pipe(z.int().min(1).max(AUDIT_PAGE_MAX_LIMIT))
    .default(AUDIT_PAGE_DEFAULT_LIMIT),
  actor: AuditFilter.optional(),
  action: AuditFilter.optional(),
});
export type AuditQuery = z.infer<typeof AuditQuery>;

/** One audit_log row. `payload` is the writer's digest of the attempt, never a body. */
export const AuditEntryView = z.object({
  id: z.int().positive(),
  ts: epochMs,
  actor: z.string(),
  action: z.string(),
  target_kind: z.string().nullable(),
  target_id: z.string().nullable(),
  payload: z.json().nullable(),
});
export type AuditEntryView = z.infer<typeof AuditEntryView>;

/** A page of audit rows. Ask again with `before = next_cursor` while `has_more`. */
export const AuditPage = z.object({
  items: z.array(AuditEntryView),
  next_cursor: z.int().positive().nullable(),
  has_more: z.boolean(),
});
export type AuditPage = z.infer<typeof AuditPage>;
