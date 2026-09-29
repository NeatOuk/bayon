// Reconciler v0 (§9.6 steps 1–3, 5, 7; amendments 2 and 3). At boot, before the claimer starts,
// then reconciler.interval_ms after each pass ends. It acts on dead entries and unowned sessions.
import {
  PULSE_RUN_CLASS,
  err,
  hashConfig,
  ok,
  type ErrorClass,
  type FrmError,
  type Result,
} from "@bayon/core";
import {
  findLiveByRunnerSessionId,
  getAgent,
  getProfile,
  getRunner,
  getRunnerModel,
  getSession,
  listSessionsInStates,
  listSessionWorktrees,
  type SessionRow,
} from "@bayon/db";
import {
  releaseExpiredLeases,
  releaseExpiredPulseLeases,
  setSessionTokenHash,
} from "@bayon/db/supervisor";
import {
  expireAttachLeases,
  reapOrphanTmuxSockets,
  reconcileOrphanedAttaches,
} from "./attach.js";
import { sweepAttachIntents } from "./attach-intent.js";
import type { Executor, Prepared, ProbeState, Slot } from "@bayon/executors";
import type { RunnerAdapter, SpawnSpec } from "@bayon/runners";
import {
  isIn,
  move,
  orphanWorktrees,
  patchEntry,
  PROCESS_STATES,
  SPAWN_STATES,
  type Ctx,
} from "./context.js";
import { sweepStranded } from "./degraded.js";
import { pastWallClock } from "./downtime.js";
import {
  enqueueReadmissions,
  prepareReadmit,
  type ReadyReadmission,
} from "./readmit.js";
import { endSession } from "./end.js";
import { asFrmError, frmError } from "./errors.js";
import { checkAllHealth } from "./health.js";
import {
  applyPrepared,
  buildEnv,
  redactionList,
  resolveCredentials,
} from "./home.js";
import {
  adoptRuleset,
  contextCompressionSpec,
  ensureContextStore,
} from "./compression.js";
import { builtinToolsFor, mcpMount, mintToken, sessionToolset } from "./mcp.js";
import { sessionPathsOn } from "./paths.js";
import { awaitSessionOp, type PassPhase } from "./pass-wait.js";
import {
  attachProcess,
  closeFor,
  closeForRestart,
  deadEntry,
} from "./process.js";
import { modelSettingsOf } from "./model-settings.js";
import { parseConfig } from "./profile.js";
import { sweepCiGates } from "../delivery/ci-checks.js";
import { sweepPullRequests } from "../delivery/pull-requests.js";
import { sweepDeliveries } from "../delivery/sweep.js";
import { sweepMachineSteps } from "./machine-sweep.js";
import { sweepMirrorPins } from "./mirror-pins.js";
import { sweepPhaseBoundaries } from "./phase-boundary.js";
import {
  clearStragglers,
  reapOrphans,
  takeSnapshot,
  type Snapshot,
} from "./reaper.js";
import { sessionRoots } from "./roots.js";
import { closeOpenRun } from "./run.js";
import { requestStop } from "./stop.js";

/** How often an orphan killed at boot is re-probed, within lifecycle.kill_grace_ms. */
const PROBE_EVERY_MS = 100;

export type { PassPhase } from "./pass-wait.js";

/** §9.6 step 6's command half, at runtime: boot's requeue is startClaiming's. */
async function requeueStale(ctx: Ctx): Promise<void> {
  if (ctx.commands === undefined) return;
  const olderThan = ctx.settings["reconciler.command_requeue_ms"];
  const out = await ctx.commands.requeue({
    claimedBefore: ctx.clock.now() - olderThan,
    maxAttempts: ctx.settings["reconciler.command_max_attempts"],
    why: `claimed for more than ${olderThan} ms without completing`,
  });
  if (!out.ok) {
    ctx.log.error({ error: out.error }, "cannot requeue claimed commands");
  }
}

