// A per-session budget of MCP calls: at most `calls` in any `windowMs`, a
// sliding window on the injected clock. Over it, /mcp answers 429.
import type { Clock } from "@bayon/core";

export class SessionRate {
  readonly #calls: number;
  readonly #windowMs: number;
  readonly #clock: Clock;
  readonly #seen = new Map<string, readonly number[]>();
  #sweptAt = Number.NEGATIVE_INFINITY;

  constructor(o: {
    readonly calls: number;
    readonly windowMs: number;
    readonly clock: Clock;
  }) {
    this.#calls = o.calls;
    this.#windowMs = o.windowMs;
    this.#clock = o.clock;
  }

  /** Records a call and says whether it fits; a refused call uses no budget. */
  take(sessionId: string): boolean {
    const now = this.#clock.now();
    this.#sweep(now);
    const recent = (this.#seen.get(sessionId) ?? []).filter(
      (t) => t > now - this.#windowMs,
    );
    const fits = recent.length < this.#calls;
    this.#seen.set(sessionId, fits ? [...recent, now] : recent);
    return fits;
  }

  /** Sessions tracked now: an idle or ended one is gone within a window of any call. */
  get tracked(): number {
    return this.#seen.size;
  }

  /**
   * Once a window, drops every session with no call inside it. An ended session never gets past
   * auth to call again, so this is what evicts it; an idle one comes back with a full budget.
   */
  #sweep(now: number): void {
    if (now - this.#sweptAt < this.#windowMs) return;
    this.#sweptAt = now;
    for (const [id, times] of this.#seen) {
      if (times.every((t) => t <= now - this.#windowMs)) this.#seen.delete(id);
    }
  }
}
