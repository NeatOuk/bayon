// The runner contract (contract 4, spec §5), runner-neutral. Adapter specifics ride in `flags` and
// never in these types (Invariant 1). Optional fields are absent, never null.
import type { CanonicalEvent, Result, RunnerCaps } from "@bayon/core";
import type { Executor, ExecutorKind } from "@bayon/executors";

/** What the supervisor resolved for one runner process. */
export type SpawnSpec = {
  /** Our session id (a ULID). */
  readonly sessionId: string;
  /** The worktree the agent works in. */
  readonly cwd: string;
  /**
   * Absolute paths, as the executor's programs see them, that the runner must be able to read and
   * write besides `cwd`: a multi-repo workspace's non-primary worktrees (§3.1).
   * Paths only: each adapter grants them its own way, or refuses. Absent when there are none.
   */
  readonly extraRoots?: readonly string[];
  /** The session's private runner home (§11.3): all runner state lives here. */
  readonly homeDir: string;
  /** The child's complete environment, secrets resolved. Nothing else is inherited. */
  readonly env: Readonly<Record<string, string>>;
  /** The models row for the session's tier. */
  readonly model: string;
  readonly effort?: string;
  /**
   * That models row's own settings (`models.settings_json`), which its adapter's
   * `validateModel` accepted when the operator wrote them; each adapter parses its own again.
   * Absent when the row has none.
   */
  readonly modelSettings?: Readonly<Record<string, unknown>>;
  /** Set to adopt a session whose process died (amendment 2). */
  readonly resumeRunnerSessionId?: string;
  /** The runner row's defaults merged with the profile; each adapter parses its own. */
  readonly flags: Readonly<Record<string, unknown>>;
  /**
   * The session's MCP server, runner-neutral: each adapter mounts it its own
   * way. `token` is the plaintext, held in memory only; `tools` are the wire names it may call.
   */
  readonly mcp?: {
    readonly url: string;
    readonly token: string;
    readonly tools: readonly string[];
  };
  /**
   * `none`: the runner withholds its own tools (shell, files, search, subagents), so the session
   * has only the MCP tools in `mcp` (plan rule 4: pulse sessions). Absent: the runner's defaults.
   */
  readonly builtinTools?: "none";
  /**
   * A login file the operator granted this runner for in-place use (§14): the path it
   * was read from, the bytes it held and the mode it was found with. Runner-neutral, like
   * `extraRoots` — an adapter that knows what the file is declares `readsGrantedLogin: true` in its
   * registration's defaults (core READS_GRANTED_LOGIN), places the file and returns the rotated
   * value to the same path. The supervisor hands it to no other runner: a grant naming one that does
   * not declare it is refused at spawn, adopt and conformance, naming the setting and the runner
   *. Every shipped adapter that cannot read one refuses the spawn if handed one
   * anyway, rather than start with no credential; the test adapters (fixture, script, broken-stub)
   * do not check. Absent unless the operator consented (`settings.runners.login_in_place`), which is
   * the default. It is a credential: never logged, never stored, redacted from this session's records.
   */
  readonly grantedLogin?: {
    readonly path: string;
    readonly value: string;
    readonly mode: number;
  };
  /**
   * The structured-output schema every run of this session answers to (SendSpec.output's), known
   * at spawn because an internal spawn carries its run 1 (a gate's reviewer). For a runner that fixes
   * its schema when its process starts; one that takes it per turn reads SendSpec.output alone and
   * ignores this. Absent for a session whose runs carry no output.
   */
  readonly output?: {
    readonly schema: Readonly<Record<string, unknown>>;
  };
  /**
   * Context compression (spec M12): the session's model calls go through a context proxy that
   * compresses large tool results and stores each original under `storeDir`. Only an adapter that
   * declares `compressesContext` for the executor honours it; any other refuses. Absent: off, and
   * the session starts exactly as it would without this field.
   */
  readonly contextCompression?: {
    /** The session's pinned ruleset; an adapter refuses one this build cannot apply. */
    readonly ruleset: string;
    /**
     * Absolute: where originals are stored, `<session root>/.foreman/ctx`. Supervisor-owned and
     * outside every root the session writes (its worktrees, its home), so nothing the session does
     * can redirect the proxy's writes; the runner is granted it to read. Adapters refuse any other.
     */
    readonly storeDir: string;
    /**
     * The proxy's bearer: 32 random bytes, hex. A secret like `mcp.token`: held in memory and the
     * child's env only, never logged, never on argv, redacted from this session's records.
     */
    readonly token: string;
  };
};

