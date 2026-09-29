import {
  ComplexityFacts,
  ModelTier,
  NextStep,
  RefusalReason,
  SessionState,
  TicketStatus,
  WAIT_REASON_MAX,
} from "@bayon/core";
import { z } from "zod";

// The /api/v1/tickets DTOs (§12.1; M1 contracts 3 and 8). `:ref` is a ticket's ULID or its num.
// Writes carry the version they read in `If-Match`; every ticket response carries it as `ETag`.

const count = z.int().nonnegative();
const epochMs = z.int().nonnegative();
const nullableText = z.string().nullable();
const note = z.string().trim().min(1).max(2_000);
const title = z.string().trim().min(1).max(200);
const markdown = z.string().max(200_000);
const priority = z.int().min(1).max(5);
const rowId = z.string().min(1).max(64);

export const ETAG_HEADER = "ETag";
export const IF_MATCH_HEADER = "If-Match";

/** A ticket's version as a strong ETag, e.g. `"7"`. */
export const etagOf = (version: number): string => `"${version}"`;

export const TicketType = z.enum([
  "bug",
  "feature",
  "chore",
  "docs",
  "spike",
  "followup",
]);
export type TicketType = z.infer<typeof TicketType>;

/** `:ref`: a ticket's ULID, or its number. */
export const TicketRef = z
  .string()
  .regex(
    /^(?:[1-9][0-9]{0,14}|[0-9A-HJKMNP-TV-Z]{26})$/,
    "a ticket ULID or number",
  );

const BAD_SEGMENTS = new Set(["", ".", ".."]);

/** A plan artifact's path: relative, POSIX, inside the repo (checked again on disk). */
export const PlanPath = z
  .string()
  .max(256)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.split("/").some((segment) => BAD_SEGMENTS.has(segment)),
    "a relative POSIX path inside the repo, without empty, . or .. segments",
  );

/** A `tickets` row as the API serves it (derived cost columns live in `economics`). */
export const TicketView = z.object({
  id: z.string(),
  /** `tickets.key_prefix` + num (M1 amendment 13). */
  key: z.string(),
  num: z.int().positive(),
  title: z.string(),
  body_md: z.string(),
  acceptance_md: z.string(),
  type: TicketType,
  status: TicketStatus,
  priority: z.int(),
  needs_human: z.boolean(),
  /**
   * Its open questions to the operator, counted live: the supervisor's own requests
   * never write needs_human, so "needs human" is the flag or this above 0.
   */
  open_questions: count,
  non_trivial: z.boolean(),
  complexity_score: z.int(),
  complexity_tier: z.string(),
  /** `complexity_factors_json`, parsed: {facts, contributions, rubric_hash} (§8.8). */
  complexity_factors: z.unknown().nullable(),
  workspace_id: nullableText,
  epic_id: nullableText,
  parent_ticket_id: nullableText,
  origin: z.string(),
  origin_ref: nullableText,
  blocked_reason: nullableText,
  unblock_condition: nullableText,
  owner_session_id: nullableText,
  branch: nullableText,
  plan_path: nullableText,
  pr_url: nullableText,
  split_depth: count,
  children_total: count,
  children_done: count,
  version: z.int().positive(),
  created_at: epochMs,
  updated_at: epochMs,
  closed_at: epochMs.nullable(),
});
export type TicketView = z.infer<typeof TicketView>;

/**
 * One board card, with its round count: v_ticket_economics' (M3 amendment b), never stored. Its
 * origin and ref let a mirrored ticket's card link its Jira issue. `waiting_on_you` and
 * `waiting_reason` say whether its next step waits on the operator, and why in a few words
 *: read for the whole page in one pass, never the ticket page's full next step per card.
 */
export const TicketSummary = TicketView.pick({
  id: true,
  key: true,
  num: true,
  title: true,
  type: true,
  status: true,
  priority: true,
  needs_human: true,
  open_questions: true,
  complexity_tier: true,
  owner_session_id: true,
  workspace_id: true,
  origin: true,
  origin_ref: true,
  version: true,
  updated_at: true,
}).extend({
  review_rounds: count,
  waiting_on_you: z.boolean(),
  waiting_reason: z.string().min(1).max(WAIT_REASON_MAX).nullable(),
});
export type TicketSummary = z.infer<typeof TicketSummary>;

export const TICKETS_PAGE_DEFAULT_LIMIT = 50;
export const TICKETS_PAGE_MAX_LIMIT = 100;

