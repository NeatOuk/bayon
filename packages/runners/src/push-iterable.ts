/** A push-driven async iterable with one consumer: a runner's prompt stream. */
export interface PushIterable<T> extends AsyncIterable<T> {
  /** Queues a value; false once the stream has ended. */
  push(value: T): boolean;
  /** Ends the stream once the queued values are taken. */
  end(): void;
  readonly ended: boolean;
}

export function createPushIterable<T>(): PushIterable<T> {
  const queued: T[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  const notify = () => {
    const resume = wake;
    wake = undefined;
    resume?.();
  };
  return {
    get ended() {
      return ended;
    },
    push(value) {
      if (ended) return false;
      queued.push(value);
      notify();
      return true;
    },
    end() {
      ended = true;
      notify();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queued.length > 0) {
          yield* queued.splice(0);
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}
