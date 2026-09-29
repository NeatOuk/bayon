// Release candidates: every process an adapter handed back, kept until
// nothing more can come from it. A scan of ctx.live cannot see them all: onProcessGone swaps the
// entry to dead before it awaits handle.exited, and a process that was never attached has no
// entry with it. So spawn and adopt track the handle as soon as the adapter returns it, and
// attachProcess tracks it again with ingest's `closed`. A candidate goes once the handle's exit has
// settled and, when ingest attached, its `closed` too (escape 1: a descendant holding only stdout
// lets the exit settle first).
import type { Executor } from "@bayon/executors";
import type { SessionHandle } from "@bayon/runners";

export interface ReleaseCandidate {
  readonly sessionId: string;
  readonly executor: Executor;
  readonly ref: string;
  readonly handle: SessionHandle;
  /** Ingest attached: its EOF (then the run's terminal) is awaited. */
  readonly attached: boolean;
  /** Ingest's `closed` settled; meaningless while not attached. */
  readonly closed: boolean;
  /** The handle's exit settled: the process exited and its stderr drained. */
  readonly exited: boolean;
}

export class ReleaseCandidates {
  readonly #byHandle = new Map<SessionHandle, ReleaseCandidate>();

  /**
   * Tracks `handle`: after the adapter handed it back (no `closed` yet), and again when ingest
   * attaches (with its `closed`). A second call replaces the record; each subscribes afresh.
   */
  track(
    sessionId: string,
    executor: Executor,
    handle: SessionHandle,
    closed?: Promise<unknown>,
  ): void {
    this.#byHandle.set(handle, {
      sessionId,
      executor,
      ref: handle.executorRef,
      handle,
      attached: closed !== undefined,
      closed: false,
      exited: false,
    });
    const settle = (patch: Partial<ReleaseCandidate>) => () =>
      this.#settle(handle, patch);
    void handle.exited.then(settle({ exited: true }), settle({ exited: true }));
    void closed?.then(settle({ closed: true }), settle({ closed: true }));
  }

  /** Every candidate, as a snapshot. */
  list(): readonly ReleaseCandidate[] {
    return [...this.#byHandle.values()];
  }

  #settle(handle: SessionHandle, patch: Partial<ReleaseCandidate>): void {
    const current = this.#byHandle.get(handle);
    if (current === undefined) return;
    const next = { ...current, ...patch };
    if (next.exited && (!next.attached || next.closed)) {
      this.#byHandle.delete(handle);
    } else {
      this.#byHandle.set(handle, next);
    }
  }
}

/** Stuck: its exit settled or not, something of it is still awaited (§3.1). */
export const awaited = (c: ReleaseCandidate): boolean =>
  !c.exited || (c.attached && !c.closed);
