import type { Clock } from "@bayon/core";

/** True if `promise` settles within `ms` of `clock`'s time. The timer is cancelled either way. */
export async function settlesWithin(
  promise: Promise<unknown>,
  clock: Clock,
  ms: number,
): Promise<boolean> {
  const timer = new AbortController();
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      clock.after(ms, timer.signal).then(
        () => false,
        () => false,
      ),
    ]);
  } finally {
    timer.abort();
  }
}
