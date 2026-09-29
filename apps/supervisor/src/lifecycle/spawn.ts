// The spawn pipeline (§9.1), on the session's queue once admission (admission.ts) has admitted it
// and holds its slot: workspace → home (with the session's MCP mount) → model pre-flight → spawn,
// then run 1: the operator's prompt through the `operator` template, or an internal spawn's own
// request (InternalSpawn). A failed step unwinds.
import { FrmError, err, ok, type Result } from "@bayon/core";
import { getSession } from "@bayon/db";
import type { Executor, Prepared } from "@bayon/executors";
import type { SpawnSpec } from "@bayon/runners";
import type { Admitted } from "./admission.js";
import { contextCompressionSpec, ensureContextStore } from "./compression.js";
import { move, orphanWorktrees, patchEntry, type Ctx } from "./context.js";
import { endSession } from "./end.js";
import { asFrmError, frmError, stopped } from "./errors.js";
import {
  applyPrepared,
  buildEnv,
  makeSessionDirs,
  redactionList,
  resolveCredentials,
} from "./home.js";
import { builtinToolsFor, mcpMount } from "./mcp.js";
import { modelSettingsOf } from "./model-settings.js";
import { preflightStep } from "./preflight.js";
import { attachProcess, stopProcess } from "./process.js";
import type { RunRequest } from "./prompt.js";
import {
  prepareRemoteWorkspace,
  type RemoteCheckout,
} from "./remote-workspace.js";
import type { Resolved } from "./resolve.js";
import { startRun } from "./run.js";
import { stopOp } from "./stop.js";
import { writeFreshPacket } from "./successor.js";
import {
  doctrineHash,
  prepareWorkspace,
  withHashInputs,
  type Workspace,
} from "./workspace.js";

/** Run 1 of a spawn. */
export interface FirstRun {
  readonly run: RunRequest;
  /** Epoch ms (InternalSpawn.deadline): run 1's wall clock ends by it. */
  readonly deadline?: number;
  /** An internal spawn: nobody drives the session, so a refused run 1 ends it instead of idling. */
  readonly internal?: boolean;
}

export async function runPipeline(
  ctx: Ctx,
  r: Admitted,
  first: FirstRun | undefined,
): Promise<void> {
  const entry = ctx.live.get(r.sessionId);
  if (entry === undefined) return;
  const { signal } = entry.abort;
  const spawned = await spawnSteps(ctx, r, signal, first?.run.output);
  if (!spawned.ok) return unwind(ctx, r.sessionId, spawned.error);
  if (first === undefined || signal.aborted) return;
  const wallClockMs =
    first.deadline === undefined
      ? first.run.wallClockMs
      : Math.min(
          first.run.wallClockMs ?? r.runClass.wall_clock_ms,
          first.deadline - ctx.clock.now(),
        );
  // A refusal is logged there and leaves an operator's session idle, as any run that never opened.
  // Run 1 is the admitted spawn's own: `first`, never held to mayStartTurn.
  const started =
    wallClockMs !== undefined && wallClockMs <= 0
      ? err(frmError("timeout", "the deadline passed before run 1"))
      : await startRun(ctx, r.sessionId, {
          ...first.run,
          turn: "first",
          ...(wallClockMs === undefined ? {} : { wallClockMs }),
        });
  if (!started.ok && first.internal === true) {
    await stopOp(ctx, r.sessionId, "kill");
  }
}

/** The session's place on its executor: its workspace, and what `prepare` said of it. */
interface Placed {
  readonly ws: Workspace;
  readonly prepared: Prepared;
}

/**
 * Steps 2–4. The drain admitted it (edge 2) and holds its slot: the pipeline owns an abort now.
 * `output` is run 1's structured-output schema, which the spec carries (SpawnSpec.output).
 */
