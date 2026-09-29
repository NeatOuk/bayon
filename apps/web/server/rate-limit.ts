// Login attempts: limits, never a lockout. A global lockout would
// be a denial of service against the only operator, so: failures are counted per client address; all
// attempts together are held to one a second; at most two scrypt computations run at once. With a
// 20-character random password this makes guessing pointless without ever locking the owner out.
import type { Clock } from "@bayon/core";

export interface LoginLimits {
  /** Failures from one address within `addressWindowMs` before it gets 429s. */
  readonly addressFailures: number;
  readonly addressWindowMs: number;
  /** At most one attempt this often, across every address. */
  readonly globalIntervalMs: number;
  /** scrypt computations at once. */
  readonly maxConcurrent: number;
  /** Failures in a minute, across every address, that log a warning (once a minute). */
  readonly warnFailuresPerMinute: number;
}

export const LOGIN_LIMITS: LoginLimits = {
  addressFailures: 5,
  addressWindowMs: 15 * 60_000,
  globalIntervalMs: 1_000,
  maxConcurrent: 2,
  warnFailuresPerMinute: 10,
};

export type Admission =
  | { readonly ok: true; release(): void }
  | {
      readonly ok: false;
      readonly why: "address" | "rate" | "busy";
      readonly retryAfterSec: number;
    };

const MINUTE = 60_000;
const seconds = (ms: number): number => Math.max(1, Math.ceil(ms / 1_000));
/** Addresses whose failures are remembered at once (security review: the map stays bounded). */
export const MAX_TRACKED = 1024;

export class LoginLimiter {
  readonly #clock: Clock;
  readonly #limits: LoginLimits;
  readonly #warn: (
    msg: string,
    fields: Readonly<Record<string, unknown>>,
  ) => void;
  readonly #failures = new Map<string, readonly number[]>();
  #recentFailures: readonly number[] = [];
  #lastAttemptAt = Number.NEGATIVE_INFINITY;
  #warnedAt = Number.NEGATIVE_INFINITY;
  #active = 0;

  constructor(
    clock: Clock,
    limits: LoginLimits = LOGIN_LIMITS,
    warn: (
      msg: string,
      fields: Readonly<Record<string, unknown>>,
    ) => void = () => undefined,
  ) {
    this.#clock = clock;
    this.#limits = limits;
    this.#warn = warn;
  }

  /**
   * May `address` try a password now? An address over its failures is refused before the global
   * rate is spent, so one flooding address never blocks another beyond the rate.
   */
  admit(address: string): Admission {
    const now = this.#clock.now();
    const failures = this.#live(address, now);
    if (failures.length >= this.#limits.addressFailures) {
      const oldest = failures[0] ?? now;
      return {
        ok: false,
        why: "address",
        retryAfterSec: seconds(oldest + this.#limits.addressWindowMs - now),
      };
    }
    const wait = this.#lastAttemptAt + this.#limits.globalIntervalMs - now;
    if (wait > 0)
      return { ok: false, why: "rate", retryAfterSec: seconds(wait) };
    if (this.#active >= this.#limits.maxConcurrent)
      return { ok: false, why: "busy", retryAfterSec: 1 };
    this.#lastAttemptAt = now;
    this.#active += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.#active -= 1;
      },
    };
  }

  failed(address: string): void {
    const now = this.#clock.now();
    this.#failures.set(address, [...this.#live(address, now), now]);
    this.#cap();
    this.#recentFailures = [
      ...this.#recentFailures.filter((t) => t > now - MINUTE),
      now,
    ];
    if (
      this.#recentFailures.length >= this.#limits.warnFailuresPerMinute &&
      now - this.#warnedAt >= MINUTE
    ) {
      this.#warnedAt = now;
      this.#warn("repeated failed logins", {
        failures_last_minute: this.#recentFailures.length,
      });
    }
  }

  succeeded(address: string): void {
    this.#failures.delete(address);
  }

  /** Addresses with a failure still inside the window. */
  get tracked(): number {
    return this.#failures.size;
  }

  /**
   * Forgets every address whose failures have all left the window (the edge's timer calls it), so
   * the map never grows with addresses that stopped trying; then applies the cap.
   */
  sweep(): void {
    const now = this.#clock.now();
    for (const address of [...this.#failures.keys()]) this.#live(address, now);
    this.#cap();
  }

  /** At most MAX_TRACKED addresses: past it, the ones whose last failure is oldest are forgotten. */
  #cap(): void {
    const excess = this.#failures.size - MAX_TRACKED;
    if (excess <= 0) return;
    const oldest = [...this.#failures.entries()]
      .sort((a, b) => (a[1].at(-1) ?? 0) - (b[1].at(-1) ?? 0))
      .slice(0, excess);
    for (const [address] of oldest) this.#failures.delete(address);
  }

  #live(address: string, now: number): readonly number[] {
    const live = (this.#failures.get(address) ?? []).filter(
      (t) => t > now - this.#limits.addressWindowMs,
    );
    if (live.length === 0) this.#failures.delete(address);
    else this.#failures.set(address, live);
    return live;
  }
}
