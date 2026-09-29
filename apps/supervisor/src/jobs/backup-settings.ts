import { err, ok, type Result } from "@bayon/core";
import { getSettings, type Db } from "@bayon/db";
import { z } from "zod";
import { frmError } from "../lifecycle/errors.js";

// The backup job's tunables (config over code, §4): 012 seeds backup.*, 002 seeds retention.*.
// Read at every scheduler tick, so a changed hour or keep applies from the next one.
const Settings = z.object({
  "backup.enabled": z.union([z.literal(0), z.literal(1)]).default(1),
  "backup.at_utc_hour": z.int().min(0).max(23).default(3),
  "backup.keep": z.int().min(1).max(1_000).default(14),
  /** Events of tickets closed longer ago than this are archived. */
  "retention.events_days": z.int().min(1).default(30),
  /** 'keep' leaves reasoning events out of the sweep (§4 retention). */
  "retention.reasoning": z.enum(["keep", "archive"]).default("keep"),
});
export type BackupSettings = z.infer<typeof Settings>;

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = Settings.parse({});

export async function loadBackupSettings(
  db: Db,
): Promise<Result<BackupSettings>> {
  const rows = await getSettings(db, Object.keys(Settings.shape));
  if (!rows.ok) return rows;
  const parsed = Settings.safeParse(Object.fromEntries(rows.value));
  return parsed.success
    ? ok(parsed.data)
    : err(
        frmError(
          "validation",
          `backup settings: ${z.prettifyError(parsed.error)}`,
        ),
      );
}
