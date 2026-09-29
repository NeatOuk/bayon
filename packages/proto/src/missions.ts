import { MissionSection, MissionText } from "@bayon/core";
import { z } from "zod";

// The /api/v1/missions DTOs (§12.1, §12.3; M1 contract 7). `:agent` is the agent's name.

const epochMs = z.int().nonnegative();
const version = z.int().positive();

/** `:v`, `:a`, `:b` in the missions routes. */
export const MissionVersionNumber = z.coerce.number().pipe(version);

/** One version in the changelog, without its text. */
export const MissionVersionSummary = z.object({
  id: z.string(),
  version,
  hash: z.string(),
  note: z.string().nullable(),
  created_at: epochMs,
  created_by: z.string(),
});
export type MissionVersionSummary = z.infer<typeof MissionVersionSummary>;

/** `GET /missions/:agent/versions/:v`, and the 201 of `POST /missions/:agent`: a `missions` row. */
export const MissionVersion = MissionVersionSummary.extend(
  MissionText.shape,
).extend({
  agent_name: z.string(),
  /** The template's output (core `renderMission`); `hash` is its sha256. */
  rendered_md: z.string(),
});
export type MissionVersion = z.infer<typeof MissionVersion>;

/** `GET /missions/:agent`: the newest version (null before the first save) and the changelog, newest first. */
export const MissionView = z.object({
  agent: z.string(),
  latest: MissionVersion.nullable(),
  versions: z.array(MissionVersionSummary),
});
export type MissionView = z.infer<typeof MissionView>;

/**
 * `POST /missions/:agent`: the four sections, a changelog note (required, §12.3), and the version
 * the edit started from (0 for the first). A stale `base_version` is 409 with `current_version`.
 */
export const MissionSaveRequest = MissionText.extend({
  note: z.string().trim().min(1, "a new version needs a changelog note"),
  base_version: z.int().nonnegative(),
});
export type MissionSaveRequest = z.infer<typeof MissionSaveRequest>;

/** One run of lines in a section's diff, in order: kept, added in `to`, or removed from `from`. */
export const MissionDiffChange = z.object({
  op: z.enum(["same", "add", "remove"]),
  text: z.string(),
});
export type MissionDiffChange = z.infer<typeof MissionDiffChange>;

export const MissionSectionDiff = z.object({
  section: MissionSection,
  changed: z.boolean(),
  changes: z.array(MissionDiffChange),
});
export type MissionSectionDiff = z.infer<typeof MissionSectionDiff>;

/** `GET /missions/:agent/diff/:a/:b`: version `from` → `to`, line by line, per section. */
export const MissionDiff = z.object({
  agent: z.string(),
  from: version,
  to: version,
  sections: z.array(MissionSectionDiff),
});
export type MissionDiff = z.infer<typeof MissionDiff>;
