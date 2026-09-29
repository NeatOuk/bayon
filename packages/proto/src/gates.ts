import { BindingRole, GateState } from "@bayon/core";
import { z } from "zod";
import { GateView, TicketRef } from "./tickets.js";

// The /api/v1 gate, finding and role-binding DTOs (§12.1). The operator waives
// and reruns gates and resolves or waives findings here; sessions resolve through finding_resolve.

const epochMs = z.int().nonnegative();
const rowId = z.string().min(1).max(64);
const nullableText = z.string().nullable();
/** A waive reason or resolution note: shown forever (§10.3). */
const note = z.string().trim().min(1).max(500);

export const GATES_PAGE_DEFAULT_LIMIT = 50;
export const GATES_PAGE_MAX_LIMIT = 100;
/** The `gates` WS topic's snapshot: the review queue's first page. */
export const GATES_TOPIC_LIMIT = 100;

/**
 * `GET /gates?state=a,b&ticket=&project=&latest=0|1&cursor=&limit=`. `project` keeps the gates of
 * one project's tickets: a filter, so an unknown project is an empty page.
 */
export const GatesQuery = z.object({
  state: z
    .string()
    .transform((list) => list.split(",").filter((s) => s !== ""))
    .pipe(z.array(GateState).min(1))
    .optional(),
  ticket: TicketRef.optional(),
  project: rowId.optional(),
  /** Only the latest attempt of each (ticket, kind, repo); the default. */
  latest: z
    .enum(["0", "1"])
    .transform((flag) => flag === "1")
    .default(true),
  /** Opaque: the previous page's `next_cursor`. */
  cursor: z
    .string()
    .regex(/^\d{1,16}\.[0-9A-Za-z_-]{1,64}$/, "a cursor from a previous page")
    .optional(),
  limit: z.coerce
    .number()
    .pipe(z.int().min(1).max(GATES_PAGE_MAX_LIMIT))
    .default(GATES_PAGE_DEFAULT_LIMIT),
});
export type GatesQuery = z.infer<typeof GatesQuery>;

/** The ticket a gate reviews. */
export const GateTicket = z.object({
  id: z.string(),
  num: z.int().positive(),
  key: z.string(),
  title: z.string(),
  status: z.string(),
});
export type GateTicket = z.infer<typeof GateTicket>;

/** One row of GET /gates and of the `gates` topic: the gate without its findings, and its ticket. */
export const GateSummary = GateView.omit({ findings: true }).extend({
  ticket: GateTicket,
});
export type GateSummary = z.infer<typeof GateSummary>;

export const GatesPage = z.object({
  items: z.array(GateSummary),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});
export type GatesPage = z.infer<typeof GatesPage>;

/** `POST /gates/:id/waive` and `POST /findings/:id/waive`. */
export const WaiveRequest = z.strictObject({ reason: note });
export type WaiveRequest = z.infer<typeof WaiveRequest>;

/** `POST /findings/:id/resolve`: the fixing run (it must work the finding's ticket) and a note. */
export const ResolveFindingRequest = z.strictObject({
  run_id: rowId,
  note,
});
export type ResolveFindingRequest = z.infer<typeof ResolveFindingRequest>;

/** `POST /gates/:id/run`'s 202: the new attempt and the gate.run command the engine claims. */
export const GateRunAccepted = z.object({
  gate_id: z.string(),
  attempt: z.int().positive(),
  command_id: z.string(),
  session_id: z.string(),
});
export type GateRunAccepted = z.infer<typeof GateRunAccepted>;

/** A `role_bindings` row (§9.8): who runs what. Runner ids are rows, never code (Invariant 1). */
export const RoleBindingView = z.object({
  role: z.string(),
  runner_id: z.string(),
  model_tier: nullableText,
  executor_id: nullableText,
  profile_id: nullableText,
  fallback_runner_id: nullableText,
  require_distinct_from: nullableText,
  updated_by: nullableText,
  updated_at: epochMs,
  /** The model the binding runs on its runner: its tier, else its profile's; null when
   * neither names one (each agent's own profile decides). Certification is checked on it. */
  model_id: nullableText.default(null),
  model: nullableText.default(null),
});
export type RoleBindingView = z.infer<typeof RoleBindingView>;

export const RoleBindingsPage = z.object({ items: z.array(RoleBindingView) });
export type RoleBindingsPage = z.infer<typeof RoleBindingsPage>;

/** `PUT /role-bindings`: one role's binding, replaced whole. Certification is checked when a gate runs. */
export const PutRoleBinding = z.strictObject({
  role: BindingRole,
  runner_id: rowId,
  model_tier: z.string().min(1).max(32).nullable().optional(),
  executor_id: rowId.nullable().optional(),
  profile_id: rowId.nullable().optional(),
  fallback_runner_id: rowId.nullable().optional(),
  require_distinct_from: BindingRole.nullable().optional(),
});
export type PutRoleBinding = z.infer<typeof PutRoleBinding>;
