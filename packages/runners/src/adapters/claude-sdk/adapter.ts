// The Claude Agent SDK runner (spec App. A, design §2): one long-lived CLI process per session,
// driven through the SDK's streaming-input `query` and spawned through our Executor. Events come
// from the stdout bytes alone (the raw log is their write-ahead log); the SDK's own message stream
// is drained only for the handshake. We never read the runner's transcript files.
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  query,
  type Options,
  type Query,
  type SDKUserMessage,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import {
  COMMAND_POLICY_FLAG,
  CommandPolicy,
  err,
  ok,
  systemClock,
  type Clock,
  type FrmError,
  type Result,
} from "@bayon/core";
import type { Argv, Executor, Proc } from "@bayon/executors";
import { z } from "zod";
import type {
  ExitInfo,
  HealthPlace,
  RawRecord,
  RunnerAdapter,
  SessionHandle,
  SpawnSpec,
} from "../../adapter.js";
import type { SessionProxy } from "../../context-session.js";
import { asFrmError, frmError } from "../../errors.js";
import { claimHome } from "../../home.js";
import type { ProxyLog, ProxyTrace } from "../../model-proxy.js";
import { createPushIterable, type PushIterable } from "../../push-iterable.js";
import type { RecordQueue } from "../../records.js";
import { RunTracker } from "../../run-tracker.js";
import { tee } from "../../tee.js";
import { approximateTokens } from "../../tokens.js";
import { settlesWithin } from "../../wait.js";
import { seedCliConfig } from "./cli-config.js";
import { CLAUDE_IMAGE_CLI } from "./container.js";
import { readDoctrine, writeDoctrineFile } from "./doctrine.js";
import { createMapper } from "./mapper.js";
import { Effort, validateClaudeSdkModel } from "./models.js";
import { ALWAYS_DISALLOWED_TOOLS, policyTools } from "./permissions.js";
import { mountMcp } from "./mcp-mount.js";
import { ProcFacade } from "./process-facade.js";
import {
  additionalDirectories,
  compressesContext,
  inlineEnv,
  sessionEnv,
  startProxy,
} from "./session-env.js";
import {
  CAPS,
  DEFAULTS,
  RUNNER_ID,
  detectVersion,
  registration,
} from "./registration.js";
import {
  OutputSlot,
  deliverOutput,
  outputFormatFor,
  outputTarget,
  resultFrameOf,
} from "./structured-output.js";
import { STRUCTURED_OUTPUT_TOOL, mcpToolName } from "./tool-names.js";
import { updateCheck as checkForUpdate } from "./update-check.js";

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/** Why a profile may not name a settings source. */
const NO_SETTING_SOURCES =
  "no settings file is loaded: a repository's settings can set the env its tools run with and " +
  "run commands with the session's credential in reach; its CLAUDE.md reaches the agent in the " +
  "system prompt";

/** The runner row's defaults merged with the profile (`spec.flags`). Unknown keys are ignored. */
const Flags = z.looseObject({
  /** Only ever empty: the CLI loads no settings file, the repo's or the home's. */
  settingSources: z
    .array(z.string())
    .max(0, NO_SETTING_SOURCES)
    .default([...DEFAULTS.settingSources]),
  // bypassPermissions is deliberately not accepted.
  permissionMode: z
    .enum(["default", "acceptEdits", "plan", "dontAsk", "auto"])
    .default(DEFAULTS.permissionMode),
  permissionPrompts: z
    .enum(["host", "none"])
    .default(DEFAULTS.permissionPrompts),
  allowedTools: z.array(z.string()).default([]),
  disallowedTools: z.array(z.string()).default([]),
  /** The role's default command policy, set when the profile gives no permissions. */
  [COMMAND_POLICY_FLAG]: CommandPolicy.optional(),
  /**
   * The profile's settings, passed inline so they outrank the repo's own settings files. Their
   * `env` is laid over the pins (pinned-env.ts): it is the operator's own, like the session env.
   */
  settings: z
    .looseObject({ env: z.record(z.string(), z.unknown()).optional() })
    .default({}),
  maxTurns: z.int().positive().optional(),
  initTimeoutMs: z.int().positive().default(DEFAULTS.initTimeoutMs),
  // No mcpTokenVia: the bearer goes over the control channel alone. A stored profile
  // that still names it parses: Flags is a looseObject, so the key is kept and nothing reads it.
});
type Flags = z.infer<typeof Flags>;

