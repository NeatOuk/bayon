import {
  ExitReason,
  SessionState,
  TimelineKindFilter,
  TimelineSource,
} from "@bayon/core";
import { z } from "zod";

// A project's history: `GET /projects/:id/timeline`, its export, and
// `GET /agents/:id/sessions`, the backend of the GUI's History view and per-agent replay. The
// timeline is read-time, one UNION over the tables that hold each row; raw tool-level events stay
// out (a session's own replay is `GET /sessions/:id/events`).

const count = z.int().nonnegative();
const epochMs = z.int().nonnegative();
const nullableText = z.string().nullable();
const queryMs = z.coerce.number().pipe(epochMs);

export const TIMELINE_PAGE_DEFAULT_LIMIT = 50;
export const TIMELINE_PAGE_MAX_LIMIT = 200;
export const AGENT_SESSIONS_PAGE_DEFAULT_LIMIT = 50;
export const AGENT_SESSIONS_PAGE_MAX_LIMIT = 200;

/** `?kind=a,b` or `?kind=a&kind=b`. */
const kindList = z
  .union([z.string(), z.array(z.string())])
  .transform((value) =>
    [value]
      .flat()
      .flatMap((part) => part.split(","))
      .filter((kind) => kind !== ""),
  )
  .pipe(z.array(TimelineKindFilter).min(1).max(50));

/** An opaque cursor: the previous page's `next_cursor`, handed back unread. */
const Cursor = z.string().min(1).max(512);

const TimelineFilters = z.object({
  kind: kindList.optional(),
  /** An agent's id: the rows that name it. */
  agent: z.string().min(1).max(64).optional(),
  /** A ticket's key, `#n`, `n` or id. */
  ticket: z.string().trim().min(1).max(64).optional(),
  /** ts >= from (epoch ms). */
  from: queryMs.optional(),
  /** ts < to (epoch ms). */
  to: queryMs.optional(),
  /** A case-insensitive text match on summary and actor; `%` and `_` match only themselves. */
  q: z.string().min(1).max(200).optional(),
});

const fromBeforeTo = (f: { from?: number; to?: number }): boolean =>
  f.from === undefined || f.to === undefined || f.from < f.to;
const FROM_BEFORE_TO = { message: "from must be before to", path: ["from"] };

/** `GET /projects/:id/timeline?cursor=&limit=&kind=&agent=&ticket=&from=&to=&q=`. */
export const TimelineQuery = TimelineFilters.extend({
  cursor: Cursor.optional(),
  limit: z.coerce
    .number()
    .pipe(z.int().min(1).max(TIMELINE_PAGE_MAX_LIMIT))
    .default(TIMELINE_PAGE_DEFAULT_LIMIT),
}).refine(fromBeforeTo, FROM_BEFORE_TO);
export type TimelineQuery = z.infer<typeof TimelineQuery>;

export const TimelineExportFormat = z.enum(["jsonl", "csv"]);
export type TimelineExportFormat = z.infer<typeof TimelineExportFormat>;

/** `GET /projects/:id/timeline/export?format=jsonl|csv` plus the timeline's filters: every row. */
export const TimelineExportQuery = TimelineFilters.extend({
  format: TimelineExportFormat.default("jsonl"),
}).refine(fromBeforeTo, FROM_BEFORE_TO);
export type TimelineExportQuery = z.infer<typeof TimelineExportQuery>;

/**
 * One row of a project's history. `kind` is `<source>.<detail>`; `key` is unique within its source.
 * `summary` is one line built server-side (at most 300 characters). `payload` is the stored JSON of
 * an `audit` or `ticket` row, only when it is 8 KB or less (Invariant 9); a larger one is left out,
 * and the source row, by `key`, still holds it.
 */
export const TimelineEntry = z.object({
  source: TimelineSource,
  key: z.string(),
  ts: epochMs,
  kind: z.string(),
  /** `operator`, `session:<id>`, `supervisor`, or another writer's `<kind>:<id>`. */
  actor: z.string(),
  agent_id: nullableText,
  ticket_id: nullableText,
  ticket_key: nullableText,
  session_id: nullableText,
  summary: z.string(),
  payload: z.json().optional(),
});
export type TimelineEntry = z.infer<typeof TimelineEntry>;

/** A page of the timeline, newest first. Ask again with `cursor = next_cursor` while `has_more`. */
export const TimelinePage = z.object({
  items: z.array(TimelineEntry),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});
export type TimelinePage = z.infer<typeof TimelinePage>;

/** `GET /agents/:id/sessions?cursor=&limit=`: newest first. */
export const AgentSessionsQuery = z.object({
  cursor: Cursor.optional(),
  limit: z.coerce
    .number()
    .pipe(z.int().min(1).max(AGENT_SESSIONS_PAGE_MAX_LIMIT))
    .default(AGENT_SESSIONS_PAGE_DEFAULT_LIMIT),
});
export type AgentSessionsQuery = z.infer<typeof AgentSessionsQuery>;

/** One of an agent's sessions, as a replay list shows it; `GET /sessions/:id/events` replays it. */
export const AgentSessionItem = z.object({
  id: z.string(),
  ticket_id: nullableText,
  ticket_key: nullableText,
  role: z.string(),
  run_class: z.string(),
  runner_id: z.string(),
  state: SessionState,
  created_at: epochMs,
  started_at: epochMs.nullable(),
  ended_at: epochMs.nullable(),
  turns: count,
  cost_usd: z.number().nonnegative(),
  exit_reason: ExitReason.nullable(),
});
export type AgentSessionItem = z.infer<typeof AgentSessionItem>;

export const AgentSessionsPage = z.object({
  items: z.array(AgentSessionItem),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});
export type AgentSessionsPage = z.infer<typeof AgentSessionsPage>;