export async function reconcilePass(
  ctx: Ctx,
  phase: PassPhase = "periodic",
): Promise<void> {
  // Step 0: what each executor holds, listed once for the whole pass.
  const snapshot = await takeSnapshot(ctx);
  // Before step 1: a process whose stream ended and whose exit no op took is dead here.
  if (phase === "periodic") noticeMissedExits(ctx);
  await reconcileSessions(ctx, snapshot, phase);
  // Rows sealed but never finalized: a crash came between the two.
  await sweepStranded(ctx);
  // §7.1 row four, re-derived: the transition's `session.handoff` is the fast path and
  // not the record — a boundary deferred to an open run lives only in ctx.live, so a restart drops
  // it and the ticket is held for ever. Asked again here, after the adopts above, every pass.
  await sweepPhaseBoundaries(ctx);
  // The machine steps no gate decision is coming to take: a waived last gate, a ticket
  // unblocked back into review, a restart between a decision and its step. Writes nothing when no
  // edge applies.
  await sweepMachineSteps(ctx);
  // Every pass (§12.5, Invariant 12): a human_attached row whose tmux session is gone is
  // detached now rather than sitting unwatched for up to lifecycle.attach_lease_ms. At boot such a
  // row predates this supervisor; on a periodic pass the CLI died under a supervisor that kept
  // running — the same dead row either way, and the TTL is far too slow to be the only answer.
  await reconcileOrphanedAttaches(ctx, phase);
  // Boot only, and deliberately: this one reaps by listing $FRM_HOME/s, and an attach creates its
  // socket before the row that claims it (attachOp). At boot no attach can be in flight; on a
  // periodic pass that listing would race one and kill a tmux server a live attach just started.
  if (phase === "boot") await reapOrphanTmuxSockets(ctx);
  // Pending "take over after this step" asks the in-memory path cannot see: an adopt
  // replaced the entry, or a restart ended the run. After the adopts, and after the reap above —
  // an attach makes its tmux socket before the row that claims it, and the reap kills unclaimed ones.
  await sweepAttachIntents(ctx);
  // Before releaseExpiredLeases' blind column clear, so a full detach (tmux kill, re-adopt, hand
  // off) still sees the lease it needs to act on (§12.5).
  await expireAttachLeases(ctx);
  const released = await releaseExpiredLeases(ctx.db);
  if (!released.ok)
    ctx.log.error({ error: released.error }, "cannot release leases");
  await expirePulseLeases(ctx);
  await checkAllHealth(ctx);
  // Health and capacity may have changed: `unhealthy`, `disk` and `slot` waiters get a pass.
  ctx.admission.wake();
  // Our orphans (labelled containers of ended sessions, tagged
  // processes of sessions without an entry here. Never a prune, never anything that matches less.
  await reapOrphans(ctx, snapshot, phase);
  // Pin refs in executors' mirrors whose gate or session is finished.
  await sweepMirrorPins(ctx);
  if (phase === "periodic") await requeueStale(ctx);
  // Step 8: the watchdog's periodic rules, after health; its stuck rule has its own
  // timer. It waits only on its own queue.
  if (ctx.watchdog !== undefined) await ctx.watchdog.tick();
  // Last (and deliberately last): the work a project asked to have delivered. Each
  // ticket that has reached its project's moment gets its branches pushed to that project's own
  // recorded remote, and — in `pull_request` mode — a request per branch. This is the only step of
  // a pass that calls out to a network, so it runs after health, the leases and the watchdog, and
  // it keeps to a wall-clock budget: a slow remote delays nothing but the next delivery. A finished
  // delivery is a no-op, and `delivery_mode = 'none'` — every project until an operator says
  // otherwise — makes the candidate query return nothing at all.
  await sweepDeliveries(ctx);
  // Right after it: each pull request a delivery opened is read from its forge, and a
  // merge or a close recorded — the last merge closing the ticket in the same transaction. Its own
  // page, cursor and budget, so a slow forge delays nothing but the next poll.
  await sweepPullRequests(ctx);
  // Then the QA gates a project's CI answers: each running CI gate reads the checks on
  // its pull request at the reviewed commit, and a pass, a failed check, or a CI that never came is
  // decided through decideGate — the machine step in the same transaction. After the pull-request
  // sweep, so a merge recorded this pass has already superseded a gate it would otherwise read.
  await sweepCiGates(ctx);
}

/** No op of this process ever owned it: its process predates this supervisor. */
const restarted = (ctx: Ctx, id: string): boolean => !ctx.owned.has(id);

/**
 * A live entry whose process's stream ended longer ago than its exit op may take (two kill graces
 * and an interrupt grace: onProcessGone's bounded waits and its hook's) while no op marked it dead:
 * the exit op never ran, or something ahead of it holds the session's queue. Marked dead
 * here, as onProcessGone does first, so step 1 adopts or ends it this pass. A stop or timer op owns
 * its own exits (an intent), and so does a takeover.
 */
