// Event batching (§9.4): rows commit every 50 ms or every 100 rows, in one transaction each,
// one transaction at a time and in push order.
import { err, ok, type Clock, type Result } from "@bayon/core";

export const BATCH_MAX_ROWS = 100;
export const BATCH_MAX_DELAY_MS = 50;

export interface Batcher<T> {
  /** Queues rows. Reaching maxRows flushes and returns that flush; else the timer will flush. */
  push(rows: readonly T[]): Promise<Result<void>> | undefined;
  /** Commits what is queued; resolves once it and every earlier batch are committed. */
  flush(): Promise<Result<void>>;
}

export interface BatcherOptions<T> {
  readonly clock: Clock;
  readonly maxRows: number;
  readonly maxDelayMs: number;
  /** Commits one batch. After a failure nothing else is committed: order would break. */
  commit(rows: readonly T[]): Promise<Result<void>>;
}

export function createBatcher<T>(o: BatcherOptions<T>): Batcher<T> {
  let pending: readonly T[] = [];
  let timer: AbortController | undefined;
  let chain: Promise<Result<void>> = Promise.resolve(ok(undefined));

  const commit = (rows: readonly T[]) =>
    o.commit(rows).catch((thrown: unknown) =>
      err({
        class: "internal",
        message: `batch commit threw: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
        retryable: false,
      }),
    );

  function flush(): Promise<Result<void>> {
    timer?.abort();
    timer = undefined;
    const batch = pending;
    pending = [];
    if (batch.length === 0) return chain;
    chain = chain.then((before) => (before.ok ? commit(batch) : before));
    return chain;
  }

  function arm(): void {
    if (timer !== undefined) return;
    const armed = new AbortController();
    timer = armed;
    o.clock.after(o.maxDelayMs, armed.signal).then(
      () => {
        if (timer === armed) void flush(); // commit reports its own failure
      },
      () => undefined, // a flush cancelled the timer
    );
  }

  return {
    push(rows) {
      if (rows.length === 0) return undefined;
      pending = [...pending, ...rows];
      if (pending.length >= o.maxRows) return flush();
      arm();
      return undefined;
    },
    flush,
  };
}
