// The pulse layer's tunables (config over code): `settings` rows, else these defaults.
import { err, ok, type Result } from "@bayon/core";
import { getSettings, type Db } from "@bayon/db";
import { z } from "zod";

const ms = z.int().positive();

const Shape = z.object({
  /** The lease's life, no renewal (amendment d): the pulse wall clock + 2 min. Seeded by 004. */
  "pulse.lease_ttl_ms": ms.default(1_020_000),
  /** A pulse must end this long before its lease does: deadline = lease end − grace (review C1). */
  "pulse.lease_grace_ms": ms.default(120_000),
  /** The completions poll, re-plan and sweep. */
  "pulse.tick_ms": ms.default(60_000),
});

const Settings = Shape.refine(
  (s) => s["pulse.lease_grace_ms"] < s["pulse.lease_ttl_ms"],
  { message: "pulse.lease_grace_ms must be below pulse.lease_ttl_ms" },
);
export type PulseSettings = z.infer<typeof Settings>;

export const DEFAULT_PULSE_SETTINGS: PulseSettings = Settings.parse({});

const KEYS = Object.keys(Shape.shape);

export async function loadPulseSettings(
  db: Db,
): Promise<Result<PulseSettings>> {
  const rows = await getSettings(db, KEYS);
  if (!rows.ok) return rows;
  const parsed = Settings.safeParse(Object.fromEntries(rows.value));
  return parsed.success
    ? ok(parsed.data)
    : err({
        class: "validation",
        message: `pulse settings: ${z.prettifyError(parsed.error)}`,
        retryable: false,
      });
}