function noticeMissedExits(ctx: Ctx): void {
  const allowed =
    2 * ctx.settings["lifecycle.kill_grace_ms"] +
    ctx.settings["lifecycle.interrupt_grace_ms"];
  for (const [id, entry] of ctx.live) {
    const eofAt = entry.proc?.eofAt?.() ?? null;
    if (entry.dead || entry.intent !== undefined || eofAt === null) continue;
    if (ctx.clock.now() - eofAt <= allowed) continue;
    entry.timer?.cancel.abort();
    // Its process rides along: the exit op still queued for it finishes the teardown (M1).
    ctx.live.set(id, deadEntry(entry, entry.proc));
    ctx.log.warn(
      { sessionId: id, eofAt },
      "its stream ended but no exit op took it: marked dead for this pass",
    );
  }
}

/** Step 1: every session not ended, each on its queue, concurrently. */
async function reconcileSessions(
  ctx: Ctx,
  snapshot: Snapshot,
  phase: PassPhase,
): Promise<void> {
  const sessions = await listSessionsInStates(ctx.db, [
    ...SPAWN_STATES,
    ...PROCESS_STATES,
  ]);
  if (!sessions.ok) {
    ctx.log.error(
      { error: sessions.error },
      "reconciler: cannot list sessions",
    );
  } else {
    // Step 1b's waiters, prepared on each session's queue, enqueued once every op has settled; one
    // prepared after a periodic pass stopped waiting on its queue is enqueued on its own.
    const prepared: ReadyReadmission[] = [];
    let flushed = false;
    const ready = (r: ReadyReadmission): void => {
      if (flushed) enqueueReadmissions(ctx, [r]);
      else prepared.push(r);
    };
    // A live, non-dead entry is ours and alive: reconcileOne returns at once for it, so its queue,
    // which a stuck tearDown may hold, is never waited on.
    const unowned = sessions.value.filter((s) => {
      const entry = ctx.live.get(s.id);
      return entry === undefined || entry.dead;
    });
    await Promise.all(
      unowned.map((s) =>
        awaitSessionOp(
          ctx,
          s.id,
          ctx.queue.run(s.id, () => reconcileOne(ctx, s.id, snapshot, ready)),
          phase,
          "reconcile",
        ),
      ),
    );
    // In (created_at, id) order, adopted sessions' slots already restored (MEDIUM-1).
    flushed = true;
    enqueueReadmissions(ctx, prepared);
  }
}

/**
 * §9.6 step 5 for pulses, the backstop: the pulse deadline normally ends a
 * pulse before its lease does. An expired lease ends its pulse, and its session is stopped, killed,
 * whether it is still spawning or has a process (review C1). No renewal.
 */
async function expirePulseLeases(ctx: Ctx): Promise<void> {
  const expired = await releaseExpiredPulseLeases(ctx.db);
  if (!expired.ok) {
    ctx.log.error({ error: expired.error }, "cannot release pulse leases");
    return;
  }
  for (const p of expired.value) {
    ctx.log.warn(
      { pulseId: p.id, agentId: p.agent_id, sessionId: p.session_id },
      "pulse lease expired",
    );
    if (p.session_id === null) continue;
    const sessionId = p.session_id;
    requestStop(ctx, sessionId, "kill").catch((e: unknown) => {
      ctx.log.error(
        { sessionId, err: String(e) },
        "cannot stop an expired pulse's session",
      );
    });
  }
}

