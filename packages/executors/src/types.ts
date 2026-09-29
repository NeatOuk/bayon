// The Executor contract (spec §6): where a process runs, independent of what runs. Nothing here
// names a Node, pty or OS type, so container and ssh executors can implement it unchanged.
import type {
  ExecutorHealthFields,
  HealthLimits,
  JsonValue,
} from "@bayon/core";

/** A program and its arguments. argv[0] is the program, never a shell string. */
export type Argv = readonly [string, ...string[]];

export type ExecutorKind = "local" | "container" | "remote";

export type KillSignal = "SIGINT" | "SIGTERM" | "SIGKILL" | "SIGHUP";

/** Zombies and reaped processes are both `dead` (spec amendment 10). */
export type ProbeState = "alive" | "dead";

/** `soft` asks the process to stop (SIGTERM); `hard` makes it (SIGKILL). */
export type CleanupMode = "soft" | "hard";

export interface Capacity {
  readonly slots: number;
  readonly used: number;
}

/** Exactly one of `code` (normal exit) or `signal` (killed, e.g. `SIGTERM`) is non-null. */
export interface ExitStatus {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface PrepareSpec {
  readonly sessionId: string;
  /** The session root, as the supervisor names it; created if missing. */
  readonly root: string;
}

export interface Prepared {
  /** The session root as seen by processes this executor runs (a container mounts it elsewhere). */
  readonly root: string;
  /** The API's /mcp as this executor's programs reach it, when that is not the supervisor's URL
   * (a container reaches it through its executor's gateway). */
  readonly mcpUrl?: string;
  /** The egress proxy this executor's programs must use (an allowlist executor's gateway). */
  readonly proxyUrl?: string;
}

/** A health check (§6.1, §13.2): the fields every kind reports (core ExecutorHealthFields: disk,
 * clock skew, the limits judged against, failures), plus whatever its own kind adds (a container's
 * docker, image and tunnel). */
export interface ExecutorHealthReport {
  /** No failures: the executor may take sessions. */
  readonly healthy: boolean;
  /** What was measured, recorded as `executors.health_detail`. */
  readonly detail: ExecutorHealthFields & { readonly [key: string]: JsonValue };
}

export interface ExecOpts {
  readonly cwd: string;
  /** The child's entire environment. Nothing is inherited from the supervisor (§14). */
  readonly env: Readonly<Record<string, string>>;
  /** `pipe` (default) gives `Proc.stdin`; `ignore` gives the program EOF and `Proc.stdin = null`. */
  readonly stdin?: "pipe" | "ignore";
  /** Default true: the process leads its own process group, so `kill` reaches every descendant
   * and signals aimed at the supervisor's terminal do not reach it. */
  readonly detached?: boolean;
  /** Aborting kills with SIGKILL; an already-aborted signal refuses to spawn (`interrupted`). */
  readonly signal?: AbortSignal;
}

export interface ProcStdin {
  /** Rejects once the program has stopped reading (e.g. it exited). */
  write(chunk: string | Uint8Array): Promise<void>;
  end(): Promise<void>;
}

export interface Proc {
  /** Opaque and persistable; `probe` and `cleanup` accept it after a supervisor restart. */
  readonly ref: string;
  readonly stdin: ProcStdin | null;
  /** Each stream yields in write order. Drain both: an unread pipe eventually blocks the program. */
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  /** Signals the process and its descendants while it runs. Default SIGTERM. A no-op once it
   * has exited: its pid may already belong to another process, so descendants it left behind
   * are the reconciler's to reap (§9.6). */
  kill(signal?: KillSignal): void;
  /** Settles when the process exits; never rejects. */
  readonly exited: Promise<ExitStatus>;
}

export interface PtyOpts {
  readonly cwd: string;
  /** The child's entire environment, as for `exec`. */
  readonly env: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
}

/** A process on a terminal, for operator takeover (§12.5). */
export interface PtyProc {
  readonly ref: string;
  readonly output: AsyncIterable<string>;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** As `Proc.kill`: the process group while it runs, a no-op once it has exited. */
  kill(signal?: KillSignal): void;
  readonly exited: Promise<ExitStatus>;
}

/** Where a session's files live when they are not under the supervisor's FRM_HOME: a container's
 * root (= `Prepared.root`), and the private home and tmp inside it. */
export interface SessionPlace {
  readonly root: string;
  readonly home: string;
  readonly tmp: string;
}

/** A pin ref (`refs/frm/gate/<gate id>` or `refs/frm/pin/<session id>`) and the mirror holding it. */
export interface MirrorPin {
  /** The mirror's name: a repo id. */
  readonly name: string;
  readonly ref: string;
}

/** Mirrors an executor keeps because its programs cannot see the supervisor's (a docker host). */
export interface ExecutorMirrors {
  /** Mirror `name` (a repo id) as this executor's programs see it; read-only to sessions. */
  path(name: string): string;
  /** Pushes `refspecs` from the supervisor's bare `localMirror` into mirror `name`, creating it.
   * Never a deletion: pin refs go only through `dropPins`. */
  push(o: {
    readonly localMirror: string;
    readonly name: string;
    readonly refspecs: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<void>;
  /**
   * Fetches `refspecs` out of the repository at `dir` in session `sessionId` into the supervisor's
   * bare `localMirror` — the other direction, for a gate whose subject was built here.
   * The pack is served from inside that session's own container and received by the supervisor's
   * own git, so nothing on the executor's host reads session content. Each refspec names a full
   * object id (one the supervisor has already read) onto a pin ref; anything else is refused
   * (`validation`), as is a `dir` outside the session's root.
   */
  fetchFromSession(o: {
    readonly localMirror: string;
    readonly sessionId: string;
    readonly dir: string;
    readonly refspecs: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<void>;
  /** Every pin ref of every mirror here; nothing else is read. */
  listPins(): Promise<readonly MirrorPin[]>;
  /** Deletes pin refs from mirror `name`. Anything but a pin ref is refused (`validation`) before
   * anything runs; a missing mirror or ref is a no-op. */
  dropPins(name: string, refs: readonly string[]): Promise<void>;
}

/** What `release` does with an ended session's root: `keep` it (work in progress, §9.2) or not. */
export interface ReleaseOptions {
  readonly root: "keep" | "remove";
}

/** A resource an executor holds for a session, found by its own tags. */
export interface Owned {
  readonly kind: "process" | "container";
  readonly sessionId: string;
  /** `local:<pid>:<start>` (probe and cleanup accept it), or the container's id. */
  readonly ref: string;
  /** The process's FRM_HOME_TAG, or the container's frm.home label; null when a container made
   * before an earlier change has none. */
  readonly homeTag: string | null;
}

/** What an executor can do beyond `exec`; static, so a caller decides before calling. */
export interface ExecutorCapabilities {
  /** `pty()` for operator takeover (§12.5). Without it, `pty()` rejects `validation`. */
  readonly pty: boolean;
}

export interface Executor {
  readonly id: string;
  readonly kind: ExecutorKind;
  readonly capabilities: ExecutorCapabilities;
  /** Ensures the session root (and, per kind, mounts, image, limits) before any spawn. */
  prepare(spec: PrepareSpec): Promise<Prepared>;
  /** Resolves once the program has started; a program that cannot start is `spawn_failed`. */
  exec(argv: Argv, opts: ExecOpts): Promise<Proc>;
  /** Unlike `exec`, resolves even when the program cannot start: node-pty reports that failure
   * through the pty's own exit code (typically 1) rather than rejecting, since the failure
   * happens inside the forked terminal, after node-pty has already handed back a process. Every
   * implementation matches this — no `spawn_failed` rejection from `pty()`. */
  pty(argv: Argv, opts: PtyOpts): Promise<PtyProc>;
  /** Health (§6.1; "Amendments — M4": it joins the executor contract): disk, clock skew and, where
   * it applies, docker, judged against `limits` (the fleet's settings, which an executor's own
   * configured limits may only tighten). Bounded by the executor; never rejects. */
  health(limits: HealthLimits): Promise<ExecutorHealthReport>;
  /** `ref` must come from this executor; anything else is refused (`validation`). */
  probe(ref: string): Promise<ProbeState>;
  /** Signals the process behind `ref` if it is still alive; a dead ref is a no-op. */
  cleanup(ref: string, mode: CleanupMode): Promise<void>;
  capacity(): Capacity;
  /** PATH for the programs it runs, when not the supervisor's (a container's). */
  readonly envPath?: string;
  /** Where a session's root, home and tmp live, when not under the supervisor's FRM_HOME. */
  placeSession?(sessionId: string): SessionPlace;
  /** Mirrors of its own, when its programs cannot see the supervisor's. */
  readonly mirrors?: ExecutorMirrors;
  /**
   * What this executor holds for sessions, found by its own tags and nothing less (   * §4): a local executor's processes by their environment, a container executor's containers by
   * their labels. The reconciler's orphans come from here.
   */
  listOwned?(): Promise<readonly Owned[]>;
  /** Frees what `prepare` made for an ended session (a container executor: by its labels). */
  release?(sessionId: string, o: ReleaseOptions): Promise<void>;
  /**
   * What this executor runs its sessions *from*, when that is a thing with an identity: a container
   * executor's configured image, resolved to the id the docker host holds it under. A
   * certified runner on such an executor lives inside that image, so a rebuild behind the same tag
   * is a different subject and lapses the pair. Null when it cannot be read now (the host is down,
   * the image is gone) — that is not drift, and nothing is decertified for it.
   */
  imageIdentity?(): Promise<string | null>;
  /**
   * Adopts this executor's row as the DB holds it now, mid-life. Executors are built at
   * boot, but the DB is the system of record and an operator may write to it while the supervisor
   * runs — `frm executor image` does, and an executor still holding its boot-time image tore down
   * the gateway that rebuild had just started, as foreign. Only what is safe to change without a
   * restart is adopted; anything live (an ssh master, a tunnel) still needs one.
   *
   * Returns what it adopted, for the caller to log; null *only* when the row says nothing new. A
   * row it cannot parse comes back as its own line — an operator's edit that the
   * supervisor ignores has to be readable somewhere, and one null meaning both "nothing changed"
   * and "I could not read it" is how it was not.
   */
  reloadConfig?(config: unknown): string | null;
  /**
   * When this executor saw the child behind `ref` fire its own exit, on its clock; null while it
   * runs, or for a ref it did not start. A descendant may still hold the
   * child's pipes: the exit is the child's, not its streams'.
   */
  exitedAt?(ref: string): number | null;
  /**
   * For a ref whose own child has exited: ends the stdout and stderr streams it handed out,
   * detaching first, so the reader reads what is left and then EOF. `draining` while a reader is
   * behind, unless `force`. It never signals anything.
   */
  releasePipes?(ref: string, o?: { readonly force?: boolean }): PipeRelease;
}

/** What releasePipes did. */
export interface PipeRelease {
  /** `released`: both streams ended. `draining`: a reader is behind; ask again. `unknown`: no such
   * ref, or its child has not exited. */
  readonly state: "released" | "draining" | "unknown";
  /** Bytes buffered and not yet read when it was asked: cut, when forced. */
  readonly pendingBytes: number;
}
