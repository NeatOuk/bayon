// The codex-exec runner (App. B; design §2–§6): one turn host per session, started
// through our Executor, runs one Codex process per turn. The host's ref, stdout and exit are the
// handle's, so the supervisor's executor_ref holds across turns (Invariant 12). Events come from
// the host's stdout alone, the raw log being their write-ahead log; Codex's own transcript files
// are never read (Invariant 2).
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMAND_POLICY_FLAG,
  CommandPolicy,
  err,
  ok,
  systemClock,
  writesGit,
  type Clock,
  type Result,
} from "@bayon/core";
import type { Argv, Executor, Proc } from "@bayon/executors";
import { z } from "zod";
import type {
  HealthPlace,
  RawRecord,
  RunnerAdapter,
  SessionHandle,
  SpawnSpec,
} from "../../adapter.js";
import { asFrmError, frmError } from "../../errors.js";
import { claimHome } from "../../home.js";
import type { RecordQueue } from "../../records.js";
import { RunTracker } from "../../run-tracker.js";
import { tee } from "../../tee.js";
import { approximateTokens } from "../../tokens.js";
import { settlesWithin } from "../../wait.js";
import {
  MCP_TOKEN_ENV,
  resolveSandbox,
  turnArgv,
  type Sandbox,
} from "./argv.js";
import { HOST_EXIT, HOST_INTERRUPT, HOST_START, HostStart } from "./frames.js";
import { gitWritableRoots } from "./git-roots.js";
import {
  AUTH_FILE,
  AUTH_JSON_ENV,
  CODEX_DIR,
  authFile,
  authFileOf,
  configFile,
  schemaFile,
  type HomeFile,
} from "./home.js";
import { loginReturner, type LoginReturn } from "./login.js";
import { encodeOp, hostArgv, type HostOp } from "./host.js";
import { createCodexMapper } from "./mapper.js";
import {
  CAPS,
  DEFAULTS,
  MODELS,
  RUNNER_ID,
  VERSION_LINE,
  registration,
} from "./registration.js";

