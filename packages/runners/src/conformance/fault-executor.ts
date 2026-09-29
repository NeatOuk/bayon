// Faults for the conformance suite: an Executor that delegates everything and
// wraps each exec's stdout. Faults target a session's cwd, not a ref, so they reach the process a
// per-turn runner launches for the next turn. Runner-neutral.
import type { Clock, HealthLimits } from "@bayon/core";
import type {
  Argv,
  Capacity,
  CleanupMode,
  ExecOpts,
  Executor,
  ExecutorCapabilities,
  ExecutorHealthReport,
  ExecutorKind,
  Prepared,
  PrepareSpec,
  ProbeState,
  Proc,
  PtyOpts,
  PtyProc,
  SessionPlace,
} from "@bayon/executors";
import { frmError } from "../errors.js";
import { settlesWithin } from "../wait.js";
import { endGroups, type GroupsEnd } from "./groups.js";

const NEWLINE = 0x0a;
const encoder = new TextEncoder();

const runEnded = () =>
  frmError(
    "interrupted",
    "the conformance run has ended: no process may start",
  );

type Fault =
  | {
      readonly kind: "stall";
      readonly after: number;
      readonly fire: () => void;
    }
  | {
      readonly kind: "inject";
      readonly after: number;
      readonly bytes: Uint8Array;
      readonly fire: () => void;
    };

/** Tracks one armed fault: records seen since arming, and when it fired. */
interface Armed {
  readonly fault: Fault;
  seen: number;
}

export interface FaultOptions {
  /** Fire after this many more complete stdout records (default 1). */
  readonly afterRecords?: number;
}

export interface ArmedFault {
  /** Settles when the fault takes effect. */
  readonly fired: Promise<void>;
}

export class FaultExecutor implements Executor {
  readonly id: string;
  readonly kind: ExecutorKind;
  readonly capabilities: ExecutorCapabilities;
  /** The real executor's PATH and session places, so a claim or health check sees what it says. */
  readonly envPath?: string;
  readonly placeSession?: (sessionId: string) => SessionPlace;
  /** The real executor's image identity, so the report pins what the suite ran inside. */
  readonly imageIdentity?: () => Promise<string | null>;
  readonly #inner: Executor;
  // Fault bookkeeping per cwd: internal, never exposed.
  readonly #procs = new Map<string, Proc[]>();
  readonly #argv = new Map<string, Argv[]>();
  readonly #armed = new Map<string, Armed[]>();
  /** Every process launched through it, in order: the run's own, for its end. */
  #launched: readonly string[] = [];
  /** Execs not returned yet: end() waits for them before it looks at what was launched. */
  readonly #pending = new Set<Promise<Proc>>();
  /** end() has begun: no process starts any more. */
  #closed = false;

  constructor(inner: Executor) {
    this.#inner = inner;
    this.id = inner.id;
    this.kind = inner.kind;
    this.capabilities = inner.capabilities;
    if (inner.envPath !== undefined) this.envPath = inner.envPath;
    const place = inner.placeSession?.bind(inner);
    if (place !== undefined) this.placeSession = place;
    const image = inner.imageIdentity?.bind(inner);
    if (image !== undefined) this.imageIdentity = image;
  }

  prepare(spec: PrepareSpec): Promise<Prepared> {
    return this.#inner.prepare(spec);
  }

  exec(argv: Argv, opts: ExecOpts): Promise<Proc> {
    const started = this.#exec(argv, opts);
    this.#pending.add(started);
    const settled = () => {
      this.#pending.delete(started);
    };
    void started.then(settled, settled);
    return started;
  }

  async #exec(argv: Argv, opts: ExecOpts): Promise<Proc> {
    if (this.#closed) throw runEnded();
    const proc = await this.#inner.exec(argv, opts);
    this.#launched = [...this.#launched, proc.ref];
    if (this.#closed) {
      // Started while the run ended: killed at once, and waited for with the rest by end().
      proc.kill("SIGKILL");
      throw runEnded();
    }
    this.#argv.set(opts.cwd, [...(this.#argv.get(opts.cwd) ?? []), argv]);
    const wrapped: Proc = {
      ref: proc.ref,
      stdin: proc.stdin,
      stdout: this.#wrap(proc.stdout, opts.cwd),
      stderr: proc.stderr,
      kill: (signal) => proc.kill(signal),
      exited: proc.exited,
    };
    this.#procs.set(opts.cwd, [...(this.#procs.get(opts.cwd) ?? []), wrapped]);
    return wrapped;
  }

  pty(argv: Argv, opts: PtyOpts): Promise<PtyProc> {
    return this.#inner.pty(argv, opts);
  }