/** One prompt, which opens one run. The supervisor mints `runId`. */
export type SendSpec = {
  readonly runId: string;
  readonly text: string;
  readonly promptPath: string;
  /**
   * Structured output (M3 contracts): a runner declaring `outputSchema` writes its final answer,
   * valid against `schema`, to `path`. A type only here; the adapters that declare the cap honour
   * it. The rest ignore it. A runner whose schema is fixed at spawn refuses a
   * schema that is not SpawnSpec.output's.
   */
  readonly output?: {
    readonly schema: Readonly<Record<string, unknown>>;
    readonly path: string;
  };
};

/** One stdout line, verbatim and without its "\n". `partial` marks a fragment cut off by EOF. */
export type RawRecord = {
  readonly bytes: Uint8Array;
  readonly partial: boolean;
};

/** A raw-log record to map: its first byte's offset in the log, its bytes, and its ingest time. */
export type MapInput = {
  readonly offset: number;
  readonly bytes: Uint8Array;
  readonly ts: number;
  readonly partial?: boolean;
};

/**
 * A canonical event and its position within the record it came from. The supervisor stores it at
 * `raw_offset = offset + ordinal`; ordinals stay below the record's length, so offsets never
 * collide across records.
 */
export type MappedEvent = CanonicalEvent & { readonly ordinal: number };

/**
 * Maps one process segment's records, in log order. Pure over that sequence: the same records
 * with the same `ts` give the same events, so a replay is idempotent. Never throws.
 */
export interface Mapper {
  map(input: MapInput): readonly MappedEvent[];
}

/** How a runner process ended. Forensics only: a run's outcome comes from its `terminal` event. */
export type ExitInfo = {
  readonly code?: number;
  readonly signal?: string;
  readonly stderrTail: string;
};

export type SessionHandle = {
  readonly sessionId: string;
  /** Set once `spawn`/`adopt` resolves for every resumable runner; the reconciler adopts by it. */
  readonly runnerSessionId?: string;
  /** The executor's process ref, e.g. `local:<pid>:<start>`. */
  readonly executorRef: string;
  readonly exited: Promise<ExitInfo>;
};

/** What a human types into, resuming `runnerSessionId` interactively (§12.5). */
export type InteractiveResume = {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
};

export type ModelTier = "complex" | "standard" | "cheap";

/** A `models` row (§4) as an adapter proposes it. Prices are USD per million tokens. */
export type ModelRow = {
  readonly id: string;
  readonly tier: ModelTier;
  readonly model: string;
  readonly effort?: string;
  readonly priceInPerMtok: number;
  readonly priceOutPerMtok: number;
  readonly priceCacheReadPerMtok: number;
  readonly priceCacheWritePerMtok: number;
  /** The window a session on this model actually gets, as its runner is spawned. */
  readonly contextTokens: number;
  /**
   * Registered, but not its tier's active row: boot writes it inactive and keeps it, and
   * its certificates, so an operator can switch the tier back to it. A registration has one row per
   * tier that is not on standby.
   */
  readonly standby?: boolean;
};

/**
 * A models row the operator proposes, as its runner's adapter judges it: the adapter
 * owns what a model string and its settings may be (Invariant 1).
 */
