/** Whether a process has an open run: set by `send`, cleared by the run's terminal or the exit. */
export class RunTracker {
  #open = false;
  #waiters: (() => void)[] = [];

  get open(): boolean {
    return this.#open;
  }

  opened(): void {
    this.#open = true;
  }

  ended(): void {
    this.#open = false;
    for (const wake of this.#waiters.splice(0)) wake();
  }

  /** Resolves when the open run ends, or at once if none is open. */
  whenEnded(): Promise<void> {
    return this.#open
      ? new Promise((resolve) => this.#waiters.push(resolve))
      : Promise.resolve();
  }
}
