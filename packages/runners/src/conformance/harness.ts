// The suite's session driver: sessions over the ports, a deadline on every
// adapter and executor call, the budget, and teardown. Runner-neutral: runner specifics arrive only
// through the kit's scenarios (Invariant 1).
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CONTEXT_STORE_DIR,
  newId,
  type Clock,
  type Result,
  type RunnerCaps,
} from "@bayon/core";
import { z } from "zod";
import type { SendSpec, SessionHandle, SpawnSpec } from "../adapter.js";
import { applyPrepared } from "../prepared.js";
import { settlesWithin } from "../wait.js";
import { endGroups } from "./groups.js";
import { ECHO_TOOL } from "./mcp-probe.js";
import { ROOT_MARKER } from "./roots.js";
import type {
  Budgets,
  CompressionVars,
  ConformancePorts,
  ConformanceSubject,
  Scenario,
  ScenarioName,
  ScenarioVars,
  SessionDirs,
  StoredEvent,
  WatchResult,
} from "./types.js";

/** An adapter or executor call missed its deadline: the test fails on `call_timeout:<method>`. */
export class CallTimeout extends Error {
  constructor(readonly method: string) {
    super(`${method} missed its deadline`);
  }
}

/** A step the runner refused outright (spawn, send): the test fails on this check. */
export class StepFailed extends Error {
  constructor(
    readonly check: string,
    readonly detail: string,
  ) {
    super(`${check}: ${detail}`);
  }
}

/** The suite could not judge the runner (budget spent, harness error): the test is `incomplete`. */
export class Incomplete extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

const Spend = z.looseObject({
  tokens_in: z.number(),
  tokens_out: z.number(),
  cost_usd: z.number(),
});

export interface Started {
  readonly runId: string;
  readonly sent: Result<void>;
  /** The run's watch: its first terminal, or the watchdog's verdict. */
  readonly done: Promise<WatchResult>;
}

export interface RunEnd {
  readonly runId: string;
  readonly watch: WatchResult;
  /** The events bound to this run. */
  readonly events: readonly StoredEvent[];
}

export interface StartOptions {
  readonly output?: SendSpec["output"];
  readonly wallClockMs?: number;
  readonly onFire?: () => Promise<void>;
}

export interface OpenOptions {
  /** A kit scenario, or test 17's (`compression`, rendered with `compression` below). */
  readonly scenario: ScenarioName | "compression";
  /** Test 17's vars: the files `files` writes, by the names the scenario asks the runner to read. */
  readonly compression?: CompressionVars;
  /** Written into the worktree (relative path → text) before the session starts: test 17's fixtures. */
  readonly files?: Readonly<Record<string, string>>;
  readonly vars?: Partial<ScenarioVars>;
  /** Overrides the session env (test 15's decoy HOME). */
  readonly env?: Readonly<Record<string, string>>;
  readonly mcp?: SpawnSpec["mcp"];
  /** Another session's home (test 14). */
  readonly homeDir?: string;
  /**
   * Names for extra workspace roots (test 16): the workspace port makes one per name under the
   * session's root, the spec carries their paths as `extraRoots`, and the scenario is rendered
   * with them as `vars.roots`.
   */
  readonly extraRoots?: readonly string[];
  /**
   * The schema the session's runs answer to, in its spec (test 13): a runner that fixes its
   * structured output when its process starts needs it at spawn, as a gate's reviewer has it.
   */
  readonly output?: SpawnSpec["output"];
}

/** One session under test. */
export class Live {
  readonly #ctx: SuiteCtx;
  readonly sessionId: string;
  readonly dirs: SessionDirs;
  /** As opened. A granted login is not in it: each process start reads that afresh. */
  readonly spec: SpawnSpec;
  readonly scenario: Scenario;
  readonly vars: ScenarioVars;
  #handle: SessionHandle | undefined;
  /** Every handle this session was given, the latest last: stop() ends each. */
  #handles: readonly SessionHandle[] = [];
  /** The handles the ingest reads: stopped gracefully. One it never read is killed. */
  readonly #attached = new WeakSet<SessionHandle>();
  /** Spawns and adopts not yet returned: a test that gave up on one still owns its process. */
  readonly #starting = new Set<Promise<unknown>>();
  /** stop() has begun: nothing more starts for this session. */
  #closed = false;
  /** stop() has taken the handles: one returned after that is killed as it comes. */
  #swept = false;
  #prepared = false;
  #runs = 0;