/** `GET /tickets?status=a,b&needs_human=0|1&tier=&workspace_id=&q=&cursor=&limit=`. */
export const TicketsQuery = z.object({
  status: z
    .string()
    .transform((list) => list.split(",").filter((s) => s !== ""))
    .pipe(z.array(TicketStatus).min(1))
    .optional(),
  needs_human: z
    .enum(["0", "1"])
    .transform((flag) => flag === "1")
    .optional(),
  tier: ModelTier.optional(),
  /** One project's tickets: a project is its workspace. */
  workspace_id: rowId.optional(),
  /** Words that must all appear in the title or body (tickets_fts). */
  q: z.string().trim().min(1).max(200).optional(),
  /** Exclusive: the last `num` of the previous page. */
  cursor: z.coerce.number().pipe(count).optional(),
  limit: z.coerce
    .number()
    .pipe(z.int().min(1).max(TICKETS_PAGE_MAX_LIMIT))
    .default(TICKETS_PAGE_DEFAULT_LIMIT),
});
export type TicketsQuery = z.infer<typeof TicketsQuery>;

export const TicketsPage = z.object({
  items: z.array(TicketSummary),
  next_cursor: count,
  has_more: z.boolean(),
});
export type TicketsPage = z.infer<typeof TicketsPage>;

/** `POST /tickets`. The status is always `backlog`; complexity is scored from the facts. */
export const CreateTicketRequest = z.strictObject({
  title,
  type: TicketType,
  body_md: markdown.optional(),
  acceptance_md: markdown.optional(),
  priority: priority.optional(),
  workspace_id: rowId.optional(),
  epic_id: rowId.optional(),
  parent_ticket_id: rowId.optional(),
  plan_path: PlanPath.optional(),
  needs_human: z.boolean().optional(),
  complexity_facts: ComplexityFacts.optional(),
});
export type CreateTicketRequest = z.infer<typeof CreateTicketRequest>;

/** `PATCH /tickets/:ref` (If-Match). Status moves only through /transition; null clears. */
export const PatchTicketRequest = z
  .strictObject({
    title: title.optional(),
    type: TicketType.optional(),
    body_md: markdown.optional(),
    acceptance_md: markdown.optional(),
    priority: priority.optional(),
    workspace_id: rowId.nullable().optional(),
    epic_id: rowId.nullable().optional(),
    plan_path: PlanPath.nullable().optional(),
    /** http(s) only: the GUI links it, and `z.url()` alone accepts `javascript:`. */
    pr_url: z
      .url({ protocol: /^https?$/ })
      .max(2_000)
      .nullable()
      .optional(),
    branch: z.string().min(1).max(200).nullable().optional(),
    owner_session_id: rowId.nullable().optional(),
    needs_human: z.boolean().optional(),
    /** Replaces the declared facts and rescores (§8.8, amendment 11). */
    complexity_facts: ComplexityFacts.optional(),
  })
  .refine(
    (patch) => Object.keys(patch).length > 0,
    "a patch changes at least one field",
  );
export type PatchTicketRequest = z.infer<typeof PatchTicketRequest>;

/** `POST /tickets/:ref/transition` (If-Match). */
export const TransitionRequest = z
  .strictObject({
    to: TicketStatus,
    reason: note.optional(),
    /** The operator's QA override (§3.2): skips a missing qa_run, and is recorded forever. */
    override_note: note.optional(),
    blocked_reason: note.optional(),
    unblock_condition: note.optional(),
  })
  .refine(
    (body) =>
      body.to !== "blocked" ||
      (body.blocked_reason !== undefined &&
        body.unblock_condition !== undefined),
    {
      message: "blocking needs blocked_reason and unblock_condition",
      path: ["to"],
    },
  );
export type TransitionRequest = z.infer<typeof TransitionRequest>;

/** One action the detail view may offer, and why not when it may not (contract 8). */
export const TransitionOption = z.object({
  to: TicketStatus,
  rule: z.string(),
  allowed: z.boolean(),
  reason: RefusalReason.optional(),
  detail: z.string().optional(),
  /** Checked only on submit (the git diff), so the POST may still refuse. */
  deferred: z.array(z.literal("no_source_changes")).readonly().optional(),
  /** Notes the form should collect. */
  input: z
    .array(z.enum(["reason", "override_note"]))
    .readonly()
    .optional(),
});
export type TransitionOption = z.infer<typeof TransitionOption>;

export const TicketEventView = z.object({
  id: count,
  ticket_id: z.string(),
  ts: epochMs,
  actor_kind: z.string(),
  actor_id: nullableText,
  kind: z.string(),
  from_status: nullableText,
  to_status: nullableText,
  reason: nullableText,
  /** `payload_json`, parsed: a transition's rule and evidence refs. */
  payload: z.unknown(),
});
export type TicketEventView = z.infer<typeof TicketEventView>;

export const TicketEventsQuery = z.object({
  since: z.coerce.number().pipe(count).default(0),
  limit: z.coerce.number().pipe(z.int().min(1).max(1_000)).default(100),
});
export type TicketEventsQuery = z.infer<typeof TicketEventsQuery>;

export const TicketEventsPage = z.object({
  items: z.array(TicketEventView),
  next_cursor: count,
  has_more: z.boolean(),
});
export type TicketEventsPage = z.infer<typeof TicketEventsPage>;

