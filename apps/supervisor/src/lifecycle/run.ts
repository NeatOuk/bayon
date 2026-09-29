// Runs: run n from a compiled prompt (§8.2), the wall-clock timer (§13.2), and a run's end.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  canonicalJson,
  err,
  ok,
  promptHashes,
  type FrmError,
  type Result,
  type RunClass,
  type SessionState,
} from "@bayon/core";
import {
  getOpenRun,
  getRun,
  getSession,
  listRuns,
  listSessionWorktrees,
  type RunRow,
  type SessionRow,
} from "@bayon/db";
import { appendRun, finishRun } from "@bayon/db/supervisor";
import type { SendSpec } from "@bayon/runners";
import { turnAllowed } from "./admission.js";
import { runAfterExit } from "./after-exit.js";
import { settlesWithin } from "./async-util.js";
import {
  move,
  patchEntry,
  releaseEntry,
  schedule,
  type Ctx,
  type LiveProcess,
} from "./context.js";
import { endSession } from "./end.js";
import { frmError } from "./errors.js";
import { outputFile, promptFile, sessionPathsOn } from "./paths.js";
import { exitedOk, runArgv } from "./exec.js";
import type { SupervisorClose } from "./ports.js";
import { stopProcess } from "./process.js";
import { compileRun, type RunRequest } from "./prompt.js";
import { findRunClass } from "./resolve.js";

/**
 * Opens run `req.seq` on the session: compile → pre-flight → prompts/run-<n>.md → the run row (its
 * template, token estimate, cuts and pinned hashes) → send. Call it on the session's queue. It
 * opens no run when there is no live process or the session is not in `req.within` (default
 * idle: `conflict`), the seq is taken (`conflict`) or not next (`validation`), an input is bad
 * (`validation`), or the prompt is over its cap (`over_budget`, with every section's size). A run
 * from idle moves the session through running; one started inside another state never moves it.
 */
export async function startRun(
  ctx: Ctx,
  id: string,
  req: RunRequest,
): Promise<Result<RunRow>> {
  const proc = ctx.live.get(id)?.proc;
  if (proc === undefined) {
    return refused(
      ctx,
      id,
      req,
      frmError("conflict", `session ${id} has no live process`),
    );
  }
  // mayStartTurn: pause and a spent budget refuse a new run, never one in flight.
  const turn = await turnAllowed(ctx, id, req.turn ?? "run");
  if (!turn.ok) return refused(ctx, id, req, turn.error);
  const inside =
    req.within === undefined || req.within === "idle" ? undefined : req.within;
  const pinned = await pinnedInputs(ctx, id, req.seq, inside ?? "idle");
  if (!pinned.ok) return refused(ctx, id, req, pinned.error);
  const prompt = await compileRun(
    ctx,
    proc.adapter,
    pinned.value.runClass,
    req,
  );
  if (!prompt.ok) return refused(ctx, id, req, prompt.error);
  const { compiled, tokens } = prompt.value;
  // The prompt is ours (local); the output file is where the runner can write it.
  const paths = sessionPathsOn(ctx.frmHome, id, proc.executor);
  const promptPath = promptFile(paths, req.seq);
  const output =
    req.output === undefined
      ? undefined
      : { schema: req.output.schema, path: outputFile(paths, req.seq) };
  try {
    await writeFile(promptPath, compiled.text, { mode: 0o600 });
    if (output !== undefined && !paths.remote) {
      await mkdir(dirname(output.path), { recursive: true, mode: 0o700 });
    }
  } catch (e) {
    return refused(
      ctx,
      id,
      req,
      frmError("internal", `cannot write ${promptPath}`, String(e)),
    );
  }
  if (output !== undefined && paths.remote) {
    const what = `mkdir for run ${req.seq}'s output`;
    const made = exitedOk(
      await runArgv(ctx, proc.executor, ["mkdir", "-p", dirname(output.path)], {
        what,
        cwd: paths.root,
      }),
      what,
    );
    if (!made.ok) return refused(ctx, id, req, made.error);
  }
  const s = pinned.value.session;
  // Recorded with the run: a restart judges its timeout by this, never today's run class (§3.2).
  const wallClockMs = req.wallClockMs ?? pinned.value.runClass.wall_clock_ms;
  const run = await appendRun(ctx.db, {
    session_id: id,
    trigger: req.trigger,
    idempotency_key: `${id}:${req.seq}`,
    wall_clock_ms: wallClockMs,
    template_id: compiled.templateId,
    prompt_path: promptPath,
    prompt_tokens_est: tokens,
    truncated_sections_json: canonicalJson(compiled.truncated),
    ...(await promptHashes(compiled)),
    mission_hash: s.mission_hash,
    doctrine_hash: s.doctrine_hash,
    toolset_hash: s.toolset_hash,
    config_hash: s.config_hash,
    model: s.model,
    effort: s.effort,
    base_sha: pinned.value.baseSha,
  });
  if (!run.ok) return refused(ctx, id, req, run.error);
  const sent = await send(ctx, id, proc, run.value, {
    promptPath,
    text: compiled.text,
    wallClockMs: req.wallClockMs ?? pinned.value.runClass.wall_clock_ms,
    within: inside,
    onEnded: req.onEnded,
    output,
  });
  return sent.ok ? run : sent;
}