export type ClaudeSdkAdapterOptions = {
  /** A stand-in for the bundled CLI, e.g. the stub CLI in tests. */
  readonly pathToExecutable?: string;
  /** The runtime for a non-native `pathToExecutable`. */
  readonly executable?: "node" | "bun" | "deno";
  readonly executableArgs?: readonly string[];
  readonly clock?: Clock;
  /** How long interrupt and each step of `stop('graceful')` wait before escalating. */
  readonly graceMs?: number;
  /** Where a session's context proxy reports (spec M12); by default a process warning. */
  readonly contextLog?: ProxyLog;
  /** The context proxy's debug trace, method and path per request; by default NODE_DEBUG=frmproxy. */
  readonly contextTrace?: ProxyTrace;
};

type Started = {
  readonly proc: Proc;
  readonly records: RecordQueue;
  readonly exited: Promise<ExitInfo>;
};

type Session = Started & {
  /** The session's context proxy (spec M12), closed when the process ends. */
  readonly proxy?: SessionProxy;
  readonly q: Query;
  readonly prompts: PushIterable<SDKUserMessage>;
  readonly run: RunTracker;
  readonly runnerSessionId: string;
  /** The schema the process was started with (SpawnSpec.output): its runs' only one. */
  readonly output: SpawnSpec["output"];
  /** The open run's SendSpec.output.path, taken by its result. */
  readonly outputs: OutputSlot;
};

