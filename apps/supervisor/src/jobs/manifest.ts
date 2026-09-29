// The exporter's manifest (design doc §3 step 6, §4): the read-only child writes this file instead
// of touching the DB; the supervisor's own `onTerminal` listener parses it and does the one
// `upsertTicketExport` write, in its own process. Shared by both sides so they agree on the shape.
import { z } from "zod";

export const ExportManifestEntry = z.object({
  ticket_id: z.string().min(1),
  target: z.literal("markdown"),
  path: z.string().min(1),
  content_hash: z.string().length(64),
});
export type ExportManifestEntry = z.infer<typeof ExportManifestEntry>;

/** Only tickets actually written or deleted this run -- never the unchanged majority (design doc
 * §3 step 6: "listing only the tickets actually written or deleted"). An empty manifest is the
 * expected shape of a no-op re-run. */
export const ExportManifest = z.object({
  v: z.literal(1),
  entries: z.array(ExportManifestEntry),
  removed: z.array(z.string().min(1)),
});
export type ExportManifest = z.infer<typeof ExportManifest>;

export const EMPTY_MANIFEST: ExportManifest = {
  v: 1,
  entries: [],
  removed: [],
};