function refused(
  ctx: Ctx,
  id: string,
  req: RunRequest,
  error: FrmError,
): Result<never> {
  ctx.log.error(
    { sessionId: id, seq: req.seq, error },
    `run ${req.seq} not started`,
  );
  return err(error);
}

interface Pinned {
  readonly session: SessionRow;
  readonly runClass: RunClass;
  readonly baseSha: string | null;
}

/** What a run pins besides its prompt (§8.1): the session's hashes as spawned, its base sha. */
async function pinnedInputs(
  ctx: Ctx,
  id: string,
  seq: number,
  within: SessionState,
): Promise<Result<Pinned>> {
  const session = await getSession(ctx.db, id);
  if (!session.ok) return session;
  if (session.value.state !== within) {
    return err(
      frmError(
        "conflict",
        `session ${id} is ${session.value.state}, not ${within}`,
      ),
    );
  }
  const runs = await listRuns(ctx.db, id);
  if (!runs.ok) return runs;
  const last = runs.value.at(-1)?.seq ?? 0;
  if (seq <= last) {
    return err(frmError("conflict", `session ${id} already has run ${seq}`));
  }
  if (seq !== last + 1) {
    return err(
      frmError(
        "validation",
        `run ${seq} is not next: session ${id} is at run ${last}`,
      ),
    );
  }
  const runClass = await findRunClass(ctx, session.value.run_class);
  if (!runClass.ok) return runClass;
  const worktrees = await listSessionWorktrees(ctx.db, id);
  if (!worktrees.ok) return worktrees;
  return ok({
    session: session.value,
    runClass: runClass.value,
    baseSha: worktrees.value[0]?.base_sha ?? null,
  });
}

/**
 * Edge 5 (unless the run starts inside another state), then the binding, the timer and the send;
 * a failure gives the run its terminal.
 */
async function send(
  ctx: Ctx,
  id: string,
  proc: LiveProcess,
  run: RunRow,
  p: TimerSpec & {
    readonly promptPath: string;
    readonly text: string;
    readonly output: SendSpec["output"];
  },
): Promise<Result<void>> {
  if (p.within === undefined) {
    const running = await move(ctx, id, "startRun");
    // The supervisor's own failures keep their class: only a runner's counts as a storm.
    if (!running.ok) {
      return failRun(
        ctx,
        id,
        run,
        running.error,
        p.within,
        running.error.class,
      );
    }
  }
  const opened = await ctx.ingest.openRun(id, run.id);
  if (!opened.ok) {
    return failRun(ctx, id, run, opened.error, p.within, opened.error.class);
  }
  armTimer(ctx, id, run, p);
  const sent = await proc.adapter.send(proc.handle, {
    runId: run.id,
    text: p.text,
    promptPath: p.promptPath,
    ...(p.output === undefined ? {} : { output: p.output }),
  });
  return sent.ok
    ? ok(undefined)
    : failRun(ctx, id, run, sent.error, p.within, "runner_error");
}

