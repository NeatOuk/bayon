import { err, ok, type Clock, type FrmError, type Result } from "@bayon/core";
import { getSession, type Db } from "@bayon/db";
import { CursorClient } from "@bayon/proto";
import { pollUntil } from "./deadline.js";
import { isAlive, stopChild, type Child } from "./procs.js";

// What one smoke owns (processes, sockets, the DB, the sessions it spawned) and the step runner.
// Teardown releases all of it whatever failed, and fails the smoke if a runner outlives it.

const STOP_GRACE_MS = 10_000;
const REAP_TIMEOUT_MS = 10_000;

export interface SmokeIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock: Clock;
  readonly out: (line: string) => void;
}

/** A failed step: its name and why. Thrown by `step`, caught once by runSmoke. */
export class StepFailure extends Error {
  constructor(
    readonly step: string,
    readonly reason: FrmError,
  ) {
    super(`${step}: ${reason.message}`);
  }
}

export const refuse = (message: string): FrmError => ({
  class: "validation",
  message,
  retryable: false,
});

/** ok when there are no problems, else one error listing them all. */
export const verdict = (problems: readonly string[]): Result<void> =>
  problems.length === 0 ? ok(undefined) : err(refuse(problems.join("; ")));

export const seconds = (ms: number): string => `${(ms / 1_000).toFixed(1)} s`;

/** A runner's pid from a `local:<pid>:<start>` executor ref. */
const refPid = (ref: string | null): number | undefined => {
  const pid = /^local:(\d+):/.exec(ref ?? "")?.[1];
  return pid === undefined ? undefined : Number(pid);
};

export class Harness {
  readonly home: string;
  readonly io: SmokeIo;
  #children: readonly Child[] = [];
  #clients: readonly CursorClient[] = [];
  #sessions: readonly string[] = [];
  #notes: readonly string[] = [];
  #deferred: readonly {
    readonly name: string;
    readonly run: () => Promise<readonly string[]>;
  }[] = [];
  #db: Db | undefined;

  constructor(io: SmokeIo, home: string) {
    this.io = io;
    this.home = home;
  }

  get clock(): Clock {
    return this.io.clock;
  }

  /** Runs one step and prints it; a failure ends the smoke with the step's name and reason. */
  async step<T>(name: string, work: () => Promise<Result<T>>): Promise<T> {
    const t0 = this.clock.now();
    const done = await work();
    if (!done.ok) throw new StepFailure(name, done.error);
    this.io.out(`  ok  ${name}  (${seconds(this.clock.now() - t0)})`);
    return done.value;
  }

  own(child: Child): void {
    this.#children = [...this.#children, child];
  }

  useDb(db: Db): void {
    this.#db = db;
  }

  /** A session the smoke spawned: its runner process is checked at teardown. */
  track(sessionId: string): void {
    if (this.#sessions.includes(sessionId)) return;
    this.#sessions = [...this.#sessions, sessionId];
  }

  /**
   * Work for teardown once every child has stopped (a remote host's cleanup, say): newest first,
   * whatever failed before. Its problems fail the smoke; a throw is one problem.
   */
  defer(name: string, run: () => Promise<readonly string[]>): void {
    this.#deferred = [...this.#deferred, { name, run }];
  }

  /** Context printed only if the smoke fails. */
  note(line: string): void {
    this.#notes = [...this.#notes, line].slice(-20);
  }

  notes(): readonly string[] {
    return this.#notes;
  }

  /** A CursorClient on Node's WebSocket with the bearer, closed at teardown. */
  client(wsUrl: string, token: string): CursorClient {
    const client = new CursorClient({
      connect: () =>
        new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } }),
      clock: this.clock,
      reconnect: { initialMs: 100, maxMs: 1_000 },
      onError: (e) => this.note(`ws: ${e.class}: ${e.message}`),
    });
    this.#clients = [...this.#clients, client];
    return client;
  }

  closeClients(): void {
    for (const client of this.#clients) client.close();
    this.#clients = [];
  }

  /** Stops everything, newest first; the problems left are runner processes that outlived it. */
  async teardown(): Promise<string[]> {
    this.closeClients();
    const pids = await this.#runnerPids();
    for (const child of this.#children.toReversed())
      if (child.status() === undefined)
        await stopChild(child, this.clock, STOP_GRACE_MS);
    const orphans = await this.#reap(pids);
    const deferred: string[] = [];
    for (const d of this.#deferred.toReversed()) {
      try {
        deferred.push(...(await d.run()));
      } catch (e) {
        deferred.push(
          `${d.name}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    this.#deferred = [];
    await this.#db?.close();
    return [...orphans, ...deferred];
  }

  async #runnerPids(): Promise<number[]> {
    const db = this.#db;
    if (db === undefined) return [];
    const rows = await Promise.all(
      this.#sessions.map((id) => getSession(db, id)),
    );
    return rows.flatMap((row) => {
      const pid = row.ok ? refPid(row.value.executor_ref) : undefined;
      return pid === undefined ? [] : [pid];
    });
  }

  /** Runners die on stdin EOF once the supervisor is gone; any still alive are killed and reported. */
  async #reap(pids: readonly number[]): Promise<string[]> {
    const gone = await pollUntil(
      {
        clock: this.clock,
        timeoutMs: REAP_TIMEOUT_MS,
        intervalMs: 100,
        what: "runner processes gone",
      },
      async () => ok(pids.some(isAlive) ? undefined : true),
    );
    if (gone.ok) return [];
    const alive = pids.filter(isAlive);
    for (const pid of alive) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (e) {
        this.note(`kill ${pid}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return [
      `runner process(es) ${alive.join(", ")} outlived the supervisor (killed)`,
    ];
  }
}