async function reconcileOne(
  ctx: Ctx,
  id: string,
  snapshot: Snapshot,
  ready: (r: ReadyReadmission) => void,
): Promise<void> {
  const found = await getSession(ctx.db, id);
  if (!found.ok) return;
  const s = found.value;
  const entry = ctx.live.get(id);
  if (entry !== undefined && !entry.dead) return; // ours, and alive
  // A stop is queued for it (requestStop set the intent first): stopOp ends it exited(killed),
  // never an adopt-then-stop.
  if (entry?.intent !== undefined) return;
  // A pending session with no entry here: the supervisor restarted while it waited (§6).
  if (s.state === "pending") return readmitOrAbandon(ctx, s, ready);
  if (isIn(SPAWN_STATES, s.state)) return abandonSpawn(ctx, s);
  if (!isIn(PROCESS_STATES, s.state)) return;
  if (entry === undefined && !(await reapOrphan(ctx, s))) return;
  const adapter = ctx.adapters.get(s.runner_id);
  if (adapter === undefined) {
    return markDead(
      ctx,
      s,
      frmError("validation", `no adapter for runner ${s.runner_id}`),
    );
  }
  const replayed = await ctx.ingest.replay(id, adapter);
  if (!replayed.ok) {
    // The dead process's uncommitted tail is replayable only while the segment is its own: an
    // adopt moves raw_segment_offset past it, and an end stops replay for good. A
    // session a replay keeps failing on stays visible as stale_session.
    ctx.log.error(
      { sessionId: id, error: replayed.error },
      "replay failed: the session waits for the next pass",
    );
    return;
  }
  if (s.state === "stopping") {
    await closeOpenRun(ctx, id, closeFor("kill"));
    return endSession(ctx, id, "reap", { exit_reason: "killed" });
  }
  // Never resumed: adoptable/startAdopted would spawn a process ahead of the adopt edge. The
  // death is the seal, and its `writing` row is finalized degraded (HIGH 2).
  if (s.state === "handoff_writing") {
    return markDead(
      ctx,
      s,
      frmError(
        "runner_exited_without_terminal",
        "its process died while it wrote its hand-off",
      ),
    );
  }
  // A pulse's session is one run, never resumed: its pulse settles on the end.
  if (s.run_class === PULSE_RUN_CLASS) {
    return markDead(
      ctx,
      s,
      frmError("interrupted", "a pulse session is never adopted"),
    );
  }
  // Nor is a gate's reviewer: its gate is decided
  // supervisor_restart and retried under a fresh session; an orphan was reaped above.
  if (s.gate_id !== null) {
    return markDead(
      ctx,
      s,
      frmError("interrupted", "a reviewer session is never adopted"),
    );
  }
  // A run past the wall clock it pinned while nobody watched: the live path's
  // verdict, exited(timeout) with a degraded hand-off, never an adopt.
  const late = await pastWallClock(ctx, s);
  if (late !== null) {
    const restart = restarted(ctx, id);
    const message = `no terminal within ${late} ms; the supervisor was down`;
    await closeOpenRun(
      ctx,
      id,
      restart
        ? closeForRestart(message, "timeout")
        : { outcome: "timeout", errorClass: "timeout", message },
    );
    return endSession(ctx, id, "die", {
      exit_reason: "timeout",
      error_class: restart ? "supervisor_restart" : "timeout",
      error_message: `its run passed its ${late} ms wall clock while the supervisor was down`,
    });
  }
  const adoption = await adoptable(ctx, s, adapter);
  if (!adoption.ok) return markDead(ctx, s, adoption.error);
  // Nothing of the old process may run beside the adopted one (Invariant 12).
  if (!(await clearStragglers(ctx, s, snapshot))) return;
  await closeOpenRun(ctx, id, {
    outcome: "interrupted",
    errorClass: "interrupted",
    message: "its process died; adopted via resume",
  });
  return adopt(ctx, s, adapter, adoption.value, entry?.slot);
}

/**
 * No ref was recorded yet, and pipe-bound processes die with the old supervisor. restartAbort is
 * hooked: a holding session leaves its degraded hand-off; the worktree is kept.
 * A session that was queued keeps its queued_reason on the ended row, on purpose: why it never
 * started.
 */
async function abandonSpawn(
  ctx: Ctx,
  s: SessionRow,
  why?: { readonly errorClass: ErrorClass; readonly message: string },
): Promise<void> {
  await orphanWorktrees(ctx, s.id);
  // Ours, yet with no entry: its spawn ended under this supervisor without its entry (end.ts
  // drops one on a failed edge). That is a failure the breaker counts, not a restart.
  if (!restarted(ctx, s.id)) {
    await endSession(ctx, s.id, "restartAbort", {
      exit_reason: "error",
      error_class: "spawn_failed",
      error_message: "its spawn ended without its entry under this supervisor",
    });
    return;
  }
  await endSession(ctx, s.id, "restartAbort", {
    exit_reason: "error",
    error_class: "supervisor_restart",
    error_message:
      why?.message ??
      (s.queued_reason === null
        ? "the supervisor restarted during spawn"
        : `the supervisor restarted while queued (${s.queued_reason})`),
  });
}

/**
 * A pending session after a restart: its waiter prepared for step 1b, or,
 * when it cannot be re-admitted, ended through restartAbort with the reason.
 */