/**
 * Closes a run that could not start; edge 6 only for a run that moved the session. `errorClass` is
 * runner_error only when the runner refused the send; a failure of the supervisor's own step (the
 * move, ingest's openRun) keeps its class, so it never holds a pair as a retry storm.
 */
async function failRun(
  ctx: Ctx,
  id: string,
  run: RunRow,
  error: FrmError,
  within: SessionState | undefined,
  errorClass: FrmError["class"],
): Promise<Result<never>> {
  ctx.log.error(
    { sessionId: id, runId: run.id, error },
    `run ${run.seq} failed to start`,
  );
  cancelTimer(ctx, id);
  const closed = await ctx.ingest.closeRun(id, run.id, {
    outcome: "failed",
    errorClass,
    message: error.message,
  });
  if (!closed.ok)
    ctx.log.error({ sessionId: id, error: closed.error }, "closeRun");
  if (within === undefined) await move(ctx, id, "endRun");
  return err(error);
}

/** What a run's timer keeps: its wall clock, and what its end owes its caller. */
interface TimerSpec {
  readonly wallClockMs: number;
  readonly within?: SessionState | undefined;
  readonly onEnded?: ((run: RunRow) => void) | undefined;
}

function armTimer(ctx: Ctx, id: string, run: RunRow, t: TimerSpec): void {
  const cancel = new AbortController();
  patchEntry(ctx, id, {
    timer: { runId: run.id, cancel, within: t.within, onEnded: t.onEnded },
  });
  const due = run.started_at + t.wallClockMs - ctx.clock.now();
  ctx.clock.after(due, cancel.signal).then(
    () => {
      schedule(ctx, id, "run timer", () =>
        onTimeout(ctx, id, run, t.wallClockMs),
      );
    },
    () => undefined, // cancelled: the run ended, or the session stopped
  );
}

export function cancelTimer(ctx: Ctx, id: string): void {
  const timer = ctx.live.get(id)?.timer;
  if (timer === undefined) return;
  timer.cancel.abort();
  patchEntry(ctx, id, { timer: undefined });
}

/**
 * No terminal within the wall clock. The verdict goes first (a CAS on the run), so a
 * `terminal{interrupted}` cannot win it later; a conflict means the terminal won, and nothing
 * else happens. Then interrupt → wait for the terminal → stop, killing if it never came. A run
 * from idle takes the session through stopping to exited(timeout). A run inside another state
 * (RunRequest.within) tears the process down the same way but leaves the state to its caller,
 * which onEnded tells.
 */
async function onTimeout(
  ctx: Ctx,
  id: string,
  run: RunRow,
  wallClockMs: number,
): Promise<void> {
  const entry = ctx.live.get(id);
  const proc = entry?.proc;
  const timer = entry?.timer;
  if (timer?.runId !== run.id || proc === undefined) return;
  const message = `no terminal within ${wallClockMs} ms`;
  const verdict = await finishRun(ctx.db, run.id, {
    state: "timeout",
    error_class: "timeout",
    error_message: message,
  });
  if (!verdict.ok) return;
  patchEntry(ctx, id, { intent: "timeout", timer: undefined });
  if (timer.within === undefined) {
    const stopping = await move(ctx, id, "stop");
    if (!stopping.ok) {
      ctx.log.warn(
        { sessionId: id, error: stopping.error },
        "timeout: no stop",
      );
      return;
    }
  }
  await tearDown(ctx, id, run, proc);
  // After the process is gone, before the session ends.
  await runAfterExit(ctx, id, proc);
  if (timer.within === undefined) {
    await endSession(ctx, id, "exit", {
      exit_reason: "timeout",
      error_class: "timeout",
      error_message: message,
    });
  } else {
    releaseEntry(ctx, id);
  }
  await notifyEnded(ctx, id, timer.onEnded, run.id);
}