  constructor(
    ctx: SuiteCtx,
    init: {
      readonly sessionId: string;
      readonly dirs: SessionDirs;
      readonly spec: SpawnSpec;
      readonly scenario: Scenario;
      readonly vars: ScenarioVars;
    },
  ) {
    this.#ctx = ctx;
    this.sessionId = init.sessionId;
    this.dirs = init.dirs;
    this.spec = init.spec;
    this.scenario = init.scenario;
    this.vars = init.vars;
  }

  get handle(): SessionHandle {
    if (this.#handle === undefined)
      throw new StepFailed("spawn", "no runner process");
    return this.#handle;
  }

  /** Turn `i` of the scenario; a kit without it is a bug in the kit. */
  turn(i: number): string {
    const text = this.scenario.turns[i];
    if (text === undefined)
      throw new StepFailed("kit", `the scenario has no turn ${i + 1}`);
    return text;
  }

  async prepareHome(): Promise<Result<{ files: string[] }>> {
    const { adapter, executor } = this.#ctx.subject;
    const r = await this.#ctx.call(
      "prepareHome",
      adapter.prepareHome(this.spec, executor),
    );
    if (r.ok) this.#prepared = true;
    return r;
  }

  async spawn(): Promise<SessionHandle> {
    if (!this.#prepared) {
      const home = await this.prepareHome();
      if (!home.ok) throw new StepFailed("prepare_home", home.error.message);
    }
    const { adapter, executor } = this.#ctx.subject;
    const spec = await this.#startSpec(this.spec);
    const r = await this.#ctx.call(
      "spawn",
      this.#begin(() => adapter.spawn(spec, executor)),
    );
    if (!r.ok) throw new StepFailed("spawn", r.error.message);
    await this.#attach(r.value, spec);
    return r.value;
  }

  /** Starts a process resuming `resumeRunnerSessionId`; a refusal comes back, it is not thrown. */
  async adopt(resumeRunnerSessionId: string): Promise<Result<SessionHandle>> {
    const { adapter, executor } = this.#ctx.subject;
    const spec = await this.#startSpec({ ...this.spec, resumeRunnerSessionId });
    const r = await this.#ctx.call(
      "adopt",
      this.#begin(() => adapter.adopt(spec, executor)),
    );
    if (r.ok) await this.#attach(r.value, spec);
    return r;
  }

  /**
   * The spec one process starts from: `spec` with the login the operator granted, read now (§14,
   *), as a session's spawn and adopt read it. A read that fails is the operator's file,
   * not the runner, so the test is `incomplete` and nothing starts.
   */
  async #startSpec(spec: SpawnSpec): Promise<SpawnSpec> {
    const read = this.#ctx.subject.grantedLogin;
    if (read === undefined) return spec;
    const login = await this.#ctx.harness("granted login", read());
    if (!login.ok) {
      throw new Incomplete(`harness: granted login: ${login.error.message}`);
    }
    return { ...spec, grantedLogin: login.value };
  }

  /**
   * A spawn or adopt, tracked until it returns: the test awaiting it may give up on it
   * (a sibling's failure under Promise.all, its deadline), but its process is still this session's,
   * and stop() waits for it. None starts once stop() has begun.
   */
  #begin(
    start: () => Promise<Result<SessionHandle>>,
  ): Promise<Result<SessionHandle>> {
    if (this.#closed) {
      return Promise.reject(
        new Incomplete(
          "harness: the session was torn down before its process started",
        ),
      );
    }
    const started = (async () => {
      const r = await start();
      if (r.ok) this.#keep(r.value);
      return r;
    })();
    this.#starting.add(started);
    const settled = () => {
      this.#starting.delete(started);
    };
    void started.then(settled, settled);
    return started;
  }

  #keep(h: SessionHandle): void {
    if (this.#swept) {
      void this.#stopOne(h); // returned after stop() took the handles: ended at once
      return;
    }
    this.#handles = [...this.#handles, h];
  }

  async #attach(h: SessionHandle, spec: SpawnSpec): Promise<void> {
    if (this.#closed) {
      // Torn down while it started: stop() ends it, and the ingest never reads it.
      throw new Incomplete(
        "harness: the session was torn down while its process started",
      );
    }
    this.#handle = h;
    const attached = await this.#ctx.ports.ingest.attach({
      sessionId: this.sessionId,
      handle: h,
      adapter: this.#ctx.subject.adapter,
      // Its MCP token, its granted login and its context proxy's bearer (Invariant 11), as a session's
      // redaction list names them.
      redact: [
        spec.mcp?.token,
        spec.grantedLogin?.value,
        spec.contextCompression?.token,
      ].filter((v): v is string => v !== undefined && v !== ""),
    });
    if (!attached.ok) {
      throw new Incomplete(`harness: ingest attach: ${attached.error.message}`);
    }
    this.#attached.add(h);
    this.#ctx.noteAttached(this.sessionId);
  }

  /** Opens a run, arms its watch, then sends. A refused send closes the run and comes back. */
  async start(text: string, o: StartOptions = {}): Promise<Started> {
    const { ingest, watchdog } = this.#ctx.ports;
    const { adapter, executor } = this.#ctx.subject;
    const handle = this.handle;
    const runId = newId();
    this.#runs += 1;
    const opened = await ingest.openRun(this.sessionId, runId);
    if (!opened.ok) throw new StepFailed("open_run", opened.error.message);
    const watching = watchdog.watch({
      sessionId: this.sessionId,
      runId,
      handle,
      adapter,
      executor,
      wallClockMs: o.wallClockMs ?? this.#ctx.budgets.turnMs,
      ...(o.onFire === undefined ? {} : { onFire: o.onFire }),
    });
    const close = (message: string) =>
      ingest.closeRun(this.sessionId, runId, {
        outcome: "failed",
        errorClass: "runner_error",
        message,
      });
    let sent: Result<void>;
    try {
      sent = await this.#ctx.call(
        "send",
        adapter.send(handle, {
          runId,
          text,
          promptPath: join(this.dirs.tmpDir, `run-${this.#runs}.md`),
          ...(o.output === undefined ? {} : { output: o.output }),
        }),
      );
    } catch (e) {
      await close(`send failed: ${messageOf(e)}`); // lets the watch settle
      throw e;
    }
    if (!sent.ok) await close(`send refused: ${sent.error.message}`);
    const done = watching.then(async (w) => {
      await this.#ctx.charge(this.sessionId, runId);
      return w;
    });
    return { runId, sent, done };
  }

  async finish(s: Started): Promise<RunEnd> {
    const watch = await s.done;
    return { runId: s.runId, watch, events: await this.events(s.runId) };
  }

  /** One whole run; a refused send fails the test. */
  async run(text: string, o: StartOptions = {}): Promise<RunEnd> {
    const s = await this.start(text, o);
    if (!s.sent.ok) throw new StepFailed("send", s.sent.error.message);
    return this.finish(s);
  }

  async events(runId?: string): Promise<readonly StoredEvent[]> {
    const all = await this.#ctx.ports.ingest.events(this.sessionId);
    return runId === undefined ? all : all.filter((e) => e.run_id === runId);
  }

  /** The first stored event of this session matching `pred`, or undefined after `ms`. */
  waitFor(
    pred: (e: StoredEvent) => boolean,
    ms: number,
  ): Promise<StoredEvent | undefined> {
    const { ingest } = this.#ctx.ports;
    return new Promise((resolve) => {
      const timer = new AbortController();
      let settled = false;
      let off: () => void = () => undefined;
      const finish = (e: StoredEvent | undefined) => {
        if (settled) return;
        settled = true;
        timer.abort();
        off();
        resolve(e);
      };
      off = ingest.onEvent((sessionId, e) => {
        if (sessionId === this.sessionId && pred(e)) finish(e);
      });
      void this.#ctx.clock.after(ms, timer.signal).then(
        () => finish(undefined),
        () => undefined,
      );
      void ingest.events(this.sessionId).then((all) => {
        const hit = all.find(pred);
        if (hit !== undefined) finish(hit);
      });
    });
  }

  /** The ref of the session's latest process: a per-turn runner gets a new one each turn. */
  latestRef(): string {
    return (
      this.#ctx.subject.executor.refOf(this.dirs.cwd) ?? this.handle.executorRef
    );
  }

  /**
   * Stops every process this session was given, one still starting included, and waits until each
   * one's whole group is gone: a leader's exit is not its group's, and a member left
   * behind writes on into the session's home. A group still alive after `graceMs` is killed. False
   * when a stop missed its deadline or a group outlived its kill.
   */
  async stop(): Promise<boolean> {
    this.#closed = true;
    const { clock, budgets: b, subject } = this.#ctx;
    // A spawn the test gave up on still starts its process: waited for, within its own deadline.
    await settlesWithin(
      Promise.allSettled([...this.#starting]),
      clock,
      b.callMs,
    );
    this.#swept = true;
    const handles = this.#handles;
    this.#handles = [];
    this.#handle = undefined;
    const stopped = await Promise.all(handles.map((h) => this.#stopOne(h)));
    // Every process launched in the session's cwd (a per-turn runner's turns too), group and all.
    const groups = await endGroups(
      subject.executor,
      [
        ...subject.executor.refsOf(this.dirs.cwd),
        ...handles.map((h) => h.executorRef),
      ],
      clock,
      { graceMs: b.graceMs, killMs: b.callMs },
    );
    if (handles.some((h) => this.#attached.has(h))) {
      await settlesWithin(
        this.#ctx.ports.ingest.ended(this.sessionId),
        clock,
        b.callMs,
      );
    }
    return stopped.every(Boolean) && groups.alive.length === 0;
  }

  /**
   * One handle: graceful within `callMs + 2 × graceMs` if the ingest read it, killed if it never
   * did; the executor's hard cleanup when the adapter misses that deadline.
   */
  async #stopOne(h: SessionHandle): Promise<boolean> {
    const { adapter, executor } = this.#ctx.subject;
    const b = this.#ctx.budgets;
    const stopped = await settlesWithin(
      (async () =>
        adapter.stop(h, this.#attached.has(h) ? "graceful" : "kill"))(),
      this.#ctx.clock,
      b.callMs + 2 * b.graceMs,
    );
    if (!stopped) {
      await executor.cleanup(h.executorRef, "hard").catch(() => undefined); // already gone
    }
    return stopped;
  }
}

/** One suite run: the subject, its ports and budget, the spend so far, and the open sessions. */
export class SuiteCtx {
  readonly subject: ConformanceSubject;
  readonly ports: ConformancePorts;
  readonly budgets: Budgets;
  readonly caps: RunnerCaps;
  readonly clock: Clock;
  /** Spec M12: every session of this run spawns with context compression under this ruleset. */
  readonly compression: { readonly ruleset: string } | undefined;
  #lives: readonly Live[] = [];
  /** Sessions placed and not yet released: a failed open's too. */
  readonly #placed = new Set<string>();
  #stopMissed = false;
  readonly #shared = new Map<string, Promise<unknown>>();
  readonly #charged = new Set<string>();
  #spent = { tokens_in: 0, tokens_out: 0, cost_usd: 0 };
  /** Every session id `Live#attach` attached this suite to (`errorMessages`). */
  readonly #attachedSessions = new Set<string>();

  constructor(
    subject: ConformanceSubject,
    ports: ConformancePorts,
    budgets: Budgets,
    compression?: { readonly ruleset: string },
  ) {
    this.subject = subject;
    this.ports = ports;
    this.budgets = budgets;
    this.caps = subject.adapter.caps();
    this.clock = ports.clock;
    this.compression = compression;
  }

  get spent(): {
    readonly tokens_in: number;
    readonly tokens_out: number;
    readonly cost_usd: number;
  } {
    return this.#spent;
  }

  get exhausted(): boolean {
    return this.#spent.cost_usd > this.budgets.maxUsd;
  }

  /** `p` within `ms` (default `callMs`), or CallTimeout. A rejection is rethrown. */
  async call<T>(
    method: string,
    p: Promise<T>,
    ms = this.budgets.callMs,
  ): Promise<T> {
    const settled = p.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const timer = new AbortController();
    try {
      const r = await Promise.race([
        settled,
        this.clock.after(ms, timer.signal).then(
          () => undefined,
          () => undefined,
        ),
      ]);
      if (r === undefined) throw new CallTimeout(method);
      if (!r.ok) throw r.error;
      return r.value;
    } finally {
      timer.abort();
    }
  }

  /** A harness step (workspace, probe): its failure makes the test `incomplete`, not failed. */
  async harness<T>(what: string, p: Promise<T>): Promise<T> {
    try {
      return await p;
    } catch (e) {
      throw new Incomplete(`harness: ${what}: ${messageOf(e)}`);
    }
  }

  vars(o: Partial<ScenarioVars> = {}): ScenarioVars {
    return {
      nonce: `frm-${randomBytes(6).toString("hex")}`,
      mcpTool: ECHO_TOOL,
      marker: "FRM_DENIED.txt",
      roots: [],
      outside: "",
      rootMarker: ROOT_MARKER,
      ...o,
    };
  }

  /** A new session: its dirs, the executor's prepare, and its spec from the kit's scenario. */
  async open(o: OpenOptions): Promise<Live> {
    if (this.exhausted) {
      throw new Incomplete(
        `budget: $${this.#spent.cost_usd} spent of $${this.budgets.maxUsd}`,
      );
    }
    const sessionId = newId();
    // The spawn pipeline's order (§9.1): the root placed, the executor's prepare, then the
    // workspace inside it (a container's clone runs in its container).
    const root = await this.harness(
      "workspace",
      this.ports.workspace.place(sessionId),
    );
    this.#placed.add(sessionId);
    const prepared = await this.call(
      "prepare",
      this.subject.executor.prepare({ sessionId, root }),
    );
    const created = await this.harness(
      "workspace",
      this.ports.workspace.create(sessionId),
    );
    // Each extra root inside the session's own root, so a placing executor makes it in the
    // session's container; the scenario is rendered with the paths it got.
    const extraRoots: string[] = [];
    for (const name of o.extraRoots ?? []) {
      extraRoots.push(
        await this.harness(
          "workspace",
          this.ports.workspace.extraRoot(sessionId, name),
        ),
      );
    }
    const dirs = {
      ...created,
      homeDir: o.homeDir ?? created.homeDir,
      extraRoots,
    };
    const vars = this.vars({ ...o.vars, roots: extraRoots });
    const scenario = this.#scenario(o, vars);
    // Test 17's fixtures, where the runner will read them. The suite runs compression on local
    // executors only (runConformance refuses any other), so the worktree is this host's.
    for (const [name, text] of Object.entries(o.files ?? {})) {
      await this.harness("workspace", writeFile(join(dirs.cwd, name), text));
    }
    const base: SpawnSpec = {
      sessionId,
      cwd: dirs.cwd,
      homeDir: dirs.homeDir,
      // As the supervisor builds it: HOME and TMPDIR are the session's own (§11.3).
      env: {
        ...this.subject.env,
        ...scenario.env,
        HOME: dirs.homeDir,
        TMPDIR: dirs.tmpDir,
        ...o.env,
      },
      model: this.subject.model,
      ...(this.subject.modelSettings === undefined
        ? {}
        : { modelSettings: this.subject.modelSettings }),
      flags: scenario.flags,
      ...(extraRoots.length === 0 ? {} : { extraRoots }),
      ...(o.mcp === undefined ? {} : { mcp: o.mcp }),
      ...(o.output === undefined ? {} : { output: o.output }),
      // Spec M12: as the supervisor gives it, a fresh bearer and a store under the session root,
      // outside every root the session writes (its worktree and home are the root's children).
      ...(this.compression === undefined
        ? {}
        : {
            contextCompression: {
              ruleset: this.compression.ruleset,
              storeDir: join(dirs.root, CONTEXT_STORE_DIR),
              token: randomBytes(32).toString("hex"),
            },
          }),
    };
    // As spawn does: /mcp and the network as the executor's programs reach them.
    const spec = applyPrepared(base, prepared);
    const live = new Live(this, { sessionId, dirs, spec, scenario, vars });
    this.#lives = [...this.#lives, live];
    return live;
  }

  /** The kit's scenario for `o`, test 17's included; a kit without that one is the kit's failure. */
  #scenario(o: OpenOptions, vars: ScenarioVars): Scenario {
    if (o.scenario !== "compression") {
      return this.subject.kit.scenario(o.scenario, vars);
    }
    const render = this.subject.kit.compressionScenario;
    if (render === undefined || o.compression === undefined) {
      throw new StepFailed("kit", "the kit has no compression scenario");
    }
    return render(o.compression);
  }

  /** Evidence several tests judge (session S-A), made once per suite run. */
  shared<T>(key: string, make: () => Promise<T>): Promise<T> {
    const found = this.#shared.get(key);
    if (found !== undefined) return found as Promise<T>;
    const made = make();
    this.#shared.set(key, made);
    return made;
  }

  /** Adds a run's reported or estimated spend to the suite's total. */
  async charge(sessionId: string, runId: string): Promise<void> {
    if (this.#charged.has(runId)) return;
    this.#charged.add(runId);
    const events = await this.ports.ingest.events(sessionId);
    for (const e of events) {
      if (e.run_id !== runId || e.source !== "runner" || e.kind !== "terminal")
        continue;
      const spend = Spend.safeParse(e.payload["spend"]);
      if (!spend.success) continue;
      this.#spent = {
        tokens_in: this.#spent.tokens_in + spend.data.tokens_in,
        tokens_out: this.#spent.tokens_out + spend.data.tokens_out,
        cost_usd:
          Math.round((this.#spent.cost_usd + spend.data.cost_usd) * 1e9) / 1e9,
      };
    }
  }

  /** Records that `sessionId` was attached, so `errorMessages` can read its events later. */
  noteAttached(sessionId: string): void {
    this.#attachedSessions.add(sessionId);
  }

  /**
   * Every `kind:"error"` event's `payload.message` across every session this suite has attached
   *: the mapper's synthetic API-error assistant frame and the `is_error` result frame
   * both land here. A kit's `blocker` reads these to recognise a runner-version refusal.
   */
  async errorMessages(): Promise<readonly string[]> {
    const out: string[] = [];
    for (const sessionId of this.#attachedSessions) {
      const events = await this.ports.ingest.events(sessionId);
      for (const e of events) {
        if (e.kind !== "error") continue;
        const message = (e.payload as { message?: unknown })["message"];
        if (typeof message === "string") out.push(message);
      }
    }
    return out;
  }

  /**
   * Stops a session and frees what it held on its executor before the attempt ends (H2):
   * test 14 closes its claim-only pair, so the suite never holds more than SUITE_PEAK_SESSIONS.
   * A stop that misses its deadline is reported by teardown.
   */
  async close(live: Live): Promise<void> {
    this.#lives = this.#lives.filter((l) => l !== live);
    if (!(await live.stop())) this.#stopMissed = true;
    await this.harness("workspace release", this.#release(live.sessionId));
  }

  /** Stops and frees every session the attempt opened; returns the methods that missed a deadline. */
  async teardown(): Promise<readonly string[]> {
    const lives = this.#lives;
    this.#lives = [];
    const stopped = await Promise.all(lives.map((l) => l.stop()));
    for (const id of [...this.#placed]) {
      // Not the test's failure: the port keeps what it could not free and dispose reports it.
      await this.#release(id).catch(() => undefined);
    }
    const missed = !stopped.every(Boolean) || this.#stopMissed;
    this.#stopMissed = false;
    return missed ? ["stop"] : [];
  }

  async #release(sessionId: string): Promise<void> {
    if (!this.#placed.delete(sessionId)) return;
    await this.ports.workspace.release?.(sessionId);
  }
}
