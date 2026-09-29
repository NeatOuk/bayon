// A project's history timeline: what each row comes from, and the caps every row keeps.
// The rows are read-time: one UNION over the tables that already hold them, never a table of its own
// (a timeline both the API and the supervisor wrote would break the one-writer rule, §9.5).
import { z } from "zod";

/**
 * Where a timeline row comes from. Its `kind` is `<source>.<detail>`, and paging orders ties on the
 * same millisecond by source (text, descending), then by key.
 */
export const TIMELINE_SOURCES = [
  "audit",
  "ticket",
  "session",
  "pulse",
  "gate",
  "finding",
  "handoff",
  "human_request",
] as const;
export const TimelineSource = z.enum(TIMELINE_SOURCES);
export type TimelineSource = z.infer<typeof TimelineSource>;

/** A row's summary: one line, at most this many characters (built server-side, Invariant 9). */
export const TIMELINE_SUMMARY_MAX = 300;

/**
 * A stored payload rides on its row only up to this many bytes (Invariant 9's 8 KB). A larger one
 * is left out, never cut (cut JSON is not JSON); the source row, by its key, still holds it.
 */
export const TIMELINE_PAYLOAD_MAX_BYTES = 8 * 1024;

/**
 * A `kind` filter: exact (`pulse.skipped`), or a prefix when it ends in `*` (`session.*`). Kinds are
 * lowercase words joined by dots and underscores.
 */
export const TimelineKindFilter = z
  .string()
  .regex(
    /^[a-z0-9_.]{1,120}\*?$/,
    "a kind is lowercase words and dots, optionally ending in *",
  );