async function readmitOrAbandon(
  ctx: Ctx,
  s: SessionRow,
  ready: (r: ReadyReadmission) => void,
): Promise<void> {
  const r = await prepareReadmit(ctx, s);
  if (r.kind === "readmit") {
    ready(r);
    return;
  }
  await abandonSpawn(
    ctx,
    s,
    r.why === null ? undefined : { errorClass: r.errorClass, message: r.why },
  );
}

/**
 * An unowned process: its pipe died with the old supervisor (no reattach in M0), so kill it and
 * adopt once it probes dead. True when dead; false to retry on the next pass.
 */
async function reapOrphan(ctx: Ctx, s: SessionRow): Promise<boolean> {
  const executor = ctx.executors.get(s.executor_id)?.executor;
  const ref = s.executor_ref;
  if (executor === undefined || ref === null) return true;
  const state = await probe(ctx, executor, ref);
  if (state !== "alive") return state === "dead";
  ctx.log.warn(
    { sessionId: s.id, ref },
    "alive but unowned: killing it before adopting",
  );
  try {
    await executor.cleanup(ref, "hard");
  } catch (e) {
    ctx.log.error({ sessionId: s.id, err: String(e) }, "cleanup failed");
    return false;
  }
  const deadline = ctx.clock.now() + ctx.settings["lifecycle.kill_grace_ms"];
  for (;;) {
    if ((await probe(ctx, executor, ref)) === "dead") return true;
    if (ctx.clock.now() >= deadline) break;
    await ctx.clock.after(PROBE_EVERY_MS);
  }
  ctx.log.warn(
    { sessionId: s.id, ref },
    "still alive after SIGKILL: next pass",
  );
  return false;
}

async function probe(
  ctx: Ctx,
  executor: Executor,
  ref: string,
): Promise<ProbeState | "unknown"> {
  try {
    return await executor.probe(ref);
  } catch (e) {
    ctx.log.error({ ref, err: String(e) }, "probe failed");
    return "unknown";
  }
}

/** Edge 11. */
async function markDead(
  ctx: Ctx,
  s: SessionRow,
  error: FrmError,
): Promise<void> {
  // Computed here, at the call: an adopt that attached this process moved it into `owned`.
  const restart = restarted(ctx, s.id);
  await closeOpenRun(
    ctx,
    s.id,
    restart
      ? closeForRestart(
          `its process predates this supervisor: ${error.message}`,
        )
      : closeFor(undefined),
  );
  await endSession(ctx, s.id, "die", {
    exit_reason: "error",
    error_class: restart ? "supervisor_restart" : error.class,
    error_message: error.message,
  });
}

/** Resumable, its runner session id held by no other live session, under adopt_max, same config. */
/**
 * Whether `s` can be adopted (a fresh automated process resumed from its `runner_session_id`), and
 * what to start it with. Exported for attach.ts's detach path (§12.5): after an interactive
 * takeover ends, detach runs this same adopt pipeline to bring up a fresh automated process before
 * requesting the hand-off note (`requestHandoff` needs a live `LiveProcess` to act on).
 */
export async function adoptable(
  ctx: Ctx,
  s: SessionRow,
  adapter: RunnerAdapter,
): Promise<Result<Adoption>> {
  const rsid = s.runner_session_id;
  if (!adapter.caps().resumable || rsid === null) {
    return err(
      frmError(
        "runner_exited_without_terminal",
        "the runner died and cannot resume",
      ),
    );
  }
  const holders = await findLiveByRunnerSessionId(ctx.db, rsid);
  if (!holders.ok) return holders;
  if (holders.value.some((h) => h.id !== s.id)) {
    return err(
      frmError(
        "conflict",
        `runner session ${rsid} has another live session (Invariant 12)`,
      ),
    );
  }
  const adopts = ctx.adopts.get(s.id) ?? 0;
  if (adopts >= ctx.settings["lifecycle.adopt_max"]) {
    return err(
      frmError(
        "runner_error",
        `adopted ${adopts} times by this supervisor; giving up`,
      ),
    );
  }
  return adoptSpec(ctx, s, rsid, adapter);
}

/** What an adopt starts: the spec, the freshly minted token's hash, and what ingest redacts. */
export interface Adoption {
  readonly spec: SpawnSpec;
  readonly tokenHash: string;
  readonly redact: readonly string[];
  /** The context ruleset it resumes on (its pin, or this build's for a stale pin); null: off. */
  readonly contextRuleset: string | null;
}

