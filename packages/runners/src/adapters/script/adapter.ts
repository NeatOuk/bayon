// The generic `script` runner adapter (spec §5.3, §10.5): a deterministic job, not an LLM, behind
// the same RunnerAdapter contract as every other runner -- so it gets sessions, runs, events,
// evidence and retries with no separate plumbing. One adapter *instance* is registered per job
// (its argv rides in `registration().runner.defaults`, per CLAUDE.md: a job-specific detail belongs
// in the adapter's defaults_json, not scattered across profiles); the IPC and process lifecycle are
// shared. Never resumable (§5.1): a script job is cheap to redo from scratch, so there is no adopt
// path -- a dead child just means the next trigger runs it again.
import { randomUUID } from "node:crypto";
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
import { createScriptMapper } from "./mapper.js";

export const SCRIPT_VERSION = "1";

const Flags = z.object({ argv: z.array(z.string()).min(1) });

/** A script job is not billed, not multi-turn, and not resumable; everything else is off too. */
export const SCRIPT_CAPS: RunnerCaps = {
  structuredEvents: true,
  multiTurnInProcess: false,
  resumable: false,
  concurrentSessions: true, // a job is a plain process: nothing is shared between two
  costReporting: false,
  tokenCounting: false,
  toolApprovalCallback: false,
  sandboxModes: false,
  mcpClient: false,
  hooks: false,
  pty: false,
  outputSchema: false,
  imageInput: false,
  subagents: false,
};

export interface ScriptAdapterOptions {
  /** The runner id this instance registers as -- one per job. */
  readonly id: string;
  /** The job's command, e.g. `[process.execPath, ".../export-markdown.js"]`. Every profile using
   * this runner id inherits it via `SpawnSpec.flags.argv` (§9.5's config-over-code: the generic
   * `spawn` still reads `flags.argv`, never this closure, so a profile could override it). */
  readonly argv: Argv;
  readonly clock?: Clock;
  /** How long `stop('graceful')` waits at each step before escalating. */
  readonly graceMs?: number;
  readonly caps?: Partial<RunnerCaps>;
}

type Session = {
  readonly proc: Proc;
  readonly records: RecordQueue;
  readonly run: RunTracker;
};

const decoder = new TextDecoder();
function kindOf(bytes: Uint8Array): unknown {
  try {
    return (JSON.parse(decoder.decode(bytes)) as { kind?: unknown }).kind;
  } catch {
    return undefined;
  }
}

export function createScriptAdapter(
  options: ScriptAdapterOptions,
): RunnerAdapter {
  const clock = options.clock ?? systemClock;
  const graceMs = options.graceMs ?? 5_000;
  const caps: RunnerCaps = { ...SCRIPT_CAPS, ...options.caps };
  const sessions = new WeakMap<SessionHandle, Session>();

  const lookup = (h: SessionHandle): Result<Session> => {
    const session = sessions.get(h);
    return session === undefined
      ? err(frmError("not_found", `no script process for ${h.sessionId}`))
      : ok(session);
  };

  async function write(
    session: Session,
    op: Readonly<Record<string, unknown>>,
  ): Promise<Result<void>> {
    if (session.proc.stdin === null) {
      return err(frmError("internal", "the script runner has no stdin"));
    }
    try {
      await session.proc.stdin.write(`${JSON.stringify(op)}\n`);
      return ok(undefined);
    } catch (e) {
      return err(
        asFrmError(e, "internal", "cannot write to the script runner"),
      );
    }
  }

  async function start(
    spec: SpawnSpec,
    ex: Executor,
  ): Promise<Result<SessionHandle>> {
    const flags = Flags.safeParse(spec.flags);
    if (!flags.success) {
      return err(frmError("validation", `flags.argv: ${flags.error.message}`));
    }
    const [program, ...rest] = flags.data.argv;
    if (program === undefined) {
      return err(frmError("validation", "flags.argv must not be empty"));
    }
    const argv: Argv = [program, ...rest];
    let proc: Proc;
    try {
      proc = await ex.exec(argv, {
        cwd: spec.cwd,
        env: spec.env,
        stdin: "pipe",
        detached: true,
      });
    } catch (e) {
      return err(
        asFrmError(e, "spawn_failed", "cannot start the script runner"),
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
      runnerSessionId: randomUUID(),
      executorRef: proc.ref,
      exited,
    };
    sessions.set(handle, { proc, records, run });
    return ok(handle);
  }

  return {
    id: options.id,
    caps: () => caps,
    registration: (): Registration => ({
      models: [
        {
          id: `${options.id}.cheap`,
          tier: "cheap",
          model: "script",
          priceInPerMtok: 0,
          priceOutPerMtok: 0,
          priceCacheReadPerMtok: 0,
          priceCacheWritePerMtok: 0,
          contextTokens: 0,
        },
      ],
      runner: {
        id: options.id,
        kind: "script",
        adapter: options.id,
        versionDetected: SCRIPT_VERSION,
        caps,
        // A job sends no model a prompt: no session baseline (context_baseline).
        defaults: { argv: options.argv, sessionBaselineTokens: 0 },
      },
    }),
    version: async () => SCRIPT_VERSION,
    health: async () => ok({ version: SCRIPT_VERSION }),
    prepareHome: (spec, ex) => claimHome(spec.homeDir, spec.sessionId, ex),
    spawn: (spec, ex) => start(spec, ex),
    adopt: async () =>
      err(frmError("validation", `runner ${options.id} is not resumable`)),

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
        throw frmError("not_found", `no script process for ${h.sessionId}`);
      }
      return session.records;
    },

    createMapper: () => createScriptMapper(),

    async interrupt(h) {
      const session = lookup(h);
      return session.ok ? write(session.value, { op: "interrupt" }) : session;
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
      await session.proc.stdin?.end();
      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        if (await settlesWithin(h.exited, clock, graceMs)) return;
        session.proc.kill(signal);
      }
      await h.exited;
    },

    estimateTokens: async (text) => approximateTokens(text),

    async interactiveResume() {
      // Never resumable (see header): nothing for a human to attach to.
      return err(
        frmError(
          "validation",
          "script runners are not resumable: takeover is not supported",
        ),
      );
    },
  };
}
