import { useRef } from "react";

/**
 * One key per logical operation. A key identifies an *attempt at a thing*, not a
 * request: a staff click that fails ambiguously — the server may well have created the command
 * before the connection broke — must be retried under the same key, so the server returns that
 * first command instead of spawning a second session. Minting a fresh key inside the request, or
 * per render, would defeat the whole mechanism.
 *
 * So the key lives from the first attempt until the operation is known to have succeeded:
 * `current()` mints once and then keeps returning the same value, and `settle()` (called on
 * success) drops it so the operator's *next*, genuinely separate action gets a key of its own.
 *
 * A ref, not state: changing it must never re-render, and every caller reads it inside an event
 * handler or a mutation, never during render.
 */
export interface IdempotencyKey {
  /** This operation's key, minted on first use and stable across every retry of it. */
  current(): string;
  /** The operation finished: the next one is a new operation and gets a new key. */
  settle(): void;
}

export function useIdempotencyKey(): IdempotencyKey {
  const key = useRef<string | undefined>(undefined);
  const held = useRef<IdempotencyKey | undefined>(undefined);
  held.current ??= {
    current: () => (key.current ??= crypto.randomUUID()),
    settle: () => {
      key.current = undefined;
    },
  };
  return held.current;
}
