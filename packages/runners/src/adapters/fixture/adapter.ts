// The `fixture` runner: a scripted program behind the real RunnerAdapter contract, so every
// non-live test, and the M0 smoke, drive the supervisor without a model.
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  err,
  ok,
  systemClock,
  type Clock,
  type Result,
  type RunnerCaps,
} from "@bayon/core";
import type { Argv, Executor, Proc } from "@bayon/executors";
import { z } from "zod";
import type {
  ModelRow,
  Registration,
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
  FIXTURE_IMAGE_COMMAND,
  fixtureContainerDefaults,
} from "./container.js";
import { createFixtureMapper } from "./mapper.js";
import {
  DEFAULT_SCRIPT,
  FIXTURE_MCP_TOKEN_ENV,
  FixtureScript,
  type FixtureSpec,
} from "./program.js";

export const FIXTURE_RUNNER_ID = "fixture";
export const FIXTURE_VERSION = "1";
/** The argv[0] that FakeExecutor tests register `fixtureProgram` under. */
export const FIXTURE_PROGRAM = "fixture-runner";

const here = fileURLToPath(import.meta.url);
const programPath = fileURLToPath(
  new URL(`./program${extname(here)}`, import.meta.url),
);

/** This Node running the program: program.ts (types stripped) from the sources, .js from dist. */
export const FIXTURE_COMMAND: Argv = programPath.endsWith(".ts")
  ? [
      process.execPath,
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      programPath,
    ]
  : [process.execPath, programPath];

/**
 * How `ex` starts the program: a session it places (a container's) runs the image's program with
 * the image's node, whose paths are the image's; every other runs `FIXTURE_COMMAND`.
 */
export const fixtureCommand = (ex: Executor): Argv =>
  ex.placeSession === undefined ? FIXTURE_COMMAND : FIXTURE_IMAGE_COMMAND;

export const FIXTURE_CAPS: RunnerCaps = {
  structuredEvents: true,
  multiTurnInProcess: true,
  resumable: true,
  concurrentSessions: true,
  costReporting: true,
  tokenCounting: false,
  toolApprovalCallback: false,
  sandboxModes: false,
  // A script's `mcp` steps call spec.mcp as plain JSON-RPC (M1 close).
  mcpClient: true,
  hooks: false,
  pty: false,
  outputSchema: false,
  imageInput: false,
  subagents: false,
};

const MODELS: readonly ModelRow[] = (
  ["complex", "standard", "cheap"] as const
).map((tier) => ({
  id: `${FIXTURE_RUNNER_ID}.${tier}`,
  tier,
  model: "fixture-model",
  priceInPerMtok: 1,
  priceOutPerMtok: 5,
  priceCacheReadPerMtok: 0.1,
  priceCacheWritePerMtok: 1.25,
  contextTokens: 200_000,
}));

export type FixtureAdapterOptions = {
  /**
   * How to start the program on every executor. Default: per executor (`fixtureCommand`).
   * FakeExecutor tests use `FIXTURE_PROGRAM`; loopback container tests `FIXTURE_COMMAND`, since
   * their "image" is this host.
   */
  readonly command?: Argv;
  readonly clock?: Clock;
  /** How long `stop('graceful')` waits at each step before escalating. */
  readonly graceMs?: number;
};

export type FixtureAdapter = RunnerAdapter & {
  /** Opens a `gate: 'release'` run's gate. Fixture-only. */
  release(h: SessionHandle): Promise<Result<void>>;
};

type Session = {
  readonly proc: Proc;
  readonly records: RecordQueue;
  readonly run: RunTracker;
};

const decoder = new TextDecoder();

/** `flags.deny`: tools the session denies (§15 #12). */
const Deny = z.array(z.string());
function kindOf(bytes: Uint8Array): unknown {
  try {
    return (JSON.parse(decoder.decode(bytes)) as { kind?: unknown }).kind;
  } catch {
    return undefined;
  }
}

