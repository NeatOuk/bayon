import { z } from "zod";
import { FrmError, err, ok, type Result } from "./errors.js";

/** `models.tier` (§4). */
export const ModelTier = z.enum(["complex", "standard", "cheap"]);
export type ModelTier = z.infer<typeof ModelTier>;

const cap = z.int().nonnegative(); // 0 = n/a

/** A `run_classes` row (§4, §8.4): the token and turn contract for one kind of work. A 0 cap means n/a. */
export const RunClass = z.object({
  name: z.string().min(1),
  context_tokens_cap: cap,
  max_turns: cap,
  max_tool_calls: cap,
  // Always set: a run with no terminal event inside its wall clock has failed (§5.2).
  wall_clock_ms: z.int().positive(),
  cost_cap_usd: z.number().nonnegative(),
  handoff_at_turns: cap,
  handoff_at_context_pct: z.int().min(0).max(100),
  default_tier: ModelTier,
});
export type RunClass = z.infer<typeof RunClass>;

const MIN = 60_000;
const HOUR = 60 * MIN;

const row = (
  name: string,
  context_tokens_cap: number,
  max_turns: number,
  max_tool_calls: number,
  wall_clock_ms: number,
  cost_cap_usd: number,
  handoff_at_turns: number,
  handoff_at_context_pct: number,
  default_tier: ModelTier,
): RunClass =>
  Object.freeze({
    name,
    context_tokens_cap,
    max_turns,
    max_tool_calls,
    wall_clock_ms,
    cost_cap_usd,
    handoff_at_turns,
    handoff_at_context_pct,
    default_tier,
  });

/**
 * The §8.4 starting values, as amended. `build` (standard) and `build_complex` are separate
 * classes, and 0 means n/a. The default tier is cheap for pulse, qa and probe, complex for
 * build_complex, and standard for the rest. Where the table gives a turn threshold, hand-off also
 * triggers at 70 % context, the column's default. The run-class ceilings migration
 * raised spike, build, build_complex, review and fix to what a real coding-agent session needs: its
 * own system prompt and tools take 15-25k tokens before it reads a file. Hand-off turns sit at
 * 75 % of max turns.
 */
export const DEFAULT_RUN_CLASSES: readonly RunClass[] = Object.freeze([
  // name, context cap, max turns, tool calls, wall clock, cost cap, hand-off turns, hand-off ctx %, tier
  row("pulse", 6_000, 12, 40, 15 * MIN, 0.5, 10, 70, "cheap"),
  row("spike", 150_000, 100, 300, 45 * MIN, 5, 75, 70, "standard"),
  row("build", 300_000, 300, 1_200, 2 * HOUR, 15, 225, 70, "standard"),
  row("build_complex", 600_000, 500, 2_000, 4 * HOUR, 30, 375, 70, "complex"),
  row("review", 150_000, 60, 200, 30 * MIN, 5, 0, 0, "standard"),
  row("fix", 150_000, 150, 500, HOUR, 5, 112, 70, "standard"),
  row("qa", 0, 0, 0, 20 * MIN, 0.2, 0, 0, "cheap"),
  row("probe", 0, 0, 0, 30_000, 0, 0, 0, "cheap"),
]);

/** Reads the raw `run_classes` rows. `@bayon/db` supplies one, which keeps core free of it. */
export type RunClassReader = () => Promise<readonly unknown[]>;

/**
 * Returns the run classes in force: the §8.4 defaults, overridden and extended by DB rows with the
 * same name. Rows are validated, not trusted, so an invalid row is a `validation` error. A reader
 * failure is returned, never swallowed: as-is if it is already an FrmError, otherwise as `internal`.
 */
export async function loadRunClasses(
  read: RunClassReader,
): Promise<Result<ReadonlyMap<string, RunClass>>> {
  let rows: readonly unknown[];
  try {
    rows = await read();
  } catch (cause) {
    const known = FrmError.safeParse(cause);
    return err(
      known.success
        ? known.data
        : {
            class: "internal",
            message: "reading run_classes failed",
            retryable: false,
            cause,
          },
    );
  }
  const parsed = z.array(RunClass).safeParse(rows);
  if (!parsed.success) {
    return err({
      class: "validation",
      message: `invalid run_classes row: ${z.prettifyError(parsed.error)}`,
      retryable: false,
    });
  }
  return ok(
    new Map([...DEFAULT_RUN_CLASSES, ...parsed.data].map((c) => [c.name, c])),
  );
}
