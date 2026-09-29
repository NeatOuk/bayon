// The conformance suite's contracts: the subject under test, the ports it is
// driven through, and the kit that holds a runner's specifics. Runner-neutral (Invariant 1).
import type {
  CanonicalEvent,
  Clock,
  ConformanceCheck,
  ConformanceTestId,
  ErrorClass,
  FrmError,
  PortSource,
  Result,
  RunOutcome,
} from "@bayon/core";
import type { Executor, ExecutorKind } from "@bayon/executors";
import type { RunnerAdapter, SessionHandle, SpawnSpec } from "../adapter.js";
import type { FaultExecutor } from "./fault-executor.js";

export type ScenarioName =
  | "plain"
  | "edit"
  | "interrupt"
  | "resume"
  | "mcp"
  | "deny"
  | "approval"
  | "review"
  | "roots";

export const SCENARIO_NAMES: readonly ScenarioName[] = [
  "plain",
  "edit",
  "interrupt",
  "resume",
  "mcp",
  "deny",
  "approval",
  "review",
  "roots",
];

/** What a scenario's turns and flags are rendered with. */
export interface ScenarioVars {
  readonly nonce: string;
  /** The MCP tool's wire name (test 11). */
  readonly mcpTool: string;
  /** The file `deny` and `approval` must never create, relative to the cwd. */
  readonly marker: string;
  /** The session's extra workspace roots, absolute (test 16); empty in every other scenario. */
  readonly roots: readonly string[];
  /** A directory outside every root of the session: `roots` writes there and must not (test 16). */
  readonly outside: string;
  /** The file test 16 asks for in each root, and once outside them all. */
  readonly rootMarker: string;
}

/** What test 17's scenario is rendered with (spec M12): files the harness wrote into the worktree. */
export interface CompressionVars {
  readonly nonce: string;
  /** A ~24 KB log, relative to the cwd: one ERROR line in its middle holds a code. */
  readonly logFile: string;
  /** A 500-item JSON array, relative to the cwd: one item in its middle holds a tag. */
  readonly jsonFile: string;
}

/**
 * One scenario for one runner. Turn texts are fixed test inputs sent straight to `adapter.send`,
 * not compiled run prompts; the kit hash pins them (§8.1).
 */
export interface Scenario {
  /** The spawn's `flags`: the runner's own knobs (a fixture script, allowed tools, turn caps). */
  readonly flags: Readonly<Record<string, unknown>>;
  /** Extra child env, e.g. a stand-in CLI's controls. Never a secret. */
  readonly env?: Readonly<Record<string, string>>;
  /** One text per run, in order. */
  readonly turns: readonly string[];
  /** `deny` and `approval`: the runner's name for the tool the turn asks for. */
  readonly deniedTool?: string;
}

/**
 * A runner's conformance inputs; lives in `adapters/<id>/conformance.ts`. It names no model: a
 * certificate is per (runner, executor, model), and the subject says which model runs.
 */
export interface ConformanceKit {
  readonly runnerId: string;
  scenario(name: ScenarioName, vars: ScenarioVars): Scenario;
  /**
   * §15 #16: whether the runner grants extra workspace roots on an executor of this kind, or
   * refuses them rather than granting a boundary it cannot enforce. Refused, test 16 is N/A and
   * its fallback verifies that refusal — a declaration nothing checks would be a way past a test.
   * Per kind, because a runner's sandbox can differ by executor. Pinned by the kit hash.
   */
  grantsExtraRoots(executorKind: ExecutorKind): boolean;
  /** Runner-shaped unknown records for test 10, each carrying `nonce`. */
  unknownLines(nonce: string): readonly Readonly<Record<string, unknown>>[];
  /**
   * Test 17 (spec M12): one turn that reads both files with the runner's own shell and answers the
   * code and the tag. Only a kit whose runner compresses context has one; the kit hash takes it in
   * only for a run with compression on.
   */
  compressionScenario?(vars: CompressionVars): Scenario;
  /**
   * whether `errorMessages` (SuiteCtx) names a runner-version refusal the suite should
   * stop on, or null when none of them do. Runner-neutral: a kit whose runner never refuses by
   * version leaves this absent, and `runConformance` skips the check.
   */
  blocker?(errorMessages: readonly string[]): string | null;
}

export type EventSource = "runner" | "supervisor";