export type ModelProposal = {
  readonly id: string;
  readonly tier: ModelTier;
  readonly model: string;
  readonly effort?: string;
  /** The row's adapter settings; `{}` when it has none. */
  readonly settings: Readonly<Record<string, unknown>>;
  /** The row's `context_tokens`; absent when it has none. */
  readonly contextTokens?: number;
};

/** What a model is judged against: the runner row as stored. */
export type ModelContext = {
  /** The runner row's defaults (`defaults_json`, parsed), which the operator may have edited. */
  readonly defaults: Readonly<Record<string, unknown>>;
  /** The model strings the adapter registers (its `registration().models`). */
  readonly registered: readonly string[];
  /**
   * The ports Bayon's own API and GUI listen on (`reservedPortsFrom`), which no model setting may
   * point a sandbox at. Absent: the defaults (`BAYON_DEFAULT_PORTS`).
   */
  readonly reservedPorts?: readonly number[];
};

export type RunnerKind = "llm_sdk" | "llm_cli" | "llm_http" | "script";

/** The rows an adapter registers at supervisor boot (amendment 4), so runner names stay here. */
export type Registration = {
  readonly models: readonly ModelRow[];
  readonly runner: {
    readonly id: string;
    readonly kind: RunnerKind;
    readonly adapter: string;
    readonly versionDetected: string;
    readonly caps: RunnerCaps;
    readonly defaults: Readonly<Record<string, unknown>>;
  };
};

/** Where a health check may run on an executor that places sessions: a session's root and tmp. */
export interface HealthPlace {
  readonly cwd: string;
  readonly tmp: string;
}

/**
 * A runner behind the supervisor (§5, contract 4). A run is open from `send` until its `terminal`
 * event, which comes from the runner's own records. One exception (§5.2 amendment): after its own
 * logged interrupt is followed by the observed end of the runner's process, an adapter may map
 * `terminal{outcome:"interrupted", basis:"interrupt+exit"}` from those raw-log frames; never ok or
 * failed. No outcome is ever inferred from an exit code. If the stream ends with a run open, the
 * supervisor writes that run's terminal (§5.2).
 */
