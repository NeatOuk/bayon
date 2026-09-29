// The sweep's settings (015, NEW-7), read at the start of every pass so an
// operator's change applies at the next one. A missing or malformed row that removal depends on turns
// removal off, and flagging goes on: a bad setting never removes more than it should. The cadence
// keys fall back to their defaults.
import { getSettings, type Db } from "@bayon/db";
import { z } from "zod";

const Ms = z.int().positive();
const Names = z.array(z.string().min(1)).max(64);

export const SWEEP_KEYS = {
  recheck: "worktree.recheck_ms",
  minGap: "worktree.request_min_gap_ms",
  minEnded: "worktree.min_ended_ms",
  removeTimeout: "worktree.remove_timeout_ms",
  tmpMinAge: "worktree.mirror_tmp_min_age_ms",
  disposable: "worktree.disposable_ignored",
} as const;

export const DEFAULT_RECHECK_MS = 3_600_000;
export const DEFAULT_MIN_GAP_MS = 60_000;

export interface SweepSettings {
  readonly recheckMs: number;
  readonly minGapMs: number;
  /** Infinity when its row is unusable: nothing is ever removable then. */
  readonly minEndedMs: number;
  readonly removeTimeoutMs: number;
  /** Null: mirror temp dirs are left alone this pass. */
  readonly tmpMinAgeMs: number | null;
  readonly disposable: readonly string[];
  /** False when a removal setting is missing or malformed (NEW-7). */
  readonly removalOn: boolean;
  readonly problems: readonly string[];
}

export async function loadSweepSettings(db: Db): Promise<SweepSettings> {
  const rows = await getSettings(db, Object.values(SWEEP_KEYS));
  const problems: string[] = rows.ok
    ? []
    : [`the settings cannot be read: ${rows.error.message}`];
  const got: ReadonlyMap<string, unknown> = rows.ok ? rows.value : new Map();
  const pick = <T>(key: string, schema: z.ZodType<T>): T | null => {
    if (!got.has(key)) {
      if (rows.ok) problems.push(`${key} is missing`);
      return null;
    }
    const parsed = schema.safeParse(got.get(key));
    if (parsed.success) return parsed.data;
    problems.push(`${key} is malformed`);
    return null;
  };
  const recheck = pick(SWEEP_KEYS.recheck, Ms);
  const minGap = pick(SWEEP_KEYS.minGap, Ms);
  const minEnded = pick(SWEEP_KEYS.minEnded, Ms);
  const removeTimeout = pick(SWEEP_KEYS.removeTimeout, Ms);
  const tmpMinAge = pick(SWEEP_KEYS.tmpMinAge, Ms);
  const disposable = pick(SWEEP_KEYS.disposable, Names);
  return {
    recheckMs: recheck ?? DEFAULT_RECHECK_MS,
    minGapMs: minGap ?? DEFAULT_MIN_GAP_MS,
    minEndedMs: minEnded ?? Number.POSITIVE_INFINITY,
    removeTimeoutMs: removeTimeout ?? 0,
    tmpMinAgeMs: tmpMinAge,
    disposable: disposable ?? [],
    removalOn:
      minEnded !== null && removeTimeout !== null && disposable !== null,
    problems,
  };
}