const definedEnv = (
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const decoder = new TextDecoder();

/**
 * A stdout line, seen before it is queued. A `result` line ends its run (every run has exactly
 * one); when the run asked for structured output, the answer is written first, where `ex` keeps
 * the session, so it is on disk before any reader can see the run end (deliverOutput).
 */
function observeLine(
  record: RawRecord,
  ex: Executor,
  run: RunTracker,
  outputs: OutputSlot,
): Promise<void> | undefined {
  const result = resultFrameOf(record);
  if (result === undefined) return undefined;
  const path = outputs.take();
  if (path === undefined || result.structured_output === undefined) {
    run.ended();
    return undefined;
  }
  return deliverOutput(ex, path, result.structured_output).then(() =>
    run.ended(),
  );
}

/** Drains the SDK's own message stream: it must be read, but events come from the bytes. */
async function drain(q: Query, run: RunTracker): Promise<void> {
  try {
    for await (const message of q) {
      if (message.type === "result") run.ended();
    }
  } catch {
    // The process died or the handshake broke. Callers learn it from the handle and the run's
    // terminal (or its absence) from the records; nothing here would add to that.
  } finally {
    run.ended();
  }
}

/** The bundled native binary for this platform, for `health`. */
export function bundledBinary(): string | undefined {
  try {
    const sdk = createRequire(import.meta.url).resolve(SDK_PACKAGE);
    const pkg = createRequire(sdk).resolve(
      `${SDK_PACKAGE}-${process.platform}-${process.arch}/package.json`,
    );
    return join(dirname(pkg), "claude");
  } catch {
    return undefined;
  }
}

/** The profile's denials plus the commands every session is denied (Bayon never pushes). */
function disallowedTools(flags: Flags): string[] {
  return [...new Set([...flags.disallowedTools, ...ALWAYS_DISALLOWED_TOOLS])];
}

/**
 * The profile's allowlist, its role's command policy, the session's MCP tools and, for a session
 * started with a schema, the tool that returns the answer (a tool that would prompt is denied
 * under permissionPrompts 'none'); denials win.
 */
function allowedTools(spec: SpawnSpec, flags: Flags): string[] {
  const mounted = (spec.mcp?.tools ?? []).map(mcpToolName);
  const denied = new Set(disallowedTools(flags));
  return [
    ...new Set([
      ...flags.allowedTools,
      ...policyTools(flags.commandPolicy),
      ...mounted,
      ...(spec.output === undefined ? [] : [STRUCTURED_OUTPUT_TOOL]),
    ]),
  ].filter((t) => !denied.has(t));
}

/** What a start needs before its process: the inline settings env and the doctrine. */
async function prepareStart(
  spec: SpawnSpec,
  flags: Flags,
  ex: Executor,
  proxy: SessionProxy | undefined,
): Promise<
  Result<{
    readonly settingsEnv: Readonly<Record<string, unknown>>;
    readonly doctrine: string | undefined;
  }>
> {
  const settingsEnv = inlineEnv(spec, flags.settings.env, proxy);
  if (!settingsEnv.ok) return settingsEnv;
  // Read afresh on adopt too: the same files, where the session left them.
  const doctrine = await readDoctrine(ex, spec.cwd);
  if (!doctrine.ok) return doctrine;
  return ok({ settingsEnv: settingsEnv.value, doctrine: doctrine.value });
}

export function createClaudeSdkAdapter(
  options: ClaudeSdkAdapterOptions = {},
): RunnerAdapter {
  const clock = options.clock ?? systemClock;
  const graceMs = options.graceMs ?? 5_000;
  const sessions = new WeakMap<SessionHandle, Session>();

  /**
   * The CLI the SDK starts on `ex`: a stand-in where one is given; in a session `ex` places (a
   * container's), the image's own, by its path in the image; anywhere else the SDK's
   * bundled binary, which the SDK finds itself (undefined).
   */
  const cliFor = (ex: Executor): string | undefined =>
    options.pathToExecutable ??
    (ex.placeSession === undefined ? undefined : CLAUDE_IMAGE_CLI);

  /** `--version` of the CLI `ex` would start; undefined when this platform bundles none. */
  function versionArgv(ex: Executor): Argv | undefined {
    if (options.pathToExecutable !== undefined) {
      const runtime =
        options.executable === undefined || options.executable === "node"
          ? process.execPath
          : options.executable;
      return [
        runtime,
        ...(options.executableArgs ?? []),
        options.pathToExecutable,
        "--version",
      ];
    }
    const binary = cliFor(ex) ?? bundledBinary();
    return binary === undefined ? undefined : [binary, "--version"];
  }

  function queryOptions(
    spec: SpawnSpec,
    flags: Flags,
    effort: Effort | undefined,
    identity: { readonly sessionId: string } | { readonly resume: string },
    spawn: (o: SpawnOptions) => ProcFacade,
    cli: string | undefined,
    settingsEnv: Readonly<Record<string, unknown>>,
    doctrine: string | undefined,
    childEnv: Readonly<Record<string, string>>,
  ): Options {
    return {
      cwd: spec.cwd,
      // A multi-repo workspace's other worktrees (SpawnSpec.extraRoots) and, while proxied, the store
      // of originals (spec M12), granted as the CLI's --add-dir, on spawn and on adopt alike.
      ...(additionalDirectories(spec).length === 0
        ? {}
        : { additionalDirectories: [...additionalDirectories(spec)] }),
      // The child's whole env: nothing inherited, and all runner state inside the session's home.
      // No MCP bearer: its Bash tool inherits this env; the mount goes over stdin (mcp-mount.ts).
      env: { ...childEnv, CLAUDE_CONFIG_DIR: spec.homeDir },
      model: spec.model,
      ...(effort === undefined ? {} : { effort }),
      ...identity,
      // No settings file, the repo's or the home's: none can set the env or run a
      // command. The inline settings below are the operator's, so they still apply.
      settingSources: [],
      // No compaction: hand off instead (Invariant 7). The pins stay should a source ever return.
      settings: {
        ...flags.settings,
        autoCompactEnabled: false,
        env: settingsEnv,
      } as Options["settings"],
      // The repo's CLAUDE.md, which no settings source loads now (doctrine.ts). It goes in the
      // initialize request on stdin, not argv.
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        ...(doctrine === undefined ? {} : { append: doctrine }),
      },
      permissionMode: flags.permissionMode,
      permissionPrompts: flags.permissionPrompts,
      allowedTools: allowedTools(spec, flags),
      disallowedTools: disallowedTools(flags),
      // The SDK's "no built-in tool" (argv `--tools ""`): allowedTools only auto-approves, and
      // disallowedTools names tools one by one. The mounted MCP tools stay.
      ...(spec.builtinTools === "none" ? { tools: [] } : {}),
      ...(flags.maxTurns === undefined ? {} : { maxTurns: flags.maxTurns }),
      // SpawnSpec.output: every run of this process answers in that schema (structured-output.ts).
      ...outputFormatFor(spec.output),
      // No server on argv: the session's is mounted after the handshake (mountMcp), and no other
      // config can add one.
      mcpServers: {},
      strictMcpConfig: true,
      persistSession: true, // resume needs the transcript; we never read it (Invariant 2)
      includePartialMessages: false,
      // A path without a .js suffix is a native binary to the SDK: argv [cli, …args], no runtime.
      ...(cli === undefined ? {} : { pathToClaudeCodeExecutable: cli }),
      ...(options.executable === undefined
        ? {}
        : { executable: options.executable }),
      ...(options.executableArgs === undefined
        ? {}
        : { executableArgs: [...options.executableArgs] }),
      spawnClaudeCodeProcess: spawn,
    };
  }

  async function start(
    spec: SpawnSpec,
    ex: Executor,
    runnerSessionId: string,
    resume: boolean,
  ): Promise<Result<SessionHandle>> {
    const flags = Flags.safeParse(spec.flags);
    if (!flags.success) {
      return err(frmError("validation", `flags: ${flags.error.message}`));
    }
    const effort =
      spec.effort === undefined ? undefined : Effort.safeParse(spec.effort);
    if (effort !== undefined && !effort.success) {
      return err(frmError("validation", `effort: ${spec.effort ?? ""}`));
    }
    if (spec.mcp !== undefined && spec.mcp.token === "") {
      // The CLI would send a bare "Bearer " and fail every call, silently.
      return err(frmError("validation", "spec.mcp has an empty token"));
    }
    if (spec.grantedLogin !== undefined) {
      // Its registration does not declare readsGrantedLogin, so the supervisor refuses such a grant
      // first; ignored here, the session would start with no credential at all.
      return err(
        frmError("validation", `${RUNNER_ID} cannot read a login in place`),
      );
    }
    // Spec M12: the context proxy, before anything else starts; off unless the spec asks.
    const started = await startProxy(spec, ex, flags.data.settings.env, {
      ...(options.contextLog === undefined ? {} : { log: options.contextLog }),
      ...(options.contextTrace === undefined
        ? {}
        : { trace: options.contextTrace }),
    });
    if (!started.ok) return started;
    const proxy = started.value;
    const prepared = await prepareStart(spec, flags.data, ex, proxy);
    if (!prepared.ok) {
      await proxy?.close();
      return prepared;
    }
    const { settingsEnv, doctrine } = prepared.value;

    let running: Started | undefined;
    let abandoned = false;
    const run = new RunTracker();
    const outputs = new OutputSlot();
    const startFailure = Promise.withResolvers<FrmError>();
    // Called by the SDK, which needs a process back synchronously; the executor's comes later.
    const spawn = (o: SpawnOptions): ProcFacade => {
      const facade = new ProcFacade();
      const argv: Argv = [o.command, ...o.args];
      void ex
        .exec(argv, {
          cwd: o.cwd ?? spec.cwd,
          env: definedEnv(o.env),
          stdin: "pipe",
          detached: true,
          signal: o.signal,
        })
        .then(
          (proc) => {
            const teed = tee(proc, {
              // A run ends at its result line, before any reader of the records can have it.
              observe: (r) => observeLine(r, ex, run, outputs),
              forward: (r) => facade.forward(r),
            });
            // The proxy's frames join the records between the runner's own lines.
            proxy?.frames.attach(teed.records);
            // The proxy goes with the process, however it ends.
            void teed.exited.then(() => proxy?.close());
            running = { proc, records: teed.records, exited: teed.exited };
            facade.attach(proc);
            void Promise.all([teed.drained, teed.exited]).then(([, info]) =>
              facade.exited(info),
            );
            if (abandoned) proc.kill("SIGKILL");
          },
          (e: unknown) => {
            const error = asFrmError(
              e,
              "spawn_failed",
              "cannot start the runner",
            );
            startFailure.resolve(error);
            facade.failed(new Error(error.message));
          },
        );
      return facade;
    };

    const prompts = createPushIterable<SDKUserMessage>();
    const identity = resume
      ? { resume: runnerSessionId }
      : { sessionId: runnerSessionId };
    const q = query({
      prompt: prompts,
      options: queryOptions(
        spec,
        flags.data,
        effort?.data,
        identity,
        spawn,
        cliFor(ex),
        settingsEnv,
        doctrine,
        sessionEnv(spec, flags.data.settings.env, proxy),
      ),
    });
    void drain(q, run);

    const timer = new AbortController();
    const failure = await Promise.race([
      // The handshake, then the MCP mount, both before a handle, so the first send
      // meets the tools; on adopt too, since a resumed process is a new one.
      q.initializationResult().then(
        () => mountMcp(q, spec),
        (e: unknown) =>
          frmError("spawn_failed", `runner handshake failed: ${String(e)}`),
      ),
      startFailure.promise,
      clock.after(flags.data.initTimeoutMs, timer.signal).then(
        () =>
          frmError(
            "spawn_failed",
            `no runner handshake and MCP mount within ${flags.data.initTimeoutMs} ms`,
            { retryable: true },
          ),
        () => undefined,
      ),
    ]);
    timer.abort();
    const live = running;
    if (failure !== undefined || live === undefined) {
      abandoned = true;
      prompts.end();
      live?.proc.kill("SIGKILL");
      q.close();
      await proxy?.close();
      return err(
        failure === undefined
          ? frmError("spawn_failed", "the runner did not start")
          : { ...failure, class: "spawn_failed" as const },
      );
    }

    const handle: SessionHandle = {
      sessionId: spec.sessionId,
      runnerSessionId,
      executorRef: live.proc.ref,
      exited: live.exited,
    };
    sessions.set(handle, {
      ...live,
      ...(proxy === undefined ? {} : { proxy }),
      q,
      prompts,
      run,
      runnerSessionId,
      output: spec.output,
      outputs,
    });
    return ok(handle);
  }

  async function interrupt(h: SessionHandle): Promise<Result<void>> {
    const session = sessions.get(h);
    if (session === undefined) {
      return err(frmError("not_found", `no runner process for ${h.sessionId}`));
    }
    // No open run: nothing to stop, and nothing the SDK needs to know (matches the fixture
    // adapter's no-op on an idle session).
    if (!session.run.open) {
      return ok(undefined);
    }
    try {
      const acknowledged = session.q.interrupt();
      if (!(await settlesWithin(acknowledged, clock, graceMs))) {
        return err(
          frmError("timeout", "the runner did not acknowledge the interrupt", {
            retryable: true,
          }),
        );
      }
      await acknowledged;
      return ok(undefined);
    } catch (e) {
      return err(asFrmError(e, "runner_error", "the interrupt failed"));
    }
  }

  /** `kill` is SIGKILL; `graceful` interrupts an open run, closes stdin, then escalates. */
  async function halt(
    session: Session,
    h: SessionHandle,
    mode: "graceful" | "kill",
  ): Promise<void> {
    if (mode === "kill") {
      session.proc.kill("SIGKILL");
      await h.exited;
      return;
    }
    if (session.run.open) {
      await interrupt(h);
      await settlesWithin(session.run.whenEnded(), clock, graceMs);
    }
    session.prompts.end(); // the SDK then closes the runner's stdin
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (await settlesWithin(h.exited, clock, graceMs)) return;
      session.proc.kill(signal);
    }
    await h.exited;
  }

  async function health(
    ex: Executor,
    at?: HealthPlace,
  ): Promise<Result<{ version: string }>> {
    const argv = versionArgv(ex);
    if (argv === undefined) {
      return err(
        frmError(
          "not_found",
          `no bundled runner binary for ${process.platform}-${process.arch}`,
        ),
      );
    }
    try {
      // A placed session's own dirs where the executor is not this host (a container).
      const home = at?.tmp ?? tmpdir();
      const proc = await ex.exec(argv, {
        cwd: at?.cwd ?? home,
        env: {
          CLAUDE_CONFIG_DIR: home,
          ...(ex.envPath === undefined ? {} : { PATH: ex.envPath }),
        },
        stdin: "ignore",
      });
      const { records, exited } = tee(proc);
      const lines: string[] = [];
      for await (const r of records) lines.push(decoder.decode(r.bytes));
      const status = await exited;
      const version = lines[0]?.trim() ?? "";
      return status.code === 0 && version !== ""
        ? ok({ version })
        : err(
            frmError(
              "runner_error",
              `runner --version failed: ${status.stderrTail}`,
            ),
          );
    } catch (e) {
      return err(asFrmError(e, "spawn_failed", "cannot start the runner"));
    }
  }

  return {
    id: RUNNER_ID,
    caps: () => CAPS,
    registration,
    validateModel: validateClaudeSdkModel,
    version: async () => detectVersion(),
    health,
    prepareHome: (spec, ex) => claimHome(spec.homeDir, spec.sessionId, ex),
    compressesContext,
    spawn: (spec, ex) => start(spec, ex, randomUUID(), false),
    adopt: async (spec, ex) =>
      spec.resumeRunnerSessionId === undefined
        ? err(frmError("validation", "adopt needs resumeRunnerSessionId"))
        : start(spec, ex, spec.resumeRunnerSessionId, true),
    updateCheck: checkForUpdate,

    async send(h, p) {
      const session = sessions.get(h);
      if (session === undefined) {
        return err(
          frmError("not_found", `no runner process for ${h.sessionId}`),
        );
      }
      if (session.run.open) {
        return err(
          frmError("conflict", `a run is already open on ${h.sessionId}`),
        );
      }
      const target = outputTarget(session.output, p.output);
      if (!target.ok) return target;
      session.outputs.arm(target.value);
      session.run.opened();
      // The run's result echoes this uuid (`user_message_uuid`), tying it to this send.
      const pushed = session.prompts.push({
        type: "user",
        message: { role: "user", content: p.text },
        parent_tool_use_id: null,
        session_id: session.runnerSessionId,
        uuid: randomUUID(),
      });
      if (!pushed) {
        session.outputs.arm(undefined);
        session.run.ended();
        return err(
          frmError(
            "internal",
            `the runner's input is closed on ${h.sessionId}`,
          ),
        );
      }
      return ok(undefined);
    },

    records(h) {
      const session = sessions.get(h);
      if (session === undefined) {
        throw frmError("not_found", `no runner process for ${h.sessionId}`);
      }
      return session.records;
    },

    createMapper: (o) => createMapper(o),
    interrupt,

    async stop(h, mode) {
      const session = sessions.get(h);
      if (session === undefined) return;
      try {
        await halt(session, h, mode);
      } finally {
        // The proxy goes with the process, stopped cleanly or not.
        await session.proxy?.close();
      }
    },

    estimateTokens: async (text) => approximateTokens(text),

    async interactiveResume(spec, runnerSessionId, ex) {
      const binary = cliFor(ex) ?? bundledBinary();
      if (binary === undefined) {
        return err(
          frmError(
            "validation",
            "no claude binary for interactive resume on this platform",
          ),
        );
      }
      // The takeover's CLI is the same one in the same worktree: no settings file, the same pins,
      // the same doctrine. It is not compressed (spec M12): a person at a terminal, its
      // pins name the operator's own base URL, and no proxy outlives the headless process.
      const flags = Flags.safeParse(spec.flags);
      if (!flags.success) {
        return err(frmError("validation", `flags: ${flags.error.message}`));
      }
      const settingsEnv = inlineEnv(spec, flags.data.settings.env);
      if (!settingsEnv.ok) return settingsEnv;
      const doctrine = await writeDoctrineFile(ex, spec.cwd, spec.homeDir);
      if (!doctrine.ok) return doctrine;
      // The interactive binary has first-run gates the SDK path never meets. Seeded
      // here rather than in prepareHome: only an attach needs it, and this is the one place that
      // knows both the home and the workspace the CLI will ask about.
      const seeded = await seedCliConfig(spec, ex);
      if (!seeded.ok) return seeded;
      return ok({
        argv: [
          binary,
          "--resume",
          runnerSessionId,
          "--setting-sources=",
          "--settings",
          JSON.stringify({ env: settingsEnv.value }),
          ...(doctrine.value === undefined
            ? []
            : ["--append-system-prompt-file", doctrine.value]),
        ],
        env: { ...spec.env, CLAUDE_CONFIG_DIR: spec.homeDir },
      });
    },
  };
}