export interface RunnerAdapter {
  readonly id: string;
  caps(): RunnerCaps;
  /** The runner and models rows to register at supervisor boot (amendment 4). */
  registration(): Registration;
  /**
   * Whether an operator's models row can run on this runner. Pure: no process, no
   * network. Absent: `acceptRegisteredModels`, which takes only model strings the adapter
   * registered, with no settings. `@bayon/runners/models` serves the same function to the API and
   * frm without loading the adapter.
   */
  validateModel?(row: ModelProposal, ctx: ModelContext): Result<void>;
  version(): Promise<string>;
  /**
   * The runner's version as `ex` runs it. `at`: where a program may run on `ex` when the
   * supervisor's own paths mean nothing there (a container's placed session); its PATH
   * is `ex.envPath`. Without it, the adapter picks a scratch dir of this host.
   */
  health(ex: Executor, at?: HealthPlace): Promise<Result<{ version: string }>>;
  /**
   * Creates the session's runner home (§11.3) and claims it for the session (§15 #14), through
   * `ex` when the home is that executor's and not this host's (a container).
   */
  prepareHome(
    spec: SpawnSpec,
    ex?: Executor,
  ): Promise<Result<{ files: string[] }>>;
  /** Starts a process for a new session; resolves once it can take `send`. Never waits for a
   * `records()` reader. */
  spawn(spec: SpawnSpec, ex: Executor): Promise<Result<SessionHandle>>;
  /** Starts a process that resumes `spec.resumeRunnerSessionId` (amendment 2). */
  adopt(spec: SpawnSpec, ex: Executor): Promise<Result<SessionHandle>>;
  /**
   * Whether this runner compresses context on `ex` (spec M12, §5.1): the adapter's declaration, not
   * a caps bit. Absent or false: a spec with `contextCompression` is refused.
   */
  compressesContext?(ex: Pick<Executor, "kind">): boolean;
  /** Opens one run. A run already open is `conflict`. */
  send(h: SessionHandle, p: SendSpec): Promise<Result<void>>;
  /**
   * The process's stdout records, verbatim, for one consumer; ends when stdout ends. Between
   * whole lines it may interleave the adapter's own `frm.*` frames (a context proxy's `frm.ctx`,
   * spec M12 §5.2), which its mapper folds; the raw log keeps them like any other record.
   */
  records(h: SessionHandle): AsyncIterable<RawRecord>;
  /** A fresh mapper: one per process segment. `prices` feed only estimated spend. */
  createMapper(o: { readonly prices: readonly ModelRow[] }): Mapper;
  /** Asks the open run to stop; the runner then writes the run's terminal (`interrupted`). */
  interrupt(h: SessionHandle): Promise<Result<void>>;
  /** `graceful` interrupts an open run, closes stdin and escalates to SIGTERM, then SIGKILL;
   * `kill` is SIGKILL. Resolves once the process has exited. */
  stop(h: SessionHandle, mode: "graceful" | "kill"): Promise<void>;
  estimateTokens(text: string): Promise<number>;
  /**
   * The argv+env for a human to resume `runnerSessionId` interactively inside a terminal (§12.5),
   * bypassing this adapter's own headless `spawn`/`adopt` path entirely. `validation` when the
   * runner has no interactive mode (the `pty` cap is false, or declared but not this method).
   */
  interactiveResume(
    spec: SpawnSpec,
    runnerSessionId: string,
    ex: Executor,
  ): Promise<Result<InteractiveResume>>;
  /**
   * Whether a newer release of this runner's own package exists, by one unauthenticated
   * GET of a fixed URL for its own package's latest release on npm. `io` is injected so tests pass a
   * fake fetch; nothing here ever installs or runs anything. Absent for a runner with no such feed
   * (a job adapter, an external CLI with no clean npm mirror).
   */
  updateCheck?(io: {
    readonly fetch: Fetch;
    readonly signal: AbortSignal;
  }): Promise<Result<RunnerUpdate>>;
  /**
   * Whether the model's provider serves `target.model` now, asked before a conformance
   * run and at spawn so a model the provider dropped fails in seconds, naming the model and the
   * provider's host. One cheap, unauthenticated call bounded by `io.signal`; never throws. Absent
   * for a runner with no such call (every call to its provider costs auth or money): callers treat
   * it as `unchecked`.
   */
  preflightModel?(
    target: PreflightTarget,
    io: { readonly fetch: Fetch; readonly signal: AbortSignal },
  ): Promise<ModelPreflight>;
}

/** A subset of the global `fetch` an adapter's `updateCheck` is given; tests inject a fake one. */
export type Fetch = typeof globalThis.fetch;

/** What `updateCheck` answers: the installed version, npm's latest, and where to read about it. */
export type RunnerUpdate = {
  readonly current: string;
  readonly latest: string;
  readonly notes_url?: string;
};

/** What a pre-flight resolves the provider from: as a session of the model would spawn. */
export type PreflightTarget = Pick<
  SpawnSpec,
  "model" | "modelSettings" | "flags" | "env"
> & {
  /** Where the session would run: an adapter checks only where the supervisor shares its network. */
  readonly executorKind: ExecutorKind;
};

/**
 * A pre-flight's answer. `not_served`: the provider answered, and not with this model.
 * `unreachable`: it did not answer (a network error, a timeout, no list). `unchecked`: the adapter
 * cannot check this target cheaply. Each reason names the model and the provider's host, never a
 * secret.
 */
export type ModelPreflight =
  | { readonly verdict: "served" }
  | {
      readonly verdict: "not_served" | "unreachable" | "unchecked";
      readonly reason: string;
    };