export const TicketLinkView = z.object({
  kind: z.string(),
  url: nullableText,
  target_ticket_id: nullableText,
  created_at: epochMs,
});
export type TicketLinkView = z.infer<typeof TicketLinkView>;

export const FindingView = z.object({
  id: z.string(),
  severity: z.enum(["blocker", "major", "minor", "nit"]),
  category: nullableText,
  file: nullableText,
  line: z.int().nullable(),
  summary: z.string(),
  detail_md: nullableText,
  status: z.string(),
  resolution_note: nullableText,
  created_at: epochMs,
  // M3: the fixing run and who resolved it; or who waived it and why, shown forever.
  resolved_by_run_id: nullableText,
  resolved_by: nullableText,
  resolved_at: epochMs.nullable(),
  waived_by: nullableText,
  waive_reason: nullableText,
});
export type FindingView = z.infer<typeof FindingView>;

export const GateView = z.object({
  id: z.string(),
  kind: z.string(),
  state: z.string(),
  attempt: z.int().positive(),
  repo_id: nullableText,
  required: z.boolean(),
  findings_total: count,
  findings_unresolved: count,
  waive_reason: nullableText,
  decided_at: epochMs.nullable(),
  // M3: the reviewer session (reviewer_session_id, else the newest with
  // sessions.gate_id: the live reviewer), when the round opened, why it failed, and its evidence.
  session_id: nullableText,
  started_at: epochMs.nullable(),
  reason: nullableText,
  /** `evidence_json`, parsed: core's StoredGateEvidence. */
  evidence: z.unknown().nullable(),
  findings: z.array(FindingView),
});
export type GateView = z.infer<typeof GateView>;

export const HandoffView = z.object({
  id: z.string(),
  reason: z.string(),
  from_session_id: nullableText,
  to_session_id: nullableText,
  quality: z.string(),
  goal_line: nullableText,
  accepted_at: epochMs.nullable(),
  created_at: epochMs,
});
export type HandoffView = z.infer<typeof HandoffView>;

export const TicketExportView = z.object({
  target: z.string(),
  path: nullableText,
  url: nullableText,
  external_key: nullableText,
  state: z.string(),
  content_hash: nullableText,
  last_synced_at: epochMs.nullable(),
  error: nullableText,
});
export type TicketExportView = z.infer<typeof TicketExportView>;

/** A `v_ticket_economics` row (§8.9; M1 amendment 9: derived, never stored). */
export const TicketEconomics = z.object({
  cost_usd: z.number().nonnegative(),
  cost_wasted_usd: z.number().nonnegative(),
  review_rounds: count,
  /** The sizing signal (§7.5): phase-boundary hand-offs are not counted here. */
  handoff_count: count,
  /** Phase boundaries crossed (§7.1): progress, not a sign the ticket was too big. */
  phase_handoff_count: count,
  sessions: count,
  tokens: count,
  cache_ratio: z.number().nullable(),
});
export type TicketEconomics = z.infer<typeof TicketEconomics>;

/** What a detail view shows beside the ticket itself. */
export const TicketExtras = z.object({
  links: z.array(TicketLinkView),
  gates: z.array(GateView),
  handoffs: z.array(HandoffView),
  exports: z.array(TicketExportView),
  economics: TicketEconomics,
});
export type TicketExtras = z.infer<typeof TicketExtras>;

/** `GET /tickets/:ref/next` (§12.1): who the ticket waits on, why, and what moves it. */
export { NextStep };

/**
 * Who holds the ticket, read with its next step so the page says one thing: its live
 * session (a reviewer's is never its holder), or the spawn staffing queued before that session's
 * row exists. Null: nothing holds it and nothing is starting.
 */
export const TicketHolder = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("session"),
    agent: z.string(),
    session_id: z.string(),
    state: SessionState,
  }),
  z.object({ kind: z.literal("queued"), agent: z.string() }),
]);
export type TicketHolder = z.infer<typeof TicketHolder>;

/**
 * A live gate reviewer's session on the ticket: never its holder, but staffing refuses
 * while one is live, so the page offers no staffing until it ends.
 */
export const TicketReviewing = z.object({
  agent: z.string(),
  session_id: z.string(),
});
export type TicketReviewing = z.infer<typeof TicketReviewing>;

/** `GET /tickets/:ref` (contract 8). */
export const TicketDetail = TicketExtras.extend({
  ticket: TicketView,
  /** For the caller, from the laws themselves (core allowedTransitions). */
  transitions: z.array(TransitionOption),
  /** Its next step, for the operator: the same value as `GET /tickets/:ref/next`. */
  next_step: NextStep,
  /** Who holds it, from the same read as `next_step`; an answer from before it has none. */
  holder: TicketHolder.nullable().default(null),
  /** A reviewer still live on it, from the same read; an answer from before it has none. */
  reviewing: TicketReviewing.nullable().default(null),
  /** The transition log from the start; page on with GET /tickets/:ref/events?since=. */
  events: TicketEventsPage,
});
export type TicketDetail = z.infer<typeof TicketDetail>;