/**
 * The SpawnSpec to resume with: the session's own model and effort, not today's active model, and a
 * fresh MCP token. config_hash pins the allowlist, so the tool set is the
 * spawn's; a catalogue changed since then fails the adopt rather than serve other tools. Its context
 * compression is its pin (D12), never its project's switch now: a session spawned
 * compressed resumes compressed, with a fresh bearer and the same store, so its re-sent history
 * names the same originals; one spawned without resumes without.
 */
async function adoptSpec(
  ctx: Ctx,
  s: SessionRow,
  rsid: string,
  adapter: RunnerAdapter,
): Promise<Result<Adoption>> {
  const agent = await getAgent(ctx.db, s.agent_id);
  if (!agent.ok) return agent;
  if (agent.value.profile_id === null) {
    return err(frmError("validation", `agent ${s.agent_id} has no profile`));
  }
  const profile = await getProfile(ctx.db, agent.value.profile_id);
  if (!profile.ok) return profile;
  const runner = await getRunner(ctx.db, s.runner_id);
  if (!runner.ok) return runner;
  const config = parseConfig(profile.value, runner.value, s.role);
  if (!config.ok) return config;
  if ((await hashConfig(config.value.input)) !== s.config_hash) {
    // Two causes, and the adopt is wrong for both: the profile changed since the spawn, or the
    // spawn added environment of its own (InternalSpawn.env) that a profile cannot
    // reproduce. Resuming from the profile alone would silently drop that env and run the child
    // against something other than what it was spawned for — the case this check exists to catch.
    return err(
      frmError(
        "validation",
        "config_hash differs from the profile's: the profile changed since spawn, or the spawn added environment of its own that an adopt cannot rebuild",
      ),
    );
  }
  const worktrees = await listSessionWorktrees(ctx.db, s.id);
  if (!worktrees.ok) return worktrees;
  const roots = await sessionRoots(ctx, s, worktrees.value); // cwd by role
  if (!roots.ok) return roots;
  // An adopt reads the grant again rather than remembering it: consent revoked while the process
  // was dead must not be resumed into, and the operator's file has rotated since the spawn (§14).
  const credentials = await resolveCredentials(ctx, s.runner_id, config.value);
  if (!credentials.ok) return credentials;
  const { granted } = credentials.value;
  // Its own place: its executor's root, home, tmp and PATH for a container.
  const env = buildEnv(
    ctx,
    s.id,
    config.value,
    sessionPathsOn(
      ctx.frmHome,
      s.id,
      ctx.executors.get(s.executor_id)?.executor,
    ),
    credentials.value,
  );
  const toolset = await sessionToolset(s.role, config.value, adapter);
  if (!toolset.ok) return toolset;
  if (s.toolset_hash !== null && toolset.value.hash !== s.toolset_hash) {
    return err(
      frmError(
        "validation",
        "the tool catalogue changed since spawn: toolset_hash differs",
      ),
    );
  }
  // The row of the session's model, for its adapter settings: read again, like the
  // grant, so an adopt runs on the URL the operator set.
  const modelRow =
    s.model === null
      ? ok(null)
      : await getRunnerModel(ctx.db, s.runner_id, s.model);
  if (!modelRow.ok) return modelRow;
  const settings =
    modelRow.value === null ? ok({}) : modelSettingsOf(modelRow.value);
  if (!settings.ok) return settings;
  const token = await mintToken();
  const compression = adoptRuleset(s.context_ruleset);
  if (compression.changed) {
    ctx.log.warn(
      {
        sessionId: s.id,
        pinned: s.context_ruleset,
        ruleset: compression.ruleset,
      },
      "adopt: this build does not have the session's context ruleset; it resumes on the current one",
    );
  }
  const spec: SpawnSpec = {
    sessionId: s.id,
    ...roots.value,
    homeDir: s.home_dir,
    env,
    model: s.model ?? "",
    ...(s.effort === null ? {} : { effort: s.effort }),
    ...settings.value,
    resumeRunnerSessionId: rsid,
    flags: config.value.flags,
    ...mcpMount(ctx.mcpUrl, token, toolset.value),
    ...builtinToolsFor(s.role),
    ...(granted === undefined ? {} : { grantedLogin: granted }),
    ...(compression.ruleset === null
      ? {}
      : contextCompressionSpec(s.session_root, compression.ruleset)),
  };
  return ok({
    spec,
    tokenHash: token.hash,
    redact: redactionList(spec, config.value),
    contextRuleset: compression.ruleset,
  });
}

