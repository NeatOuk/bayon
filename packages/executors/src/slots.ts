import { frmError } from "./errors.js";
import type { Capacity } from "./types.js";

/** One held slot. `release` is idempotent. */
export interface Slot {
  release(): void;
}

/**
 * An executor's concurrency slots (`executors.slots`). Admission takes one per session with
 * `tryAcquire` and owns the waiting itself, visibly, as a queued session;
 * capacity follows the row through `resize` and is never persisted. After a supervisor restart the
 * reconciler re-adopts the processes it finds running with `restore(n)`.
 */
export class SlotCounter {
  #slots: number;
  #used = 0;
  #listeners: ReadonlySet<() => void> = new Set();

  constructor(slots: number) {
    assertCount(slots, "slots");
    this.#slots = slots;
  }

  capacity(): Capacity {
    return { slots: this.#slots, used: this.#used };
  }

  /** A slot when one is free; null at capacity (0 slots drains the executor). */
  tryAcquire(): Slot | null {
    if (this.#used >= this.#slots) return null;
    this.#used += 1;
    return this.#hold();
  }

  /** The capacity from `executors.slots` now. Shrinking below `used` preempts nothing. */
  resize(slots: number): void {
    assertCount(slots, "slots");
    this.#slots = slots;
  }

  /**
   * Calls `fn` after every release, whoever releases: admission's wake.
   * A listener must not throw. Returns the unsubscribe.
   */
  onRelease(fn: () => void): () => void {
    this.#listeners = new Set([...this.#listeners, fn]);
    return () => {
      this.#listeners = new Set(
        [...this.#listeners].filter((listener) => listener !== fn),
      );
    };
  }

  /** Marks `count` already-running processes as holding slots, even past capacity. */
  restore(count: number): Slot[] {
    assertCount(count, "restore count");
    this.#used += count;
    return Array.from({ length: count }, () => this.#hold());
  }

  #hold(): Slot {
    let held = true;
    return {
      release: () => {
        if (!held) return;
        held = false;
        this.#used -= 1;
        for (const listener of this.#listeners) listener();
      },
    };
  }
}

/**
 * `count` slots at once, or none: the all-or-nothing claim a workload that needs room for several
 * sessions wants (a conformance suite's peak). A partial take is released before
 * returning null, so a refused claim leaves the counter exactly as it found it and never strands a
 * slot. The returned `Slot` releases every one of them, and is idempotent like any other.
 */
export function tryAcquireAll(
  counter: SlotCounter,
  count: number,
): Slot | null {
  assertCount(count, "count");
  const held: Slot[] = [];
  while (held.length < count) {
    const slot = counter.tryAcquire();
    if (slot === null) {
      for (const taken of held) taken.release();
      return null;
    }
    held.push(slot);
  }
  return {
    release: () => {
      for (const taken of held) taken.release();
    },
  };
}

function assertCount(count: number, what: string): void {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw frmError(
      "validation",
      `${what} must be a non-negative integer, got ${count}`,
    );
  }
}