/** Interrupt → wait for the run's terminal → stop, killing if it never came; then its EOF. */
export async function tearDown(
  ctx: Ctx,
  id: string,
  run: RunRow,
  proc: LiveProcess,
): Promise<void> {
  const asked = await proc.adapter.interrupt(proc.handle);
  if (!asked.ok)
    ctx.log.warn({ sessionId: id, error: asked.error }, "interrupt");
  const grace = ctx.settings["lifecycle.interrupt_grace_ms"];
  const seen = await settlesWithin(
    ctx.ingest.terminalOf(run.id),
    ctx.clock,
    grace,
  );
  await stopProcess(ctx, proc, seen ? "graceful" : "kill");
  await proc.closed;
}

/**
 * Edge 6: a run's first terminal committed. `running` ⇔ an open run. A run started inside another
 * state (RunRequest.within) leaves the session there: its caller moves it, told by onEnded.
 */
export async function onRunEnded(
  ctx: Ctx,
  id: string,
  runId: string,
): Promise<void> {
  const timer = ctx.live.get(id)?.timer;
  const mine = timer?.runId === runId ? timer : undefined;
  if (mine !== undefined) cancelTimer(ctx, id);
  if (mine?.within === undefined) await endRunUnlessOpen(ctx, id);
  await notifyEnded(ctx, id, mine?.onEnded, runId);
  await runDeferred(ctx, id);
}

/**
 * A hand-off that waited for this run (Entry.deferredHandoff): taken once, after the
 * run's end edge, so it starts from idle rather than interrupting a turn. Cleared first, so a
 * throw inside it cannot make the next run take it again.
 */
async function runDeferred(ctx: Ctx, id: string): Promise<void> {
  const deferred = ctx.live.get(id)?.deferredHandoff;
  if (deferred === undefined) return;
  patchEntry(ctx, id, { deferredHandoff: undefined });
  await deferred();
}

async function endRunUnlessOpen(ctx: Ctx, id: string): Promise<void> {
  const open = await getOpenRun(ctx.db, id);
  if (!open.ok || open.value !== null) return;
  await move(ctx, id, "endRun"); // a conflict: stopping or ended meanwhile
}

/** Tells a run's caller that it ended (RunRequest.onEnded), with the run as stored. */
async function notifyEnded(
  ctx: Ctx,
  id: string,
  onEnded: ((run: RunRow) => void) | undefined,
  runId: string,
): Promise<void> {
  if (onEnded === undefined) return;
  const run = await getRun(ctx.db, runId);
  if (!run.ok) {
    ctx.log.error(
      { sessionId: id, runId, error: run.error },
      "onEnded: no run",
    );
    return;
  }
  try {
    onEnded(run.value);
  } catch (e) {
    ctx.log.error({ sessionId: id, runId, err: String(e) }, "onEnded threw");
  }
}

/** Gives the session's open run, if any, its supervisor terminal (Invariant 3). */
export async function closeOpenRun(
  ctx: Ctx,
  id: string,
  c: SupervisorClose,
): Promise<void> {
  const open = await getOpenRun(ctx.db, id);
  if (!open.ok) {
    ctx.log.error(
      { sessionId: id, error: open.error },
      "cannot read the open run",
    );
    return;
  }
  if (open.value === null) return;
  const closed = await ctx.ingest.closeRun(id, open.value.id, c);
  if (!closed.ok)
    ctx.log.error({ sessionId: id, error: closed.error }, "closeRun");
}
