// The exporter's tunables (config over code): `settings` rows, else these defaults. Shared by the
// job itself (key_prefix, repo_path) and the interval scheduler (interval_ms) -- one schema, so
// the two never drift on a key name. Mirrors lifecycle/settings.ts's pattern.
import {
  DEFAULT_TICKET_KEY_PREFIX,
  TicketKeyPrefix,
  err,
  ok,
  type Result,
} from "@bayon/core";
import { getSettings, type Db } from "@bayon/db";
import { z } from "zod";

const Settings = z.object({
  /** Amendment 13: a ticket's exported key is this plus its `num`, which becomes a file name
   * (`exports/tickets/<key>.md`). The tickets module's own schema and default, so the file is
   * named by the key the API shows; its capitals, digits and '-' can never smuggle a path
   * separator or traversal into a file name. */
  "tickets.key_prefix": TicketKeyPrefix.default(DEFAULT_TICKET_KEY_PREFIX),
  /** Absolute path to the git working directory the exporter writes into. `null` means "not set";
   * the job falls back to `$FRM_HOME/exports`. */
  "exports.repo_path": z.string().min(1).nullable().default(null),
  /** How often the supervisor's own timer re-triggers the exporter. 0 (the code default) or an
   * absent row both mean off: an operator opts in by setting a positive value. */
  "exports.interval_ms": z.int().nonnegative().default(0),
});
export type ExportSettings = z.infer<typeof Settings>;

const KEYS = Object.keys(Settings.shape);

export async function loadExportSettings(
  db: Db,
): Promise<Result<ExportSettings>> {
  const rows = await getSettings(db, KEYS);
  if (!rows.ok) return rows;
  const parsed = Settings.safeParse(Object.fromEntries(rows.value));
  return parsed.success
    ? ok(parsed.data)
    : err({
        class: "validation",
        message: `export settings: ${z.prettifyError(parsed.error)}`,
        retryable: false,
      });
}
