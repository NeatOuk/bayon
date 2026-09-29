import { err, ok, type Clock, type Result } from "@bayon/core";
import { toFrmError } from "./errors.js";

/** §9.5: after the first try, three retries with jitter on SQLITE_BUSY. */
export const BUSY_RETRIES = 3;
const BASE_DELAY_MS = 25;

export interface RetryContext {
  readonly clock: Clock;
  /** In [0, 1): the jitter source. */
  readonly random: () => number;
  readonly onRetry: () => void;
}

/**
 * Runs `attempt`, and on SQLITE_BUSY runs it again after 25 ms × 2^n × (0.5 + random()), up to
 * three times; then the result is `db_busy`, which is retryable. Any other error returns at once.
 */
export async function withBusyRetry<T>(
  ctx: RetryContext,
  attempt: () => T,
): Promise<Result<T>> {
  for (let retry = 0; ; retry += 1) {
    try {
      return ok(attempt());
    } catch (thrown) {
      const error = toFrmError(thrown);
      if (error.class !== "db_busy" || retry === BUSY_RETRIES)
        return err(error);
      ctx.onRetry();
      await ctx.clock.after(BASE_DELAY_MS * 2 ** retry * (0.5 + ctx.random()));
    }
  }
}
