// The opencode runner: a turn host per session, started through our Executor,
// owns one `opencode acp` process and drives it over ACP. The host's ref, stdout and exit are the
// handle's, so the supervisor's executor_ref holds across turns (Invariant 12). Events come from
// the host's stdout alone, the raw log being their write-ahead log; opencode's own database is
// never read (Invariant 2).
import { tmpdir } from "node:os";
import {
  COMMAND_POLICY_FLAG,
  CommandPolicy,
  err,
  ok,
  systemClock,
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
import {
  startSessionProxy,
  type CompressesContext,
  type SessionProxy,
} from "../../context-session.js";
import { PROXY_HEADER, type ProxyLog } from "../../model-proxy.js";
import type { RecordQueue } from "../../records.js";
import { RunTracker } from "../../run-tracker.js";
import { tee } from "../../tee.js";
import { approximateTokens } from "../../tokens.js";
import { settlesWithin } from "../../wait.js";
import { HOST_EXIT, HOST_START, HostStart } from "./frames.js";
import { OPENCODE_CONTEXT } from "./context.js";
import {
  ProviderBlock,
  baseUrlOf,
  envRefsOf,
  hostEnv,
  ownDirs,
  parseModel,
  sessionConfig,
} from "./home.js";
import { encodeOp, hostArgv, type HostOp } from "./host.js";
import { confinement, placementRefusal } from "./confine.js";
import { createOpencodeMapper } from "./mapper.js";
import {
  blockFor,
  parseModelSettings,
  validateOpencodeModel,
} from "./models.js";
import { outputInstruction } from "./output.js";
import { preflightOpencodeModel } from "./preflight.js";
import {
  CAPS,
  DEFAULTS,
  RUNNER_ID,
  VERSION_LINE,
  registration,
} from "./registration.js";
import { unsupportedKeywords } from "./schema-check.js";
import { reapToolGroups } from "./tool-groups.js";
import { updateCheck as checkForUpdate } from "./update-check.js";

/** The runner row's defaults merged with the profile (`spec.flags`). Unknown keys are ignored. */
const Flags = z.looseObject({
  bin: z
    .array(z.string().min(1))
    .min(1)
    .default([...DEFAULTS.bin]),
  hostNode: z.string().min(1).default(DEFAULTS.hostNode),
  initTimeoutMs: z.int().positive().default(DEFAULTS.initTimeoutMs),
  /** opencode provider blocks by provider id: operator data (design §4). */
  providers: z
    .record(z.string().min(1), ProviderBlock)
    .default(
      () =>
        structuredClone(DEFAULTS.providers) as Record<string, ProviderBlock>,
    ),
  /** Deny write, edit and apply_patch: a reviewer's session. */
  readOnly: z.boolean().default(false),
  /** The role's command policy: only its prefixes run in the shell. */
  [COMMAND_POLICY_FLAG]: CommandPolicy.optional(),
});
type Flags = z.infer<typeof Flags>;

export type OpencodeAdapterOptions = {
  /** A stand-in for opencode, e.g. the stub in tests; wins over `flags.bin`. */
  readonly bin?: Argv;
  readonly clock?: Clock;
  /** How long interrupt and each step of `stop('graceful')` wait; also the host's grace. */
  readonly graceMs?: number;
  /**
   * Run a stand-in without Seatbelt where there is none (a Linux test host). Tests only: the real
   * runner on a local executor always runs sandboxed, and is refused where it cannot be.
   */
  readonly unsandboxed?: true;
  /** Where a session's context proxy reports (spec M12); by default a process warning. */
  readonly contextLog?: ProxyLog;
};

/** What the tee observer learns from the host's stdout. Mutable, per process, never exposed. */
type Watch = {
  runId: string | undefined;
  /** The host has exited: nothing more can be written to it. */
  exited: boolean;
  readonly started: PromiseWithResolvers<HostStart | undefined>;
};

type Session = {
  readonly proc: Proc;
  /** The home is on this host (a local executor): its tool-group record is readable here. */
  readonly local: boolean;
  readonly homeDir: string;
  readonly cwd: string;
  readonly records: RecordQueue;
  readonly run: RunTracker;
  readonly watch: Watch;
  readonly send: (op: HostOp) => Promise<Result<void>>;
  readonly endInput: () => Promise<void>;
  /** The session's context proxy (spec M12), closed when the host ends. */
  readonly proxy?: SessionProxy;
};

const decoder = new TextDecoder();

/** Spec M12: the proxy runs beside the supervisor, so this runner compresses on a local one only. */
const compressesContext: CompressesContext = (ex) => ex.kind === "local";

const toArgv = (xs: readonly string[]): Argv => {
  const [program = "opencode", ...rest] = xs;
  return [program, ...rest];
};

/**
 * Tracks the run from the host's stdout. Never writes a terminal (Invariant 3): the run ends on
 * opencode's own answer to the prompt, whose id the host's turn frame names.
 */
function observe(
  record: RawRecord,
  watch: Watch & { rpcId: unknown },
  run: RunTracker,
  endStream: () => void,
): void {
  if (record.partial) return;
  const text = decoder.decode(record.bytes);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const v = value as {
    type?: unknown;
    id?: unknown;
    method?: unknown;
    rpc_id?: unknown;
  };
  if (v.type === HOST_START) {
    const start = HostStart.safeParse(value);
    watch.started.resolve(start.success ? start.data : undefined);
    return;
  }
  if (v.type === "frm.host.turn") {
    watch.rpcId = v.rpc_id;
    return;
  }
  if (v.type === HOST_EXIT) {
    // opencode ended; with a run open nothing will answer it: end the stream, so the supervisor
    // closes the run (runner_exited_without_terminal) and the reconciler adopts by resume.
    if (run.open) endStream();
    return;
  }
  if (
    v.method === undefined &&
    v.id !== undefined &&
    v.id === watch.rpcId &&
    run.open
  ) {
    watch.rpcId = undefined;
    run.ended();
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

/**
 * What `spawn` refuses before any process starts (design §5), or the session's config: built once
 * the context proxy, if any, is listening (spec M12), since the proxy is then the provider's URL.
 */
function planSession(
  spec: SpawnSpec,
  flags: Flags,
): Result<{
  readonly config: (proxy?: SessionProxy) => Record<string, unknown>;
  readonly block: ProviderBlock;
}> {
  const model = parseModel(spec.model);
  if (!model.ok) return model;
  const provided = flags.providers[model.value.provider];
  if (provided === undefined) {
    return err(
      frmError(
        "validation",
        `no provider block for ${JSON.stringify(model.value.provider)}: add it to the ${RUNNER_ID} runner's providers (operator data)`,
      ),
    );
  }
  // The models row's own provider URL, when it has one, in place of the runner's.
  const settings = parseModelSettings(spec.modelSettings);
  if (!settings.ok) return settings;
  const block = blockFor(provided, settings.value);
  if (spec.mcp !== undefined && spec.mcp.token === "") {
    return err(frmError("validation", "spec.mcp has an empty token"));
  }
  if (spec.builtinTools === "none") {
    // Plan rule 4: an MCP-only session reads untrusted input. A blanket deny would hide opencode's
    // own tools (design fact 7), but that is not verified live, so this runner refuses.
    return err(
      frmError(
        "validation",
        `${RUNNER_ID} cannot run an MCP-only session yet (builtinTools none): staff it on another runner`,
      ),
    );
  }
  if (spec.extraRoots !== undefined && spec.extraRoots.length > 0) {
    return err(
      frmError(
        "validation",
        `${RUNNER_ID} cannot grant extra roots yet (external_directory is unverified): staff a multi-repo session on another runner`,
      ),
    );
  }
  if (spec.grantedLogin !== undefined) {
    return err(
      frmError("validation", `${RUNNER_ID} has no login to use in place`),
    );
  }
  return ok({
    block,
    config: (proxy) =>
      sessionConfig({
        model: spec.model,
        provider: model.value.provider,
        modelId: model.value.id,
        block,
        readOnly: flags.readOnly,
        mcpTools: spec.mcp?.tools ?? [],
        // While proxied, the store of originals too: opencode's read tool may open them there,
        // and Seatbelt keeps every write out (spec M12; the store is outside every writable root).
        ownDirs: [
          ...ownDirs(spec.homeDir),
          ...(spec.contextCompression === undefined
            ? []
            : [spec.contextCompression.storeDir]),
        ],
        ...(flags[COMMAND_POLICY_FLAG] === undefined
          ? {}
          : { policy: flags[COMMAND_POLICY_FLAG] }),
        ...(proxy === undefined
          ? {}
          : { modelProxy: { url: proxy.url, header: PROXY_HEADER } }),
      }),
  });
}

export function createOpencodeAdapter(
  options: OpencodeAdapterOptions = {},
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

  async function start(
    spec: SpawnSpec,
    ex: Executor,
    resume: string | null,
  ): Promise<Result<SessionHandle>> {
    const flags = Flags.safeParse(spec.flags);
    if (!flags.success)
      return err(frmError("validation", `flags: ${flags.error.message}`));
    const plan = planSession(spec, flags.data);
    if (!plan.ok) return plan;
    const refused = placementRefusal(ex.kind, options.unsandboxed === true);
    if (refused !== null) return err(refused);
    const bin = options.bin ?? toArgv(flags.data.bin);
    const version = await checkVersion(ex, bin, spec);
    if (!version.ok) return version;
    // Spec M12: the context proxy stands in for the provider, at the address the session resolves.
    const upstream = baseUrlOf(plan.value.block, spec.env);
    if (spec.contextCompression !== undefined && upstream === undefined) {
      return err(
        frmError(
          "validation",
          "context compression needs the provider's base URL, and this session's provider block resolves none",
        ),
      );
    }
    const proxied = await startSessionProxy(spec, ex, {
      compresses: compressesContext,
      transform: OPENCODE_CONTEXT,
      upstream: upstream ?? "",
      ...(options.contextLog === undefined ? {} : { log: options.contextLog }),
    });
    if (!proxied.ok) return proxied;
    const proxy = proxied.value;
    const launched = await launch(spec, ex, flags.data, plan.value, {
      bin,
      resume,
      proxy,
    });
    if (!launched.ok) await proxy?.close();
    return launched;
  }

  /** The turn host, from a checked plan; `proxy` is the session's context proxy, if any. */
  async function launch(
    spec: SpawnSpec,
    ex: Executor,
    flags: Flags,
    plan: Extract<ReturnType<typeof planSession>, { ok: true }>["value"],
    o: {
      readonly bin: Argv;
      readonly resume: string | null;
      readonly proxy: SessionProxy | undefined;
    },
  ): Promise<Result<SessionHandle>> {
    const { bin, resume, proxy } = o;
    const policy = flags[COMMAND_POLICY_FLAG];
    const prefix = await confinement(
      ex,
      spec,
      policy,
      plan.block,
      options.unsandboxed === true,
      proxy?.port,
    );
    if (!prefix.ok) return prefix;
    const { env, allow } = hostEnv(
      spec.env,
      spec.homeDir,
      plan.config(proxy),
      spec.mcp?.token,
      // While proxied opencode never reads the provider's own address.
      proxy === undefined ? envRefsOf(plan.block) : [],
      proxy?.token,
    );
    const node = ex.kind === "local" ? process.execPath : flags.hostNode;
    let proc: Proc;
    try {
      proc = await ex.exec(
        hostArgv(node, {
          v: 1,
          home: spec.homeDir,
          bin: [...prefix.value, ...bin],
          model: spec.model,
          resume,
          graceMs,
          mcpUrl: spec.mcp?.url ?? null,
          allow,
        }),
        { cwd: spec.cwd, env, stdin: "pipe", detached: true },
      );
    } catch (e) {
      return err(asFrmError(e, "spawn_failed", "cannot start the turn host"));
    }
    const run = new RunTracker();
    const watch: Watch & { rpcId: unknown } = {
      runId: undefined,
      rpcId: undefined,
      exited: false,
      started: Promise.withResolvers<HostStart | undefined>(),
    };
    const io = writer(proc, () => watch.exited);
    const teed = tee(proc, {
      observe: (r) =>
        observe(r, watch, run, () => {
          void io.end();
        }),
    });
    // The proxy's frames join the host's records between whole lines; it goes with the host.
    proxy?.frames.attach(teed.records);
    void teed.exited.then(() => {
      watch.exited = true;
      run.ended();
      watch.started.resolve(undefined);
      void proxy?.close();
    });
    const timer = new AbortController();
    const started = await Promise.race([
      watch.started.promise,
      clock.after(flags.initTimeoutMs, timer.signal).then(
        () => undefined,
        () => undefined,
      ),
    ]);
    timer.abort();
    if (
      started === undefined ||
      (resume !== null && started.runner_session_id !== resume)
    ) {
      proc.kill("SIGKILL");
      const tail = await settlesWithin(teed.exited, clock, graceMs).then(
        async (exited) => (exited ? (await teed.exited).stderrTail : ""),
      );
      if (
        started === undefined &&
        resume !== null &&
        /session\/resume/.test(tail)
      ) {
        return err(
          frmError(
            "validation",
            `no ${RUNNER_ID} session ${resume} to resume: ${tail.slice(-300)}`,
          ),
        );
      }
      return err(
        frmError(
          "spawn_failed",
          `the turn host did not start: ${tail.slice(-500)}`,
          {
            retryable: true,
          },
        ),
      );
    }
    const handle: SessionHandle = {
      sessionId: spec.sessionId,
      runnerSessionId: started.runner_session_id,
      executorRef: proc.ref,
      exited: teed.exited,
    };
    sessions.set(handle, {
      proc,
      local: ex.kind === "local",
      homeDir: spec.homeDir,
      cwd: spec.cwd,
      records: teed.records,
      run,
      watch,
      send: io.send,
      endInput: io.end,
      ...(proxy === undefined ? {} : { proxy }),
    });
    return ok(handle);
  }

  async function interrupt(h: SessionHandle): Promise<Result<void>> {
    const s = sessions.get(h);
    if (s === undefined)
      return err(frmError("not_found", `no runner process for ${h.sessionId}`));
    const runId = s.watch.runId;
    if (!s.run.open || runId === undefined) return ok(undefined);
    const sent = await s.send({ op: "interrupt", run_id: runId });
    if (!sent.ok) return sent;
    if (!(await settlesWithin(s.run.whenEnded(), clock, graceMs))) {
      return err(
        frmError("timeout", "opencode did not answer the cancel", {
          retryable: true,
        }),
      );
    }
    return ok(undefined);
  }

  /** `kill` is SIGKILL; `graceful` cancels an open run, ends the host's input, then escalates. */
  async function halt(
    s: Session,
    h: SessionHandle,
    mode: "graceful" | "kill",
  ): Promise<void> {
    if (mode === "kill") {
      // Best effort, never waited on: a host still reading cancels the turn so opencode ends its
      // tool's own process group. Then the recorded tool groups, which SIGKILL never reaches.
      if (s.run.open && s.watch.runId !== undefined) {
        void s.send({ op: "interrupt", run_id: s.watch.runId });
      }
      s.proc.kill("SIGKILL");
      await h.exited;
      if (s.local) reapToolGroups(s.homeDir, s.cwd);
      return;
    }
    if (s.watch.exited) return;
    if (s.run.open) await interrupt(h);
    // The host cancels what is left, ends opencode's input (it exits by itself), then signals it.
    await settlesWithin(s.endInput(), clock, graceMs);
    if (await settlesWithin(h.exited, clock, 4 * graceMs)) return;
    s.proc.kill("SIGTERM");
    if (await settlesWithin(h.exited, clock, graceMs)) return;
    s.proc.kill("SIGKILL");
    await h.exited;
  }

  async function health(
    ex: Executor,
    at?: HealthPlace,
  ): Promise<Result<{ version: string }>> {
    const home = at?.tmp ?? tmpdir();
    const checked = await readVersion(
      ex,
      options.bin ?? toArgv(DEFAULTS.bin),
      at?.cwd ?? home,
      {
        PATH: ex.envPath ?? process.env["PATH"] ?? "",
        HOME: home,
      },
    );
    return checked.ok ? ok({ version: checked.value }) : checked;
  }

  return {
    id: RUNNER_ID,
    caps: () => CAPS,
    registration,
    validateModel: validateOpencodeModel,
    version: async () => VERSION_LINE,
    health,
    prepareHome: (spec, ex) => claimHome(spec.homeDir, spec.sessionId, ex),
    compressesContext,
    spawn: (spec, ex) => start(spec, ex, null),
    adopt: async (spec, ex) =>
      spec.resumeRunnerSessionId === undefined
        ? err(frmError("validation", "adopt needs resumeRunnerSessionId"))
        : start(spec, ex, spec.resumeRunnerSessionId),
    updateCheck: checkForUpdate,
    preflightModel: preflightOpencodeModel,

    async send(h, p) {
      const s = sessions.get(h);
      if (s === undefined)
        return err(
          frmError("not_found", `no runner process for ${h.sessionId}`),
        );
      if (s.run.open)
        return err(
          frmError("conflict", `a run is already open on ${h.sessionId}`),
        );
      if (p.output !== undefined) {
        const unsupported = unsupportedKeywords(p.output.schema);
        if (unsupported.length > 0) {
          return err(
            frmError(
              "validation",
              `the output schema uses keywords the ${RUNNER_ID} check cannot enforce: ${unsupported.join(", ")}`,
            ),
          );
        }
      }
      s.run.opened();
      s.watch.runId = p.runId;
      const sent = await s.send({
        op: "turn",
        run_id: p.runId,
        text: p.text,
        ...(p.output === undefined
          ? {}
          : {
              instruction: outputInstruction(p.output.schema),
              output: { schema: p.output.schema, path: p.output.path },
            }),
      });
      if (!sent.ok) {
        s.run.ended();
        return sent;
      }
      return ok(undefined);
    },

    records(h) {
      const s = sessions.get(h);
      if (s === undefined)
        throw frmError("not_found", `no runner process for ${h.sessionId}`);
      return s.records;
    },

    createMapper: (o) => createOpencodeMapper(o),
    interrupt,

    async stop(h, mode) {
      const s = sessions.get(h);
      if (s === undefined) return;
      try {
        await halt(s, h, mode);
      } finally {
        await s.proxy?.close();
      }
    },

    estimateTokens: async (text) => approximateTokens(text),

    async interactiveResume() {
      return err(
        frmError(
          "validation",
          `${RUNNER_ID} has no interactive mode here: takeover is not supported`,
        ),
      );
    },
  };
}