async function spawnSteps(
  ctx: Ctx,
  r: Admitted,
  signal: AbortSignal,
  output: RunRequest["output"],
): Promise<Result<void>> {
  if (signal.aborted) return err(stopped());
  const ex = ctx.executors.get(r.executorId);
  if (ex === undefined) {
    return err(
      frmError("spawn_failed", `executor ${r.executorId} is not loaded`),
    );
  }
  const placed = await workspaceStep(ctx, r, ex.executor, signal);
  if (!placed.ok) return placed;
  const spec = await homeStep(ctx, r, ex.executor, placed.value, output);
  if (!spec.ok) return spec;
  const served = await preflightStep(
    {
      log: ctx.log,
      sessionId: r.sessionId,
      adapter: r.adapter,
      executorKind: ex.executor.kind,
      clock: ctx.clock,
      signal,
    },
    spec.value,
  );
  if (!served.ok) return served;
  if (signal.aborted) return err(stopped());
  const spawning = await move(ctx, r.sessionId, "prepare");
  if (!spawning.ok) return spawning;
  return spawnStep(ctx, r, ex.executor, spec.value, placed.value.ws, signal);
}

/** Step 2: the executor's place for the session, then its workspace there (§9.2). */
async function workspaceStep(
  ctx: Ctx,
  r: Resolved,
  executor: Executor,
  signal: AbortSignal,
): Promise<Result<Placed>> {
  let prepared: Prepared;
  try {
    prepared = await executor.prepare({
      sessionId: r.sessionId,
      root: r.paths.root,
    });
  } catch (e) {
    return err(asFrmError(e, "spawn_failed", `cannot prepare ${r.paths.root}`));
  }
  // An executor that places sessions itself (a container) gets a clone of its own;
  // a gate's reviewer, a detached one at its pinned head, kept alive as refs/frm/gate/<id>.
  const ws = r.paths.remote
    ? await prepareRemoteWorkspace(ctx, r, executor, signal, remoteCheckout(r))
    : await prepareWorkspace(ctx, r, executor, signal);
  if (!ws.ok) return ws;
  // A successor placed afresh gets its packet in its new worktree.
  if (r.successor !== null && r.successor.worktree === null) {
    await writeFreshPacket(
      ctx,
      r.sessionId,
      r.successor,
      executor,
      ws.value.cwd,
    );
  }
  return ok({ ws: ws.value, prepared });
}

/** A session's own branch, or a pinned commit (M3-h), as the remote workspace step takes it. */
function remoteCheckout(r: Resolved): RemoteCheckout {
  if (r.at === null) return { kind: "branch" };
  return {
    kind: "detached",
    sha: r.at.sha,
    baseSha: r.at.baseSha,
    ref:
      r.gate === null
        ? `refs/frm/pin/${r.sessionId}`
        : `refs/frm/gate/${r.gate.id}`,
  };
}

/**
 * Step 3 (§11.3): the private home, the complete env, the adapter's files. Run 1's output schema
 * goes in the spec as well as in its send: a runner may fix its schema when its process starts.
 */
async function homeStep(
  ctx: Ctx,
  r: Admitted,
  executor: Executor,
  { ws, prepared }: Placed,
  output: RunRequest["output"],
): Promise<Result<SpawnSpec>> {
  const dirs = await makeSessionDirs(r.paths);
  if (!dirs.ok) return dirs;
  // The secrets, and the operator's own login for this runner when they consented to its use in
  // place (§14). No consent, no read: the default is a grant of nothing.
  const credentials = await resolveCredentials(ctx, r.runner.id, r.config);
  if (!credentials.ok) return credentials;
  const { granted } = credentials.value;
  const env = buildEnv(ctx, r.sessionId, r.config, r.paths, credentials.value);
  const settings = modelSettingsOf(r.model);
  if (!settings.ok) return settings;
  // The /mcp URL and egress proxy as the executor's programs reach them (a container's gateway).
  const spec = applyPrepared(
    {
      sessionId: r.sessionId,
      cwd: ws.cwd,
      ...(ws.extraRoots.length > 0 ? { extraRoots: ws.extraRoots } : {}),
      homeDir: r.paths.home,
      env,
      model: r.model.model,
      ...(r.model.effort === null ? {} : { effort: r.model.effort }),
      ...settings.value,
      flags: r.config.flags,
      ...mcpMount(ctx.mcpUrl, r.mcpToken, r.toolset),
      ...builtinToolsFor(r.payload.role),
      ...(granted === undefined ? {} : { grantedLogin: granted }),
      ...(output === undefined ? {} : { output: { schema: output.schema } }),
      // Its model calls through the context proxy (spec M12), with a bearer minted for this spec.
      ...(r.compression ? contextCompressionSpec(r.paths.root) : {}),
    },
    prepared,
  );
  // Its store of originals exists before the runner is granted it; a link in its place refuses.
  if (spec.contextCompression !== undefined) {
    const store = await ensureContextStore(spec.contextCompression.storeDir);
    if (!store.ok) return store;
  }
  const home = await r.adapter.prepareHome(spec, executor);
  return home.ok ? ok(spec) : home;
}