/** Edge 10. A dead entry's slot is reused; only an unowned adopt restores one. */
async function adopt(
  ctx: Ctx,
  s: SessionRow,
  adapter: RunnerAdapter,
  adoption: Adoption,
  held: Slot | undefined,
): Promise<void> {
  if (
    adoption.spec.mcp !== undefined &&
    !(await ctx.mcpReachable(ctx.mcpUrl))
  ) {
    // The resumed CLI would connect once and keep its tools dead (F4): try on the next pass.
    ctx.log.warn(
      { sessionId: s.id, url: ctx.mcpUrl },
      "MCP server unreachable: the adopt waits for the next pass",
    );
    return;
  }
  const ex = ctx.executors.get(s.executor_id);
  if (ex === undefined) {
    return markDead(
      ctx,
      s,
      frmError("validation", `executor ${s.executor_id} is not loaded`),
    );
  }
  ctx.adopts.set(s.id, (ctx.adopts.get(s.id) ?? 0) + 1);
  const slot = held ?? ex.slots.restore(1)[0];
  ctx.live.set(s.id, {
    abort: new AbortController(),
    dead: true,
    ...(slot === undefined ? {} : { slot }),
  });
  const started = await startAdopted(ctx, s, adapter, ex.executor, adoption);
  if (!started.ok) return markDead(ctx, s, started.error);
  ctx.log.info({ sessionId: s.id, ref: started.value }, "adopted via resume");
}

/** Runs `adoption` on `s`: prepares its place, calls `adapter.adopt`, attaches the process, fires
 * edge 10. Exported for attach.ts's detach path (§12.5) — see `adoptable`'s doc comment. */
export async function startAdopted(
  ctx: Ctx,
  s: SessionRow,
  adapter: RunnerAdapter,
  executor: Executor,
  { spec, tokenHash, redact, contextRuleset }: Adoption,
): Promise<Result<string>> {
  // The executor re-establishes the session's place first. A container executor sweeps whatever
  // survived the process being replaced there: kill before adopt (Invariant 12).
  let prepared: Prepared;
  try {
    prepared = await executor.prepare({
      sessionId: s.id,
      root: s.session_root,
    });
  } catch (e) {
    return err(
      asFrmError(e, "spawn_failed", `cannot prepare the root of ${s.id}`),
    );
  }
  // The /mcp URL and proxy as its programs reach them now (a container's gateway).
  const placed = applyPrepared(spec, prepared);
  // Its store of originals, as at spawn: there before the runner resumes, never through a link.
  if (placed.contextCompression !== undefined) {
    const store = await ensureContextStore(placed.contextCompression.storeDir);
    if (!store.ok) return store;
  }
  const home = await adapter.prepareHome(placed, executor);
  if (!home.ok) return home;
  const seg = await ctx.ingest.beginSegment(s.id);
  if (!seg.ok) return seg;
  // Before the process starts: the resumed CLI calls the MCP server at init (F4).
  const minted = await setSessionTokenHash(ctx.db, s.id, tokenHash);
  if (!minted.ok) return minted;
  const adopted = await adapter.adopt(placed, executor);
  if (!adopted.ok) return adopted;
  const handle = adopted.value;
  // Tracked before anything can fail: an unwind's adapter.stop awaits its exit (escape 2).
  ctx.candidates.track(s.id, executor, handle);
  patchEntry(ctx, s.id, {
    proc: { handle, adapter, executor, closed: handle.exited },
  });
  const idle = await move(ctx, s.id, "adopt", {
    executor_ref: handle.executorRef,
    runner_session_id: handle.runnerSessionId ?? s.runner_session_id,
    raw_segment_offset: seg.value.offset,
    // What it now runs: its pin, re-pinned when a stale one resumed on this build's ruleset.
    context_ruleset: contextRuleset,
  });
  const attached = idle.ok
    ? attachProcess(
        ctx,
        s.id,
        { handle, adapter, executor },
        seg.value.offset,
        redact,
      )
    : idle;
  if (!attached.ok) {
    await adapter.stop(handle, "kill");
    return attached;
  }
  return ok(handle.executorRef);
}
