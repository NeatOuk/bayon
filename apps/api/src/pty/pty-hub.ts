// The session:<id>:pty broadcaster (§12.5 point 3), framework-free like ws/hub.ts. One relay
// channel per session, shared by every browser tab watching it: PtyProc's own output channel is a
// single-consumer queue (packages/executors/src/channel.ts), so fanning it out to N sockets has to
// happen here, not by opening N relay channels for the same session.
import type { Channel, RelayClient } from "../relay/relay-client.js";
import type { ApiStore } from "../store.js";

/** The part of a `ws` socket this hub uses. */
export interface HubSocket {
  readonly readyState: number;
  send(data: Buffer | Uint8Array): void;
  /** Called when the session's own relay channel dies (a detach, a supervisor restart): the
   * watcher is told to close rather than sit in silence forever, so the browser can reconnect. */
  close(): void;
}

export interface PtySession {
  /** `false` once the session's own lease has moved on; every send from this connection is then
   * silently dropped, never forwarded — "watch only" happens by simply no longer writing. */
  isLeaseHolder(token: string): Promise<boolean>;
  /** Sends a browser->API frame's raw bytes (data or resize; a caller filters heartbeats out
   * before this, since they never leave the API). Silently dropped if not the lease holder. */
  send(token: string, bytes: Uint8Array): Promise<void>;
  /** Renews the lease: forwards a heartbeat frame to the supervisor, which alone may write it. */
  heartbeat(token: string): Promise<void>;
  /** Adds `socket` as a watcher; sends it the ring-buffered scrollback first, then live bytes as
   * they arrive. Returns the unsubscribe. */
  watch(socket: HubSocket): () => void;
}

class LivePtySession implements PtySession {
  readonly #sockets = new Set<HubSocket>();
  readonly #channel: Channel;
  #closed = false;

  constructor(
    private readonly sessionId: string,
    relay: RelayClient,
    private readonly store: ApiStore,
    private readonly scrollback: Promise<Buffer>,
    /** Told once, whenever this session becomes unusable — a detach, a supervisor restart, or a
     * relay connection that never came up in the first place — so the hub can evict it and the
     * next `open()` for this session id builds a genuinely fresh channel instead of reusing a
     * dead one. */
    private readonly onClosed: () => void,
  ) {
    this.#channel = relay.openChannel(sessionId);
    this.#channel.onData((bytes) => this.#broadcast(bytes));
    this.#channel.onClose(() => this.#die());
  }

  /** Idempotent: reachable both from the relay closing on its own and from `close()` below, and
   * must behave the same either way — every watcher closed, the hub told exactly once. */
  #die(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const socket of this.#sockets) socket.close();
    this.#sockets.clear();
    this.onClosed();
  }

  #broadcast(bytes: Buffer): void {
    for (const socket of this.#sockets) {
      if (socket.readyState !== 1 /* OPEN */) continue;
      socket.send(bytes);
    }
  }

  async #ownsLease(token: string): Promise<boolean> {
    const session = await this.store.session(this.sessionId);
    return (
      session.ok &&
      session.value.state === "human_attached" &&
      session.value.attach_lease_owner === token
    );
  }

  async isLeaseHolder(token: string): Promise<boolean> {
    return this.#ownsLease(token);
  }

  async send(token: string, bytes: Uint8Array): Promise<void> {
    if (this.#closed) return;
    if (!(await this.#ownsLease(token))) return;
    this.#channel.send(Buffer.from(bytes));
  }

  async heartbeat(token: string): Promise<void> {
    if (this.#closed) return;
    if (!(await this.#ownsLease(token))) return;
    this.#channel.send(Buffer.from([2 /* PtyFrameKind.Heartbeat */]));
  }

  watch(socket: HubSocket): () => void {
    if (this.#closed) {
      // Lost the race with the channel dying between `open()` resolving and this call: the caller
      // is about to get the same "no session" treatment a fresh `open()` would give it right now.
      socket.close();
      return () => undefined;
    }
    void this.scrollback.then((buf) => {
      if (buf.length > 0 && socket.readyState === 1) socket.send(buf);
    });
    this.#sockets.add(socket);
    return () => {
      this.#sockets.delete(socket);
    };
  }

  get empty(): boolean {
    return this.#sockets.size === 0;
  }

  close(): void {
    this.#channel.close();
    this.#die();
  }
}

/** Shares one PtySession (one relay channel) per session id across every caller; the last watcher
 * leaving closes it, matching the relay's own "a channel survives a disconnect, a fresh open
 * rebinds it" model — nothing here needs to persist past the last live viewer.
 *
 * `#sessions` caches the in-flight *promise*, not just the resolved session: `open()` awaits a
 * real DB round trip before it knows whether to create one, and two callers racing that window
 * must not each open their own relay channel under the same channel id (the relay has no
 * duplicate-open guard of its own — the second call would silently steal the first's channel). A
 * miss (not attached) or a session that dies is never left cached: a future call must re-check
 * fresh rather than remember a stale answer forever.
 */
export class PtyHub {
  readonly #sessions = new Map<string, Promise<LivePtySession | undefined>>();

  constructor(
    private readonly relay: RelayClient,
    private readonly store: ApiStore,
    private readonly readScrollback: (path: string) => Promise<Buffer>,
  ) {}

  /** `undefined` if the session isn't attached with a pty to stream. Never opens a relay channel
   * for a session that isn't actually `human_attached` — the supervisor only ever registers one
   * for those, so anything else would just sit there getting "no such channel" errors. */
  async open(sessionId: string): Promise<PtySession | undefined> {
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const pending = this.#create(sessionId);
    this.#sessions.set(sessionId, pending);
    // A rejected creation (an unexpected throw, not the ordinary "not attached" undefined) must
    // not be cached forever either — the next caller gets a fresh attempt, not a dead promise.
    pending.catch(() => this.#forget(sessionId));
    return pending;
  }

  async #create(sessionId: string): Promise<LivePtySession | undefined> {
    const found = await this.store.session(sessionId);
    if (!found.ok || found.value.state !== "human_attached") {
      this.#forget(sessionId);
      return undefined;
    }
    const path = found.value.pty_log_path;
    const scrollback =
      path === null
        ? Promise.resolve(Buffer.alloc(0))
        : this.readScrollback(path).catch(() => Buffer.alloc(0));
    return new LivePtySession(
      sessionId,
      this.relay,
      this.store,
      scrollback,
      () => this.#forget(sessionId),
    );
  }

  /** Evicts `sessionId`'s cached promise so the next `open()` starts fresh. Safe to call by id
   * alone, with no "is this still the same entry" check: `open()` only ever writes a new entry
   * from a synchronous map-miss check, so a session can never be replaced while its own promise
   * is still the live entry — by the time anything calls this, either the entry is already this
   * one (the normal case) or it's already gone (a second caller lost a race to be first). */
  #forget(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  /** Drops a session's shared channel once nothing watches it. Idempotent; safe to call from a
   * socket's own `close` handler even if another tab is still watching. */
  release(sessionId: string): void {
    const pending = this.#sessions.get(sessionId);
    if (pending === undefined) return;
    void pending.then((session) => {
      if (session === undefined || !session.empty) return;
      if (this.#sessions.get(sessionId) !== pending) return;
      this.#sessions.delete(sessionId);
      session.close();
    });
  }
}
