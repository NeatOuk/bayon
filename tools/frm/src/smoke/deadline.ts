import { err, ok, type Clock, type FrmError, type Result } from "@bayon/core";

// Every wait in the smoke has a deadline and says what it waited for: it never sleeps and hopes.

export interface Deadline {
  readonly clock: Clock;
  readonly timeoutMs: number;
  /** What is awaited, e.g. "command 01J… done". */
  readonly what: string;
  /** The last thing seen, appended to the timeout message. */
  readonly detail?: () => string;
}

const timedOut = (d: Deadline): FrmError => {
  const detail = d.detail?.();
  return {
    class: "timeout",
    message: `${d.what}: not within ${d.timeoutMs / 1_000} s${detail ? ` (${detail})` : ""}`,
    retryable: false,
  };
};

/**
 * Calls `probe` every `intervalMs` until it yields a value (done), an error (stop at once), or the
 * deadline passes (a `timeout` error). `ok(undefined)` means "not yet".
 */
export async function pollUntil<T>(
  d: Deadline & { readonly intervalMs: number },
  probe: () => Promise<Result<T | undefined>>,
): Promise<Result<T>> {
  const deadline = d.clock.now() + d.timeoutMs;
  for (;;) {
    const found = await probe();
    if (!found.ok) return found;
    if (found.value !== undefined) return ok(found.value);
    const left = deadline - d.clock.now();
    if (left <= 0) return err(timedOut(d));
    await d.clock.after(Math.min(d.intervalMs, left));
  }
}

/** `work`'s value, or a `timeout` error once the deadline passes first. */
export async function within<T>(
  d: Deadline,
  work: Promise<T>,
): Promise<Result<T>> {
  const cancel = new AbortController();
  const expired = (): Result<T> => err(timedOut(d));
  try {
    return await Promise.race([
      work.then((value) => ok(value)),
      // The timer rejects only when cancelled, i.e. after the race is settled.
      d.clock.after(d.timeoutMs, cancel.signal).then(expired, expired),
    ]);
  } finally {
    cancel.abort();
  }
}