/** A stored event: the runner's mapped event, or a terminal the supervisor wrote. */
export type StoredEvent = CanonicalEvent & {
  readonly source: EventSource;
  readonly seq: number;
};

/** How the supervisor closes a run that has no terminal. */
export interface RunClose {
  readonly outcome: "timeout" | "interrupted" | "failed" | "budget_stop";
  readonly errorClass: ErrorClass;
  readonly message: string;
}

export interface AttachSpec {
  readonly sessionId: string;
  readonly handle: SessionHandle;
  readonly adapter: RunnerAdapter;
  /** Secret values redacted from every record before the raw append (Invariant 11). */
  readonly redact?: readonly string[];
}

/** Ingest (§9.4): the only reader of a process's records. */
export interface IngestPort {
  readonly source: PortSource;
  /** Starts reading `records(handle)`. EOF with a run open closes it `runner_exited_without_terminal`. */
  attach(a: AttachSpec): Promise<Result<void>>;
  /** Binds later records to `runId`. A run still open is a conflict. */
  openRun(sessionId: string, runId: string): Promise<Result<void>>;
  events(sessionId: string): Promise<readonly StoredEvent[]>;
  /** The raw log, as appended: redacted. */
  raw(sessionId: string): Promise<Uint8Array>;
  /** The run's first terminal. Never rejects. */
  terminalOf(runId: string): Promise<RunOutcome>;
  /** Writes the run's terminal unless it has one: the first terminal wins. */
  closeRun(
    sessionId: string,
    runId: string,
    c: RunClose,
  ): Promise<Result<void>>;
  /** Settles once the attached stream's EOF is processed. Never rejects. */
  ended(sessionId: string): Promise<void>;
  onEvent(listener: (sessionId: string, e: StoredEvent) => void): () => void;
  /** The error that stopped ingest, if one did. */
  fatal(): FrmError | null;
}

export interface WatchSpec {
  readonly sessionId: string;
  readonly runId: string;
  readonly handle: SessionHandle;
  readonly adapter: RunnerAdapter;
  readonly executor: Executor;
  readonly wallClockMs: number;
  /** Called when the wall clock runs out, before the verdict (test 9 probes the process here). */
  readonly onFire?: () => Promise<void>;
}

export interface WatchResult {
  readonly by: "terminal" | "watchdog";
  readonly outcome: RunOutcome;
  readonly firedAt?: number;
}

/** The §5.2 wall clock: verdict first, then interrupt (bounded) → `stop(kill)`. */
export interface WatchdogPort {
  readonly source: PortSource;
  watch(w: WatchSpec): Promise<WatchResult>;
}

export interface McpProbeCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly bearerOk: boolean;
}

export interface McpProbe {
  readonly url: string;
  /** Held in memory only; handed to the runner through `spec.mcp`. */
  readonly token: string;
  readonly tools: readonly string[];
  /** Every call so far. Async: the supervisor's probe reads them back from the API's audit rows. */
  calls(): Promise<readonly McpProbeCall[]>;
  stop(): Promise<void>;
}

/** An /mcp endpoint serving `conformance_echo` that records every call. */
export interface McpProbePort {
  readonly source: PortSource;
  start(): Promise<McpProbe>;
}

export interface FileDiff {
  readonly path: string;
  readonly change: "add" | "modify" | "delete";
  readonly added?: number;
  readonly removed?: number;
}

export interface SessionDirs {
  /** The session root the executor prepares. */
  readonly root: string;
  /** A worktree off the fixture repo. */
  readonly cwd: string;
  readonly homeDir: string;
  readonly tmpDir: string;
  readonly baseSha: string;
  /** What `OpenOptions.extraRoots` asked for, in order; empty for every other session. */
  readonly extraRoots: readonly string[];
}

