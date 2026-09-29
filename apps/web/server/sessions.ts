// Login sessions: in memory only, so a restart logs everyone out. Each is
// bound to the client address it logged in from: cookies ignore ports, so every service on this IP
// receives the cookie, and a logged one must be useless from anywhere else. The map is keyed by the
// sha256 of the id, never the id. Ending a session closes its WebSockets with 4401.
import { createHash, randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import type { Clock } from "@bayon/core";
import { SESSION_VALUE } from "./cookies.js";

export interface SessionLimits {
  /** A session ends this long after login, whatever its use. */
  readonly absoluteMs: number;
  /** …or after this long without a request. */
  readonly idleMs: number;
  /** At most this many at once; the oldest is evicted. */
  readonly max: number;
}

export const SESSION_LIMITS: SessionLimits = {
  absoluteMs: 12 * 3_600_000,
  idleMs: 2 * 3_600_000,
  max: 8,
};

/** A proxied WebSocket: the browser's socket and the API's. */
export interface WsPair {
  readonly client: Duplex;
  readonly upstream: Duplex;
}

export type EndReason =
  "logout" | "expired" | "evicted" | "replaced" | "shutdown";

/** The close code the GUI treats as "log in again". */
export const WS_LOGIN_REQUIRED = 4401;

interface SessionRecord {
  readonly address: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
}

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/** Writes a WebSocket close frame (unmasked, server to client) and ends both sides. */
export function closeWs(pair: WsPair, code: number, reason: string): void {
  pair.upstream.unpipe(pair.client);
  pair.upstream.destroy();
  const text = Buffer.from(reason.slice(0, 64), "utf8");
  const payload = Buffer.concat([Buffer.from([code >> 8, code & 0xff]), text]);
  pair.client.end(
    Buffer.concat([Buffer.from([0x88, payload.length]), payload]),
  );
  setTimeout(() => pair.client.destroy(), 1_000).unref();
}

export class SessionStore {
  readonly #clock: Clock;
  readonly #limits: SessionLimits;
  readonly #onEnd: (address: string, why: EndReason) => void;
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #sockets = new Map<string, Set<WsPair>>();

  constructor(
    clock: Clock,
    limits: SessionLimits = SESSION_LIMITS,
    onEnd: (address: string, why: EndReason) => void = () => undefined,
  ) {
    this.#clock = clock;
    this.#limits = limits;
    this.#onEnd = onEnd;
  }

  get size(): number {
    return this.#sessions.size;
  }

  /** A new session for `address`: always a fresh id, never one a client presented. */
  create(address: string): string {
    while (this.#sessions.size >= this.#limits.max) {
      const oldest = [...this.#sessions.entries()].sort(
        (a, b) => a[1].createdAt - b[1].createdAt,
      )[0];
      if (oldest === undefined) break;
      this.#end(oldest[0], "evicted");
    }
    const value = randomBytes(32).toString("base64url");
    const now = this.#clock.now();
    this.#sessions.set(digest(value), {
      address,
      createdAt: now,
      lastSeenAt: now,
    });
    return value;
  }

  /**
   * The key of the first live session among `values` that belongs to `address`, touched; null
   * when none. An expired one is ended; one from another address is ignored, never ended (a replay
   * elsewhere must not log the owner out).
   */
  find(values: readonly string[], address: string): string | null {
    const now = this.#clock.now();
    for (const value of values) {
      if (!SESSION_VALUE.test(value)) continue;
      const key = digest(value);
      const record = this.#sessions.get(key);
      if (record === undefined) continue;
      if (this.#expired(record, now)) {
        this.#end(key, "expired");
        continue;
      }
      if (record.address !== address) continue;
      this.#sessions.set(key, { ...record, lastSeenAt: now });
      return key;
    }
    return null;
  }

  /** Tracks a proxied WebSocket of session `key`, so ending the session closes it. */
  attach(key: string, pair: WsPair): void {
    if (!this.#sessions.has(key)) {
      closeWs(pair, WS_LOGIN_REQUIRED, "login required");
      return;
    }
    const set = this.#sockets.get(key) ?? new Set<WsPair>();
    set.add(pair);
    this.#sockets.set(key, set);
    pair.client.once("close", () => set.delete(pair));
  }

  end(key: string, why: EndReason): void {
    this.#end(key, why);
  }

  /** Ends every expired session (a timer calls it, so an idle feed is closed on time). */
  sweep(): void {
    const now = this.#clock.now();
    for (const [key, record] of [...this.#sessions.entries()]) {
      if (this.#expired(record, now)) this.#end(key, "expired");
    }
  }

  endAll(why: EndReason): void {
    for (const key of [...this.#sessions.keys()]) this.#end(key, why);
  }

  #expired(record: SessionRecord, now: number): boolean {
    return (
      now - record.createdAt >= this.#limits.absoluteMs ||
      now - record.lastSeenAt >= this.#limits.idleMs
    );
  }

  #end(key: string, why: EndReason): void {
    const record = this.#sessions.get(key);
    if (record === undefined) return;
    this.#sessions.delete(key);
    const sockets = this.#sockets.get(key);
    this.#sockets.delete(key);
    for (const pair of sockets ?? []) closeWs(pair, WS_LOGIN_REQUIRED, why);
    this.#onEnd(record.address, why);
  }
}
