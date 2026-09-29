// The sweep's own single-flight loop: never inside reconcilePass, never on a
// session queue. The next pass starts worktree.recheck_ms after the last one ended; requestPass()
// (Q8) coalesces any number of requests into one pass, at least worktree.request_min_gap_ms after the
// last (NEW-7). stop() waits for a running pass, whose removal steps finish on their own bounds.
import type { Clock } from "@bayon/core";
import { DEFAULT_MIN_GAP_MS, DEFAULT_RECHECK_MS } from "./settings.js";

export interface Cadence {
  readonly recheckMs: number;
  readonly minGapMs: number;
}

export interface SweepLoopOptions {
  readonly clock: Clock;
  /** One pass; resolves to the cadence it read from the settings. */
  readonly runPass: (signal: AbortSignal) => Promise<Cadence>;
  readonly onError: (e: unknown) => void;
}

export interface SweepLoop {
  /** The first pass now, then one every recheck_ms after the last ends. Idempotent. */
  start(): void;
  /** Cancels the wait and resolves once a running pass has finished. */
  stop(): Promise<void>;
  /** Fire and forget: one more pass, coalesced, after the minimum gap. Never throws. */
  requestPass(): void;
  /** One pass now, after any running one (tests, and Lifecycle.sweepWorktrees). */
  runNow(): Promise<void>;
}

export function createSweepLoop(o: SweepLoopOptions): SweepLoop {
  const stopped = new AbortController();
  let started = false;
  let tail: Promise<void> = Promise.resolve();
  let running = false;
  let again = false;
  let lastEnd: number | null = null;
  let cadence: Cadence = {
    recheckMs: DEFAULT_RECHECK_MS,
    minGapMs: DEFAULT_MIN_GAP_MS,
  };
  let timer: AbortController | null = null;
  let due = Number.POSITIVE_INFINITY;

  const arm = (at: number): void => {
    if (!started || stopped.signal.aborted) return;
    if (timer !== null && due <= at) return; // an earlier wake is armed already
    timer?.abort();
    const t = new AbortController();
    timer = t;
    due = at;
    o.clock
      .after(
        Math.max(0, at - o.clock.now()),
        AbortSignal.any([t.signal, stopped.signal]),
      )
      .then(
        () => {
          if (timer !== t) return;
          timer = null;
          due = Number.POSITIVE_INFINITY;
          void queue();
        },
        () => undefined, // re-armed or stopped
      );
  };

  const onePass = async (): Promise<void> => {
    if (stopped.signal.aborted) return;
    running = true;
    again = false;
    try {
      cadence = await o.runPass(stopped.signal);
    } catch (e) {
      o.onError(e);
    } finally {
      running = false;
      lastEnd = o.clock.now();
    }
    arm(lastEnd + (again ? cadence.minGapMs : cadence.recheckMs));
  };

  const queue = (): Promise<void> => {
    tail = tail.then(onePass);
    return tail;
  };

  return {
    start() {
      if (started) return;
      started = true;
      arm(o.clock.now());
    },
    async stop() {
      stopped.abort();
      timer?.abort();
      await tail;
    },
    requestPass() {
      if (stopped.signal.aborted) return;
      if (running) {
        again = true;
        return;
      }
      const now = o.clock.now();
      arm(lastEnd === null ? now : Math.max(now, lastEnd + cadence.minGapMs));
    },
    runNow: () => queue(),
  };
}