  probe(ref: string): Promise<ProbeState> {
    return this.#inner.probe(ref);
  }

  cleanup(ref: string, mode: CleanupMode): Promise<void> {
    return this.#inner.cleanup(ref, mode);
  }

  capacity(): Capacity {
    return this.#inner.capacity();
  }

  health(limits: HealthLimits): Promise<ExecutorHealthReport> {
    return this.#inner.health(limits);
  }

  /** From the next record boundary on, drop every stdout byte, still draining the process. */
  stall(cwd: string, options: FaultOptions = {}): ArmedFault {
    const fired = Promise.withResolvers<undefined>();
    this.#arm(cwd, {
      kind: "stall",
      after: Math.max(1, options.afterRecords ?? 1),
      fire: () => fired.resolve(undefined),
    });
    return { fired: fired.promise };
  }

  /** Writes each line (`JSON + "\n"`) at the next record boundary; a real line is never split. */
  inject(
    cwd: string,
    lines: readonly Readonly<Record<string, unknown>>[],
    options: FaultOptions = {},
  ): ArmedFault {
    const fired = Promise.withResolvers<undefined>();
    this.#arm(cwd, {
      kind: "inject",
      after: Math.max(1, options.afterRecords ?? 1),
      bytes: encoder.encode(
        lines.map((l) => `${JSON.stringify(l)}\n`).join(""),
      ),
      fire: () => fired.resolve(undefined),
    });
    return { fired: fired.promise };
  }

  /** `kill -9` of the latest process launched in `cwd`, through its executor's own `Proc.kill`. */
  kill9(cwd: string): boolean {
    const proc = this.#procs.get(cwd)?.at(-1);
    proc?.kill("SIGKILL");
    return proc !== undefined;
  }

  /** The ref of the latest process launched in `cwd`. */
  refOf(cwd: string): string | undefined {
    return this.#procs.get(cwd)?.at(-1)?.ref;
  }

  /** The ref of every process launched in `cwd`, in order: a session's own. */
  refsOf(cwd: string): readonly string[] {
    return (this.#procs.get(cwd) ?? []).map((p) => p.ref);
  }

  /** The ref of every process launched through this executor, in order. */
  launched(): readonly string[] {
    return this.#launched;
  }

  /**
   * Ends the run's processes: no exec starts from now on, and one still returning is
   * waited for (up to `killMs`) and killed as it returns. Then every group launched through here
   * that is still alive is killed and waited for, up to `killMs`. What was killed, and what
   * outlived its kill, comes back.
   */
  async end(clock: Clock, killMs: number): Promise<GroupsEnd> {
    this.#closed = true;
    await settlesWithin(Promise.allSettled([...this.#pending]), clock, killMs);
    return endGroups(this, this.#launched, clock, { graceMs: 0, killMs });
  }

  /** The exit of the latest process launched in `cwd`. */
  exitedOf(cwd: string): Proc["exited"] | undefined {
    return this.#procs.get(cwd)?.at(-1)?.exited;
  }

  /** Every argv launched in `cwd`, in order. The env is never recorded. */
  argvOf(cwd: string): readonly Argv[] {
    return this.#argv.get(cwd) ?? [];
  }

  #arm(cwd: string, fault: Fault): void {
    this.#armed.set(cwd, [...(this.#armed.get(cwd) ?? []), { fault, seen: 0 }]);
  }

  /** Counts a completed record against the cwd's first armed fault; returns it once it fires. */
  #recordDone(cwd: string): Fault | undefined {
    const queue = this.#armed.get(cwd);
    const first = queue?.[0];
    if (queue === undefined || first === undefined) return undefined;
    first.seen += 1;
    if (first.seen < first.fault.after) return undefined;
    this.#armed.set(cwd, queue.slice(1));
    return first.fault;
  }

  async *#wrap(
    source: AsyncIterable<Uint8Array>,
    cwd: string,
  ): AsyncGenerator<Uint8Array> {
    let dropping = false;
    for await (const chunk of source) {
      if (dropping) continue; // drained, never delivered
      let rest = chunk;
      while (rest.length > 0) {
        if ((this.#armed.get(cwd)?.length ?? 0) === 0) {
          yield rest;
          break;
        }
        const nl = rest.indexOf(NEWLINE);
        if (nl === -1) {
          yield rest;
          break;
        }
        yield rest.subarray(0, nl + 1);
        rest = rest.subarray(nl + 1);
        const fired = this.#recordDone(cwd);
        if (fired === undefined) continue;
        fired.fire();
        if (fired.kind === "inject") {
          yield fired.bytes;
        } else {
          dropping = true;
          break;
        }
      }
    }
  }
}