export function createFixtureAdapter(
  options: FixtureAdapterOptions = {},
): FixtureAdapter {
  const commandFor = (ex: Executor): Argv =>
    options.command ?? fixtureCommand(ex);
  const clock = options.clock ?? systemClock;
  const graceMs = options.graceMs ?? 5_000;
  const sessions = new WeakMap<SessionHandle, Session>();

  const lookup = (h: SessionHandle): Result<Session> => {
    const session = sessions.get(h);
    return session === undefined
      ? err(frmError("not_found", `no fixture process for ${h.sessionId}`))
      : ok(session);
  };

  async function write(
    session: Session,
    op: Readonly<Record<string, unknown>>,
  ): Promise<Result<void>> {
    if (session.proc.stdin === null) {
      return err(frmError("internal", "the fixture runner has no stdin"));
    }
    try {
      await session.proc.stdin.write(`${JSON.stringify(op)}\n`);
      return ok(undefined);
    } catch (e) {
      return err(
        asFrmError(e, "internal", "cannot write to the fixture runner"),
      );
    }
  }

  async function start(
    spec: SpawnSpec,
    ex: Executor,
    runnerSessionId: string,
    resume: boolean,
  ): Promise<Result<SessionHandle>> {
    const script = FixtureScript.safeParse(
      spec.flags["script"] ?? DEFAULT_SCRIPT,
    );
    if (!script.success) {
      return err(
        frmError("validation", `flags.script: ${script.error.message}`),
      );
    }
    const deny = Deny.safeParse(spec.flags["deny"] ?? []);
    if (!deny.success) {
      return err(frmError("validation", `flags.deny: ${deny.error.message}`));
    }
    const mcp = spec.mcp;
    if (mcp !== undefined && mcp.token === "") {
      return err(frmError("validation", "spec.mcp has an empty token"));
    }
    // The url and tool names ride in argv; the token only in the child's env (never argv).
    const fixtureSpec: FixtureSpec = {
      runnerSessionId,
      homeDir: spec.homeDir,
      resume,
      deny: deny.data,
      script: { ...script.data, model: spec.model || script.data.model },
      ...(mcp === undefined
        ? {}
        : { mcp: { url: mcp.url, tools: [...mcp.tools] } }),
      ...(spec.builtinTools === undefined
        ? {}
        : { builtinTools: spec.builtinTools }),
      extraRoots: [...(spec.extraRoots ?? [])],
    };
    const env =
      mcp === undefined
        ? spec.env
        : { ...spec.env, [FIXTURE_MCP_TOKEN_ENV]: mcp.token };
    let proc: Proc;
    try {
      proc = await ex.exec(
        [...commandFor(ex), "--spec", JSON.stringify(fixtureSpec)],
        { cwd: spec.cwd, env, stdin: "pipe", detached: true },
      );
    } catch (e) {
      return err(
        asFrmError(e, "spawn_failed", "cannot start the fixture runner"),
      );
    }
    const run = new RunTracker();
    const { records, exited } = tee(proc, {
      observe: (record) => {
        if (!record.partial && kindOf(record.bytes) === "terminal") run.ended();
      },
    });
    void exited.then(() => run.ended());
    const handle: SessionHandle = {
      sessionId: spec.sessionId,
      runnerSessionId,
      executorRef: proc.ref,
      exited,
    };
    sessions.set(handle, { proc, records, run });
    return ok(handle);
  }

  return {
    id: FIXTURE_RUNNER_ID,
    caps: () => FIXTURE_CAPS,
    registration: (): Registration => ({
      models: MODELS,
      runner: {
        id: FIXTURE_RUNNER_ID,
        kind: "script",
        adapter: FIXTURE_RUNNER_ID,
        versionDetected: FIXTURE_VERSION,
        caps: FIXTURE_CAPS,
        // Its image lines, or why it cannot run in a container. Its session baseline is
        // small: a scripted program, no system prompt or tool schemas (context_baseline).
        defaults: {
          sessionBaselineTokens: 1_000,
          ...fixtureContainerDefaults(),
        },
      },
    }),
    version: async () => FIXTURE_VERSION,
    health: async () => ok({ version: FIXTURE_VERSION }),
    prepareHome: (spec, ex) => claimHome(spec.homeDir, spec.sessionId, ex),
    spawn: (spec, ex) => start(spec, ex, randomUUID(), false),
    adopt: async (spec, ex) =>
      spec.resumeRunnerSessionId === undefined
        ? err(frmError("validation", "adopt needs resumeRunnerSessionId"))
        : start(spec, ex, spec.resumeRunnerSessionId, true),

    async send(h, p) {
      const session = lookup(h);
      if (!session.ok) return session;
      if (session.value.run.open) {
        return err(
          frmError("conflict", `a run is already open on ${h.sessionId}`),
        );
      }
      // Opened before the write: the terminal may arrive before the write resolves.
      session.value.run.opened();
      const sent = await write(session.value, {
        op: "send",
        runId: p.runId,
        text: p.text,
      });
      if (!sent.ok) session.value.run.ended();
      return sent;
    },

    records(h) {
      const session = sessions.get(h);
      if (session === undefined) {
        throw frmError("not_found", `no fixture process for ${h.sessionId}`);
      }
      return session.records;
    },

    createMapper: () => createFixtureMapper(),

    async interrupt(h) {
      const session = lookup(h);
      return session.ok ? write(session.value, { op: "interrupt" }) : session;
    },

    async release(h) {
      const session = lookup(h);
      return session.ok ? write(session.value, { op: "release" }) : session;
    },

    async stop(h, mode) {
      const session = sessions.get(h);
      if (session === undefined) return;
      if (mode === "kill") {
        session.proc.kill("SIGKILL");
        await h.exited;
        return;
      }
      if (session.run.open) {
        await write(session, { op: "interrupt" });
        await settlesWithin(session.run.whenEnded(), clock, graceMs);
      }
      // Bounded: ending a dead child's stdin never finishes (conformance test 9's teardown found it).
      await settlesWithin(
        session.proc.stdin?.end() ?? Promise.resolve(),
        clock,
        graceMs,
      );
      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        if (await settlesWithin(h.exited, clock, graceMs)) return;
        session.proc.kill(signal);
      }
      await h.exited;
    },

    estimateTokens: async (text) => approximateTokens(text),

    async interactiveResume(spec, runnerSessionId) {
      // A trivial, real, runnable stand-in: enough for a test to assert a process really runs
      // under tmux for a resumed session, without a scripted fixture protocol of its own.
      return ok({
        argv: [
          process.execPath,
          "-e",
          `process.stdout.write(${JSON.stringify(`resumed ${runnerSessionId}\n`)});process.stdin.resume();`,
        ],
        env: spec.env,
      });
    },
  };
}