const SandboxName = z.enum([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);

/** The runner row's defaults merged with the profile (`spec.flags`). Unknown keys are ignored. */
const Flags = z.looseObject({
  bin: z
    .array(z.string().min(1))
    .min(1)
    .default([...DEFAULTS.bin]),
  hostNode: z.string().min(1).default(DEFAULTS.hostNode),
  sandbox: SandboxName.optional(),
  sandboxByKind: z
    .record(z.string(), SandboxName)
    .default({ ...DEFAULTS.sandboxByKind }),
  initTimeoutMs: z.int().positive().default(DEFAULTS.initTimeoutMs),
  mcpStartupTimeoutSec: z
    .int()
    .positive()
    .default(DEFAULTS.mcpStartupTimeoutSec),
  /**
   * The role's default command policy. approval_policy is `never`, so there is no
   * allowlist to fill: every command runs, inside the sandbox. A policy that writes git gets the
   * worktree's git dirs as writable roots under workspace-write (git-roots.ts); push, remote and
   * config stay refused by the sandbox (no network, the mirror's config read-only).
   */
  [COMMAND_POLICY_FLAG]: CommandPolicy.optional(),
});
type Flags = z.infer<typeof Flags>;

export type CodexExecAdapterOptions = {
  /** A stand-in for the Codex CLI, e.g. the stub in tests; wins over `flags.bin`. */
  readonly bin?: Argv;
  readonly clock?: Clock;
  /** How long interrupt and each step of `stop('graceful')` wait; also the host's grace. */
  readonly graceMs?: number;
};

/** What the tee observer learns from the host's stdout. Mutable, per process, never exposed. */
type Watch = {
  thread: string | undefined;
  runId: string | undefined;
  interrupted: string | undefined;
  /** The host has exited: nothing more can be written to it. */
  exited: boolean;
  readonly started: PromiseWithResolvers<HostStart | undefined>;
};

type Session = {
  readonly proc: Proc;
  readonly records: RecordQueue;
  readonly run: RunTracker;
  readonly watch: Watch;
  readonly spec: SpawnSpec;
  readonly flags: Flags;
  readonly bin: Argv;
  readonly sandbox: Sandbox;
  /** The worktree's git dirs, writable under workspace-write when the policy writes git. */
  readonly writableRoots: readonly string[];
  readonly holdsAuth: boolean;
  /**
   * Returns this process's rotation of the granted login (§14) to the operator's file, when the
   * session reads that file in place: the same returner its turns use, so it knows what they gave back.
   */
  readonly returnLogin: (() => LoginReturn) | undefined;
  readonly send: (op: HostOp) => Promise<Result<void>>;
  readonly endInput: () => Promise<void>;
};

/**
 * auth.json's refresh token rotates when the CLI refreshes it, so two live sessions sharing one
 * would log each other out: one live session per supervisor process may hold it (design §5).
 *
 * This is the **backstop**, not the mechanism. The capacity limit it states belongs to
 * admission, which declares it as §5.1's `concurrentSessions` and **queues** the second spawn the
 * way a budget cap or a fleet pause queues one. A refusal here means a second session reached
 * spawn anyway — a bug upstream, or a caller that is not the supervisor — so it stays, and stays
 * `conflict`/retryable.
 */
const authHolders = new Set<string>();

const decoder = new TextDecoder();

/**
 * The writable roots a session's command policy needs: a policy that writes git, under
 * workspace-write, gets its worktree's git dirs; any other session none. Resolved once per process:
 * the worktree does not move under a live session.
 */
async function gitRootsFor(
  spec: SpawnSpec,
  ex: Executor,
  flags: Flags,
  sandbox: Sandbox,
): Promise<Result<readonly string[]>> {
  const policy = flags[COMMAND_POLICY_FLAG];
  if (sandbox !== "workspace-write" || policy === undefined) return ok([]);
  return writesGit(policy)
    ? gitWritableRoots(ex, spec.cwd, spec.env["PATH"] ?? "")
    : ok([]);
}

const toArgv = (xs: readonly string[]): Argv => {
  const [program = "codex", ...rest] = xs;
  return [program, ...rest];
};

/**
 * Tracks the run from the host's stdout. Never writes a terminal (Invariant 3).
 *
 * `codexExited` fires on the host's exit frame — one Codex process has closed — whatever run it
 * belonged to. A session holding the operator's login returns it there (login.ts): that is the one
 * moment the refreshed auth.json is both final and still on disk.
 */
function observe(
  record: RawRecord,
  watch: Watch,
  run: RunTracker,
  endStream: () => void,
  codexExited: () => void,
): void {
  if (record.partial) return;
  const text = decoder.decode(record.bytes);
  if (!text.includes('"type"')) return;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const v = value as { type?: unknown; thread_id?: unknown; run_id?: unknown };
  switch (v.type) {
    case HOST_START: {
      const start = HostStart.safeParse(value);
      watch.started.resolve(start.success ? start.data : undefined);
      return;
    }
    case "thread.started":
      if (typeof v.thread_id !== "string") return;
      if (watch.thread === undefined) watch.thread = v.thread_id;
      // Resumed into another thread: a protocol breach. End the stream; the run gets no terminal.
      else if (watch.thread !== v.thread_id) endStream();
      return;
    case "turn.completed":
    case "turn.failed":
      run.ended();
      return;
    case HOST_INTERRUPT:
      if (typeof v.run_id === "string") watch.interrupted = v.run_id;
      return;
    case HOST_EXIT:
      codexExited();
      if (v.run_id !== watch.runId || !run.open) return;
      // After our own logged interrupt, the mapper writes terminal{interrupted} from this frame.
      if (watch.interrupted === v.run_id) {
        run.ended();
        return;
      }
      // Codex ended with no terminal and nothing asked it to: end the stream, so the supervisor
      // closes the run (runner_exited_without_terminal) and adopts by resume. No terminal here.
      endStream();
      return;
  }
}

/** The host's stdin, written one op at a time and in order; a dead host takes nothing. */
function writer(
  proc: Proc,
  dead: () => boolean,
): {
  readonly send: (op: HostOp) => Promise<Result<void>>;
  readonly end: () => Promise<void>;
} {
  const stdin = proc.stdin;
  // Channel internals: mutable, never exposed.
  let chain: Promise<unknown> = Promise.resolve();
  let closed = false;
  const closedError = err(
    frmError("internal", "the turn host's input is closed"),
  );
  return {
    send(op) {
      if (stdin === null || closed || dead())
        return Promise.resolve(closedError);
      const written = chain.then(() => stdin.write(encodeOp(op)));
      chain = written.catch(() => undefined);
      return written.then(
        () => ok(undefined),
        (e: unknown) =>
          err(asFrmError(e, "internal", "the turn host stopped reading")),
      );
    },
    end() {
      if (stdin === null || closed || dead()) return Promise.resolve();
      closed = true;
      const ended = chain.then(() => stdin.end());
      chain = ended.catch(() => undefined);
      return ended.catch(() => undefined); // the host is already gone: nothing left to end
    },
  };
}

export function createCodexExecAdapter(
  options: CodexExecAdapterOptions = {},
): RunnerAdapter {
  const clock = options.clock ?? systemClock;
  const graceMs = options.graceMs ?? 5_000;
  const sessions = new WeakMap<SessionHandle, Session>();
  // One version check per executor and binary: the pin is enforced before a host starts.
  const versions = new Map<string, Promise<Result<string>>>();

  async function readVersion(
    ex: Executor,
    bin: Argv,
    cwd: string,
    env: Readonly<Record<string, string>>,
  ): Promise<Result<string>> {
    const [program, ...rest] = bin;
    try {
      const proc = await ex.exec([program, ...rest, "--version"], {
        cwd,
        env,
        stdin: "ignore",
      });
      const { records, exited } = tee(proc);
      const lines: string[] = [];
      for await (const r of records) lines.push(decoder.decode(r.bytes));
      const status = await exited;
      const line = lines[0]?.trim() ?? "";
      if (status.code !== 0 || line === "") {
        return err(
          frmError(
            "runner_error",
            `${program} --version failed: ${status.stderrTail.slice(-500)}`,
          ),
        );
      }
      return line === VERSION_LINE
        ? ok(line)
        : err(
            frmError(
              "validation",
              `version drift: ${line} is not the pinned ${VERSION_LINE}; decertify and re-run conformance`,
            ),
          );
    } catch (e) {
      return err(asFrmError(e, "spawn_failed", `cannot start ${program}`));
    }
  }

  async function checkVersion(
    ex: Executor,
    bin: Argv,
    spec: SpawnSpec,
  ): Promise<Result<string>> {
    const key = JSON.stringify([ex.id, ...bin]);
    const pending =
      versions.get(key) ??
      readVersion(ex, bin, spec.cwd, {
        PATH: spec.env["PATH"] ?? "",
        HOME: spec.homeDir,
      });
    versions.set(key, pending);
    const checked = await pending;
    if (!checked.ok) versions.delete(key); // a failed check is retried next time
    return checked;
  }

  async function launch(
    spec: SpawnSpec,
    ex: Executor,
    rsid: string,
    s: {
      readonly flags: Flags;
      readonly bin: Argv;
      readonly sandbox: Sandbox;
      readonly writableRoots: readonly string[];
      readonly auth: HomeFile | undefined;
      /** The granted login (§14), when the auth.json placed is the operator's own file. */
      readonly granted: SpawnSpec["grantedLogin"];
      readonly release: () => void;
    },
  ): Promise<Result<SessionHandle>> {
    // The child's whole env: the auth.json content travels only in the files op, never in env.
    const env = {
      ...Object.fromEntries(
        Object.entries(spec.env).filter(([name]) => name !== AUTH_JSON_ENV),
      ),
      CODEX_HOME: join(spec.homeDir, CODEX_DIR),
      ...(spec.mcp === undefined ? {} : { [MCP_TOKEN_ENV]: spec.mcp.token }),
    };
    const node = ex.kind === "local" ? process.execPath : s.flags.hostNode;
    let proc: Proc;
    try {
      proc = await ex.exec(
        hostArgv(node, { v: 1, rsid, home: spec.homeDir, graceMs }),
        { cwd: spec.cwd, env, stdin: "pipe", detached: true },
      );
    } catch (e) {
      return err(asFrmError(e, "spawn_failed", "cannot start the turn host"));
    }
    const run = new RunTracker();
    const watch: Watch = {
      thread: undefined,
      runId: undefined,
      interrupted: undefined,
      exited: false,
      started: Promise.withResolvers<HostStart | undefined>(),
    };
    const io = writer(proc, () => watch.exited);
    // The rotated login goes home at the end of every turn (login.ts), and only this process's own
    // rotation: it is judged against the value placed here, never a copy read once per run.
    // Synchronous on purpose: the file is under 8 KB and nothing may start the next turn between
    // the read and the write.
    const returnLogin =
      s.granted === undefined
        ? undefined
        : loginReturner(spec.homeDir, s.granted.path, s.granted.value);
    const returnGrantedLogin = () => {
      returnLogin?.();
    };
    const teed = tee(proc, {
      observe: (r) =>
        observe(
          r,
          watch,
          run,
          () => {
            void io.end();
          },
          returnGrantedLogin,
        ),
    });
    void teed.exited.then(() => {
      watch.exited = true;
      run.ended();
      watch.started.resolve(undefined);
      s.release();
    });
    const files = [configFile(), ...(s.auth === undefined ? [] : [s.auth])];
    const sent = await io.send({ op: "files", files });
    const timer = new AbortController();
    const start = sent.ok
      ? await Promise.race([
          watch.started.promise,
          clock.after(s.flags.initTimeoutMs, timer.signal).then(
            () => undefined,
            () => undefined,
          ),
        ])
      : undefined;
    timer.abort();
    const refuse = async (error: ReturnType<typeof frmError>) => {
      proc.kill("SIGKILL");
      await teed.exited;
      return err(error);
    };
    if (start === undefined) {
      const tail = await settlesWithin(teed.exited, clock, graceMs).then(
        async (exited) => (exited ? (await teed.exited).stderrTail : ""),
      );
      return refuse(
        frmError(
          "spawn_failed",
          `the turn host did not start: ${tail.slice(-500)}`,
          { retryable: true },
        ),
      );
    }
    if (start.runner_session_id !== rsid) {
      return refuse(
        frmError(
          "validation",
          `the home's thread belongs to runner session ${start.runner_session_id}, not ${rsid}`,
        ),
      );
    }
    watch.thread = start.thread_id ?? undefined;
    const handle: SessionHandle = {
      sessionId: spec.sessionId,
      runnerSessionId: rsid,
      executorRef: proc.ref,
      exited: teed.exited,
    };
    sessions.set(handle, {
      proc,
      records: teed.records,
      run,
      watch,
      spec,
      flags: s.flags,
      bin: s.bin,
      sandbox: s.sandbox,
      writableRoots: s.writableRoots,
      holdsAuth: s.auth !== undefined,
      returnLogin,
      send: io.send,
      endInput: io.end,
    });
    return ok(handle);
  }

  /**
   * SpawnSpec.extraRoots: 0.154.0's `sandbox_workspace_write.writable_roots`
   * is not verified against the pinned binary, so a sandbox that would need it refuses the roots
   * rather than drop the grant silently. Under danger-full-access (a container) the container is
   * the boundary and every root in it is already writable.
   */
  function extraRootsRefusal(spec: SpawnSpec, sandbox: string): string | null {
    if (spec.extraRoots === undefined || spec.extraRoots.length === 0) {
      return null;
    }
    if (sandbox === "danger-full-access") return null;
    return `${RUNNER_ID} cannot grant extra roots under the ${sandbox} sandbox yet (its writable_roots key is unverified): staff a multi-repo session on another runner or a container executor`;
  }

  async function start(
    spec: SpawnSpec,
    ex: Executor,
    rsid: string,
  ): Promise<Result<SessionHandle>> {
    const flags = Flags.safeParse(spec.flags);
    if (!flags.success) {
      return err(frmError("validation", `flags: ${flags.error.message}`));
    }
    if (!MODELS.some((m) => m.model === spec.model)) {
      return err(
        frmError(
          "validation",
          `unpriced model ${JSON.stringify(spec.model)}: no ${RUNNER_ID} models row prices it`,
        ),
      );
    }
    if (spec.mcp !== undefined && spec.mcp.token === "") {
      return err(frmError("validation", "spec.mcp has an empty token"));
    }
    if (spec.builtinTools === "none") {
      // Plan rule 4: an MCP-only session reads untrusted input. 0.154.0's feature switches that
      // remove its shell, patch and image tools are not yet verified live, so this runner refuses
      // rather than claim a guarantee it cannot show.
      return err(
        frmError(
          "validation",
          `${RUNNER_ID} cannot run an MCP-only session yet (builtinTools none): staff it on another runner`,
        ),
      );
    }
    const sandbox = resolveSandbox(
      flags.data.sandbox,
      flags.data.sandboxByKind,
      ex.kind,
    );
    if (!sandbox.ok) return sandbox;
    const roots = extraRootsRefusal(spec, sandbox.value);
    if (roots !== null) return err(frmError("validation", roots));
    const gitRoots = await gitRootsFor(spec, ex, flags.data, sandbox.value);
    if (!gitRoots.ok) return gitRoots;
    // The operator's own login, used in place with their consent (§14): it wins over a copy in the
    // secret store, which is the stale photograph this replaces. Read on this host, so local only.
    const granted = spec.grantedLogin;
    const auth =
      granted === undefined
        ? authFile(spec.env)
        : authFileOf(granted.value, `the granted login ${granted.path}`);
    if (!auth.ok) return auth;
    if (auth.value !== undefined) {
      if (ex.kind !== "local") {
        return err(
          frmError(
            "validation",
            granted === undefined
              ? `${AUTH_JSON_ENV} is for local executors only; use CODEX_API_KEY on ${ex.kind}`
              : `a login used in place is for local executors only; use CODEX_API_KEY on ${ex.kind}`,
          ),
        );
      }
      if (authHolders.size > 0 && !authHolders.has(spec.sessionId)) {
        return err(
          frmError("conflict", "another live session holds auth.json", {
            retryable: true,
          }),
        );
      }
      authHolders.add(spec.sessionId);
    }
    const release = () => {
      if (auth.value !== undefined) authHolders.delete(spec.sessionId);
    };
    const bin = options.bin ?? toArgv(flags.data.bin);
    const version = await checkVersion(ex, bin, spec);
    if (!version.ok) {
      release();
      return version;
    }
    const launched = await launch(spec, ex, rsid, {
      flags: flags.data,
      bin,
      sandbox: sandbox.value,
      writableRoots: gitRoots.value,
      auth: auth.value,
      granted,
      release,
    });
    if (!launched.ok) release();
    return launched;
  }

  async function interrupt(h: SessionHandle): Promise<Result<void>> {
    const s = sessions.get(h);
    if (s === undefined) {
      return err(frmError("not_found", `no runner process for ${h.sessionId}`));
    }
    const runId = s.watch.runId;
    if (!s.run.open || runId === undefined) return ok(undefined);
    const sent = await s.send({ op: "interrupt", run_id: runId });
    if (!sent.ok) return sent;
    if (!(await settlesWithin(s.run.whenEnded(), clock, graceMs))) {
      return err(
        frmError("timeout", "the runner did not end the run after SIGINT", {
          retryable: true,
        }),
      );
    }
    return ok(undefined);
  }

  /** `kill` is SIGKILL; `graceful` interrupts an open run, ends the host's input, then escalates. */
  async function halt(
    s: Session,
    h: SessionHandle,
    mode: "graceful" | "kill",
  ): Promise<void> {
    if (mode === "kill") {
      s.proc.kill("SIGKILL");
      await h.exited;
      return;
    }
    if (s.watch.exited) return; // already gone, e.g. after a kill -9: nothing to end
    if (s.run.open) {
      await interrupt(h);
      await settlesWithin(s.run.whenEnded(), clock, graceMs);
    }
    // The host ends Codex (SIGTERM, then SIGKILL after its grace) and exits with Codex's status.
    await settlesWithin(s.endInput(), clock, graceMs);
    if (await settlesWithin(h.exited, clock, 3 * graceMs)) return;
    s.proc.kill("SIGTERM");
    if (await settlesWithin(h.exited, clock, graceMs)) return;
    s.proc.kill("SIGKILL");
    await h.exited;
  }

  async function health(
    ex: Executor,
    at?: HealthPlace,
  ): Promise<Result<{ version: string }>> {
    // A placed session's own dirs where the executor is not this host (a container).
    const home = at?.tmp ?? tmpdir();
    const checked = await readVersion(
      ex,
      options.bin ?? toArgv(DEFAULTS.bin),
      at?.cwd ?? home,
      { PATH: ex.envPath ?? process.env["PATH"] ?? "", HOME: home },
    );
    return checked.ok ? ok({ version: checked.value }) : checked;
  }

  return {
    id: RUNNER_ID,
    caps: () => CAPS,
    registration,
    version: async () => VERSION_LINE,
    health,
    prepareHome: (spec, ex) => claimHome(spec.homeDir, spec.sessionId, ex),
    spawn: (spec, ex) => start(spec, ex, randomUUID()),
    adopt: async (spec, ex) =>
      spec.resumeRunnerSessionId === undefined
        ? err(frmError("validation", "adopt needs resumeRunnerSessionId"))
        : start(spec, ex, spec.resumeRunnerSessionId),

    async send(h, p) {
      const s = sessions.get(h);
      if (s === undefined) {
        return err(
          frmError("not_found", `no runner process for ${h.sessionId}`),
        );
      }
      if (s.run.open) {
        return err(
          frmError("conflict", `a run is already open on ${h.sessionId}`),
        );
      }
      const schema =
        p.output === undefined
          ? undefined
          : schemaFile(p.runId, p.output.schema);
      if (schema !== undefined && !schema.ok) return schema;
      const thread = s.watch.thread;
      const argv = turnArgv({
        bin: s.bin,
        cwd: s.spec.cwd,
        model: s.spec.model,
        effort: s.spec.effort,
        sandbox: s.sandbox,
        writableRoots: s.writableRoots,
        shellEnv: s.spec.env,
        mcp:
          s.spec.mcp === undefined
            ? undefined
            : {
                url: s.spec.mcp.url,
                tools: s.spec.mcp.tools,
                startupTimeoutSec: s.flags.mcpStartupTimeoutSec,
              },
        thread,
        output:
          p.output === undefined || schema === undefined
            ? undefined
            : {
                schemaPath: join(s.spec.homeDir, schema.value.path),
                path: p.output.path,
              },
      });
      s.run.opened();
      s.watch.runId = p.runId;
      const sent = await s.send({
        op: "turn",
        run_id: p.runId,
        model: s.spec.model,
        resume: thread !== undefined,
        argv,
        stdin: p.text,
        files: schema === undefined ? [] : [schema.value],
      });
      if (!sent.ok) {
        s.run.ended();
        return sent;
      }
      return ok(undefined);
    },

    records(h) {
      const s = sessions.get(h);
      if (s === undefined) {
        throw frmError("not_found", `no runner process for ${h.sessionId}`);
      }
      return s.records;
    },

    createMapper: (o) => createCodexMapper(o),
    interrupt,

    async stop(h, mode) {
      const s = sessions.get(h);
      if (s === undefined) return;
      try {
        await halt(s, h, mode);
      } finally {
        if (s.holdsAuth) {
          // A granted login goes home before the unlink below can destroy it. Every turn already
          // returned it (launch's observer); this is the SIGKILL path, where the host never ran its
          // own unlink and the home copy is all that is left of the rotation (§14, login.ts).
          s.returnLogin?.();
          // The host unlinks auth.json on every exit it lives to see; after a SIGKILL of the host,
          // this unlink is the backstop. auth.json exists on local executors only (design §5).
          rmSync(join(s.spec.homeDir, AUTH_FILE), { force: true });
          authHolders.delete(s.spec.sessionId);
        }
      }
    },

    estimateTokens: async (text) => approximateTokens(text),

    async interactiveResume() {
      // `codex exec` is headless by design (registration.ts: pty: false) — no interactive mode.
      return err(
        frmError(
          "validation",
          "codex-exec has no interactive mode: takeover is not supported",
        ),
      );
    },
  };
}