/** Step 4. Edge 4 commits raw_segment_offset, and the hashes every run pins, before ingest reads
 * the first record. */
async function spawnStep(
  ctx: Ctx,
  r: Resolved,
  executor: Executor,
  spec: SpawnSpec,
  ws: Workspace,
  signal: AbortSignal,
): Promise<Result<void>> {
  const id = r.sessionId;
  const seg = await ctx.ingest.beginSegment(id);
  if (!seg.ok) return seg;
  const spawned = await r.adapter.spawn(spec, executor);
  if (!spawned.ok) return spawned;
  const handle = spawned.value;
  // Tracked before anything can fail: an unwind's stop awaits its exit (escape 2).
  ctx.candidates.track(id, executor, handle);
  patchEntry(ctx, id, {
    proc: { handle, adapter: r.adapter, executor, closed: handle.exited },
  });
  if (r.adapter.caps().resumable && handle.runnerSessionId === undefined) {
    return err(
      frmError(
        "spawn_failed",
        "a resumable runner returned no runner session id",
      ),
    );
  }
  if (signal.aborted) return err(stopped());
  const doctrine = await doctrineHash(withHashInputs(ws, r.config.hashInputs));
  if (!doctrine.ok) return doctrine;
  const idle = await move(ctx, id, "spawn", {
    executor_ref: handle.executorRef,
    runner_session_id: handle.runnerSessionId ?? null,
    runner_version: await runnerVersion(ctx, r),
    raw_segment_offset: seg.value.offset,
    started_at: ctx.clock.now(),
    doctrine_hash: doctrine.value,
    toolset_hash: r.toolset.hash,
  });
  if (!idle.ok) return idle;
  const attached = attachProcess(
    ctx,
    id,
    { handle, adapter: r.adapter, executor },
    seg.value.offset,
    redactionList(spec, r.config),
  );
  return attached.ok ? ok(undefined) : attached;
}

async function runnerVersion(ctx: Ctx, r: Resolved): Promise<string | null> {
  try {
    return await r.adapter.version();
  } catch (e) {
    ctx.log.warn(
      { sessionId: r.sessionId, err: String(e) },
      "no runner version",
    );
    return null;
  }
}

/**
 * Edge 12: kill a spawned process, orphan the worktree (never delete it), release the slot. Past
 * edge 4 (attaching to ingest failed) the session is idle, so it is edge 11.
 */
async function unwind(ctx: Ctx, id: string, failed: FrmError): Promise<void> {
  const entry = ctx.live.get(id);
  // An abort that carries an FrmError (InternalSpawn's deadline) is the reason, not "stopped".
  const reason = FrmError.safeParse(entry?.abort.signal.reason);
  const error =
    entry?.abort.signal.aborted === true && reason.success
      ? reason.data
      : failed;
  if (entry?.proc !== undefined) await stopProcess(ctx, entry.proc, "kill");
  await orphanWorktrees(ctx, id);
  const byStop = entry?.intent !== undefined;
  if (!byStop) ctx.log.warn({ sessionId: id, error }, "spawn failed");
  const s = await getSession(ctx.db, id);
  await endSession(
    ctx,
    id,
    s.ok && s.value.state === "idle" ? "die" : "abort",
    byStop
      ? { exit_reason: "killed", error_message: "stopped during spawn" }
      : {
          exit_reason: "error",
          error_class: error.class,
          error_message: error.message,
        },
  );
}
