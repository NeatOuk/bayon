/**
 * Runs async ops one at a time per key, in arrival order: a promise chain per key. The lifecycle
 * keys one by session id, so a session's handlers, pipeline, timer and reconciler actions never
 * interleave, and one by mirror path for git. An op must never await another op of its own key.
 */
export class KeyedQueue {
  readonly #tails = new Map<string, Promise<void>>();

  run<T>(key: string, op: () => Promise<T>): Promise<T> {
    const result = (this.#tails.get(key) ?? Promise.resolve()).then(op);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return result;
  }

  /** No op is queued or running under any key. */
  idle(): boolean {
    return this.#tails.size === 0;
  }

  /** Settles once every op queued so far, and every op those queue, has settled. */
  async settled(): Promise<void> {
    while (this.#tails.size > 0) await Promise.all(this.#tails.values());
  }
}