/** Worktrees, homes and reads of them: local here, remote for container executors. */
export interface WorkspacePort {
  readonly source: PortSource;
  /**
   * The root the executor prepares for a new session, before it does: a placing
   * executor's own (a container's), else one under this port's scratch root.
   */
  place(sessionId: string): Promise<string>;
  /** After the executor's prepare: the session's worktree, home and tmp, under its root. */
  create(sessionId: string): Promise<SessionDirs>;
  /**
   * Frees what a session held on its executor (a container's, by label) once it is closed or its
   * attempt is torn down. Absent: the port keeps everything until `dispose`.
   */
  release?(sessionId: string): Promise<void>;
  /** How many copies of scratch dir `dir` exist, one per placed session holding it. Absent: one. */
  scratchCopies?(dir: string): number;
  /**
   * A writable directory of this session besides its cwd (SpawnSpec.extraRoots, test 16): under
   * the session's own root, so an executor that places sessions makes it where that session is.
   * After `create`.
   */
  extraRoot(sessionId: string, name: string): Promise<string>;
  /** A fresh directory outside every session, e.g. test 15's decoy HOME. */
  scratch(name: string): Promise<string>;
  /** Tracked and untracked changes against the base commit. */
  diff(cwd: string): Promise<readonly FileDiff[]>;
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string | undefined>;
  /** Path (relative) → content digest, for every file under `dir`. */
  snapshot(dir: string): Promise<ReadonlyMap<string, string>>;
  dispose(): Promise<void>;
}

export interface Budgets {
  /** Every adapter and executor call; `stop` gets `callMs + 2 × graceMs`. */
  readonly callMs: number;
  /** Every run's wall clock. */
  readonly turnMs: number;
  /** §15 #7: an interrupt ends the run within this. */
  readonly interruptMs: number;
  /** Test 9's wall clock. */
  readonly hangMs: number;
  readonly graceMs: number;
  /** Past this, the remaining tests are `incomplete`. */
  readonly maxUsd: number;
}

export const LIVE_BUDGETS: Budgets = {
  callMs: 30_000,
  turnMs: 180_000,
  interruptMs: 5_000,
  hangMs: 20_000,
  graceMs: 5_000,
  // $1 ran out at test 13 on the priciest tier ($5/$25 per Mtok). The operator set $10: room for
  // that tier with margin, and still a bound an operator-started run cannot spend past.
  maxUsd: 10,
};

export const OFFLINE_BUDGETS: Budgets = {
  callMs: 2_000,
  turnMs: 5_000,
  interruptMs: 5_000,
  hangMs: 300,
  graceMs: 200,
  maxUsd: 1,
};

/**
 * The most sessions the suite holds prepared at once (tests 9, 12, 14 and 15; an earlier change H2): what a
 * run needs free on its executor, counted as admission counts slots, one per prepared session.
 */
export const SUITE_PEAK_SESSIONS = 2;

export interface ConformanceSubject {
  readonly adapter: RunnerAdapter;
  readonly kit: ConformanceKit;
  /**
   * The model every session of the run spawns with: one of the runner's `registration().models`
   * strings. The result records it, and the certificate holds for it alone.
   */
  readonly model: string;
  /**
   * That models row's own settings, as a session of it spawns with them
   * (SpawnSpec.modelSettings): a model the operator points at its own provider URL is certified on
   * that URL. Absent when the row has none.
   */
  readonly modelSettings?: Readonly<Record<string, unknown>>;
  /** Wraps the real executor. */
  readonly executor: FaultExecutor;
  /** The child's complete env, secrets resolved by the caller. Never logged or reported. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * The login the operator granted this runner in place (§14), absent when they granted
   * none: read again at every process start, as a session's spawn and adopt read it, since a turn
   * that rotates it writes the new one back and a value read once at the run's start is then one
   * the provider has retired. It rides on SpawnSpec.grantedLogin, never in `env`, so the adapter's
   * own write-back runs; every record is redacted of it. A read that fails makes the test
   * `incomplete`: it is the operator's file, not the runner.
   */
  readonly grantedLogin?: () => Promise<
    Result<NonNullable<SpawnSpec["grantedLogin"]>>
  >;
}

export interface ConformancePorts {
  readonly clock: Clock;
  readonly ingest: IngestPort;
  readonly watchdog: WatchdogPort;
  readonly mcp: McpProbePort;
  readonly workspace: WorkspacePort;
}

export interface ConformanceOptions {
  readonly budgets: Budgets;
  /** Run only these; the rest are `incomplete` (never certifiable). */
  readonly only?: readonly ConformanceTestId[];
  /**
   * Spec M12: every session of the run spawns with context compression on, and test 17 runs. The
   * result is a compression-on certificate. A runner that does not compress on the executor is
   * refused before any test.
   */
  readonly compression?: boolean;
}

/** A named check; a `precondition` failing alone lets a model-dependent test retry once. */
export type Check = ConformanceCheck & { readonly precondition?: true };
