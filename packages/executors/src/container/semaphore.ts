import { timeoutError } from "./transport.js";

/** Counts ssh channels on one connection; a wait ends at the caller's deadline (`timeout`). */
export class Semaphore {
  #free: number;
  readonly #waiting: (() => void)[] = [];

  constructor(size: number) {
    this.#free = size;
  }

  /** Resolves with this holder's release; release is idempotent. */
  acquire(signal: AbortSignal, what: string): Promise<() => void> {
    if (signal.aborted) return Promise.reject(timeoutError(what));
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener("abort", onAbort);
        resolve(this.#releaser());
      };
      const onAbort = () => {
        const index = this.#waiting.indexOf(grant);
        if (index >= 0) this.#waiting.splice(index, 1);
        reject(timeoutError(what));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (this.#free > 0) {
        this.#free -= 1;
        grant();
      } else {
        this.#waiting.push(grant);
      }
    });
  }

  #releaser(): () => void {
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const next = this.#waiting.shift();
      if (next === undefined) this.#free += 1;
      else next();
    };
  }
}
