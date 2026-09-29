/** A single-consumer async queue: `push` never blocks; iteration drains, then ends after `close`. */
export interface Channel<T> extends AsyncIterable<T> {
  push(value: T): void;
  close(): void;
  readonly closed: boolean;
}

export function createChannel<T>(): Channel<T> {
  const buffered: T[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const notify = () => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  return {
    get closed() {
      return closed;
    },
    push(value) {
      if (closed) return;
      buffered.push(value);
      notify();
    },
    close() {
      closed = true;
      notify();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (buffered.length > 0) {
          yield* buffered.splice(0);
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}
