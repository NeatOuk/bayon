/** The time source. Every timer goes through one, so tests drive time instead of sleeping. */
export interface Clock {
  /** Epoch millis, UTC. */
  now(): number;
  /** Resolves after `ms`; rejects with `signal.reason` if the signal aborts first. */
  after(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  after: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

interface Timer {
  readonly due: number;
  readonly fire: () => void;
}

/** A test clock: time moves only when `advance` is awaited. */
export class FakeClock implements Clock {
  #now: number;
  #timers: readonly Timer[] = [];

  constructor(start = 0) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  after(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = (): void => {
        this.#timers = this.#timers.filter((t) => t !== timer);
        reject(signal?.reason);
      };
      const timer: Timer = {
        due: this.#now + Math.max(0, ms),
        fire: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      this.#timers = [...this.#timers, timer];
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Moves time forward by `ms`. Due timers fire in due order (ties in arming order), each at its due
   * time. After each one the event loop gets a turn, so a continuation that arms the next timer is
   * seen within the same advance.
   */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    let next = this.#nextDue(target);
    while (next) {
      const firing = next;
      this.#timers = this.#timers.filter((t) => t !== firing);
      this.#now = firing.due;
      firing.fire();
      await new Promise<void>((resolve) => setImmediate(resolve));
      next = this.#nextDue(target);
    }
    this.#now = target;
  }

  #nextDue(limit: number): Timer | undefined {
    return this.#timers
      .filter((t) => t.due <= limit)
      .toSorted((a, b) => a.due - b.due)[0];
  }
}
