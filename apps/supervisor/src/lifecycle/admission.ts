// Admission v1 in the supervisor (§9.1; design §2.2–§4): the facts core's gates read,
// gathered here through @bayon/db, and the drain that holds queued spawns off the session queues
// (CRITICAL-1). Core decides; this file reads, takes slots and moves the row.
import {
  ADMISSION_SETTING_KEYS,
  FrmError,
  admissionRefused,
  admitEarly,
  admitSpawn,
  err,
  mayStartTurn,
  ok,
  readAdmissionSettings,
  type AdmissionSettings,
  type AdmissionVerdict,
  type Blocked,
  type BudgetFact,
  type EarlyFacts,
  type ProjectFact,
  type QueuedReason,
  type Result,
  type SpawnFacts,
  type TurnKind,
} from "@bayon/core";
import {
  countAdmittedSessions,
  countLiveSessionsOfRunner,
  getAgent,
  getExecutor,
  getLiveCertification,
  getRunner,
  getSession,
  getSettings,
  listBudgets,
  listPairFailuresSince,
  type ExecutorRow,
  type ModelRow,
  type SessionRow,
} from "@bayon/db";
import { workRoleTools } from "@bayon/proto";
import { z } from "zod";
import { readProjectFact } from "../project-hold.js";
import { move, patchEntry, schedule, type Ctx } from "./context.js";
import { endSession } from "./end.js";
import { checkHealth } from "./health.js";
import { builtinToolsFor } from "./mcp.js";
import { spawnProject, type Resolved } from "./resolve.js";
import type { FirstRun } from "./spawn.js";

/** A spawn whose model resolved: what the drain admits (Resolved.model narrowed, §2.3.1). */
export type Admitted = Resolved & { readonly model: ModelRow };

/** Only while the settings cannot be read: queued spawns are still rechecked. */
const FALLBACK_RECHECK_MS = 5_000;

const HealthDetail = z.looseObject({
  free_pct: z.number().nullable().optional(),
});

/** The last health check's free disk (executors.health_detail); null when it measured none. */
function freePctOf(detail: string | null): number | null {
  if (detail === null) return null;
  try {
    const parsed = HealthDetail.safeParse(JSON.parse(detail));
    return parsed.success ? (parsed.data.free_pct ?? null) : null;
  } catch {
    return null; // an unreadable detail is no measurement: the disk gate passes, as documented
  }
}

async function readSettings(ctx: Ctx): Promise<Result<AdmissionSettings>> {
  const rows = await getSettings(ctx.db, Object.values(ADMISSION_SETTING_KEYS));
  return rows.ok ? readAdmissionSettings(rows.value) : rows;
}

interface Early {
  readonly facts: EarlyFacts;
  readonly row: ExecutorRow;
}

/** Gates 1–5's facts: the rows read fresh, nothing counted. */
async function gatherEarly(
  ctx: Ctx,
  r: Resolved,
  settings: AdmissionSettings,
): Promise<Result<Early>> {
  const row = await getExecutor(ctx.db, r.executorId);
  if (!row.ok) return row;
  const runner = await getRunner(ctx.db, r.runner.id);
  if (!runner.ok) return runner;
  const agent = await getAgent(ctx.db, r.agent.id);
  if (!agent.ok) return agent;
  // The exact model the session would run, with its context compressed or not
  //: a certificate earned on another model of the runner, or the other way, never admits
  // it. No model is `no_model`'s to refuse, before this gate.
  const cert =
    r.model === null
      ? ok(null)
      : await getLiveCertification(
          ctx.db,
          r.runner.id,
          r.executorId,
          r.model.id,
          r.compression,
        );
  if (!cert.ok) return cert;
  return ok({
    row: row.value,
    facts: {
      settings,
      executor: {
        id: row.value.id,
        loaded: ctx.executors.has(row.value.id),
        enabled: row.value.enabled === 1,
        trust: row.value.trust,
      },
      runner: {
        id: runner.value.id,
        loaded: ctx.adapters.has(runner.value.id),
        enabled: runner.value.enabled === 1,
        certified: cert.value !== null,
        compression: r.compression,
        jobRunner: ctx.jobRunners.has(runner.value.id),
      },
      agent: {
        id: agent.value.id,
        enabled: agent.value.enabled === 1,
        maxConcurrency: agent.value.max_concurrency,
      },
      model: r.model?.model ?? null,
      modelId: r.model?.id ?? null,
      modelUnpriced:
        r.model !== null &&
        (r.model.price_in_per_mtok === null ||
          r.model.price_out_per_mtok === null),
      tier: r.tier,
      role: r.payload.role,
      untrustedInput: r.payload.untrusted_input === true,
      // Fixed at resolve: the role's row ∩ the profile's allowlist (no_tools).
      tools: {
        profileId: r.profileId,
        roleTools: workRoleTools(r.payload.role).length,
        mcpClient: r.adapter.caps().mcpClient,
        mounted: r.toolset.tools.length,
        gateReviewer: r.gate !== null,
      },
      // The run class's cap against the runner row's own baseline (context_baseline).
      context: {
        runClass: r.runClass.name,
        capTokens: r.runClass.context_tokens_cap,
        baselineTokens: r.config.baselineTokens,
        ownTools: builtinToolsFor(r.payload.role).builtinTools !== "none",
      },
    },
  });
}

/**
 * Gates 1–5 before the row exists (§2.3.1): a refusal fails the spawn with its gate and leaves no
 * row. What passes is Admitted: its model is known.
 */
export async function admitBeforeRow(
  ctx: Ctx,
  r: Resolved,
): Promise<Result<Admitted>> {
  const settings = await readSettings(ctx);
  if (!settings.ok) return settings;
  const early = await gatherEarly(ctx, r, settings.value);
  if (!early.ok) return early;
  const verdict = admitEarly(early.value.facts);
  if (verdict.kind !== "admit") return err(admissionRefused(verdict));
  const { model } = r;
  // Gate 2 refused a null model above; this only narrows the type.
  return model === null
    ? err(
        admissionRefused({
          kind: "refuse",
          gate: "no_model",
          detail: `no active ${r.tier} model of runner ${r.runner.id}`,
        }),
      )
    : ok({ ...r, model });
}

/** A live session's project fact: its own workspace's, else its agent's. */
async function sessionProject(
  ctx: Ctx,
  s: SessionRow,
): Promise<Result<ProjectFact | null>> {
  if (s.workspace_id !== null) return readProjectFact(ctx.db, s.workspace_id);
  const agent = await getAgent(ctx.db, s.agent_id);
  return agent.ok ? readProjectFact(ctx.db, agent.value.workspace_id) : agent;
}

/**
 * mayStartTurn (§4): a live session's `run` is refused while the fleet or its project is paused,
 * or a budget in its scope is spent. A spawn's first run and a hand-off packet are never checked.
 */
export async function turnAllowed(
  ctx: Ctx,
  sessionId: string,
  kind: TurnKind,
): Promise<Result<void>> {
  if (kind !== "run") return ok(undefined);
  const s = await getSession(ctx.db, sessionId);
  if (!s.ok) return s;
  const settings = await readSettings(ctx);
  if (!settings.ok) return settings;
  const project = await sessionProject(ctx, s.value);
  if (!project.ok) return project;
  const budgets = await listBudgets(ctx.db);
  if (!budgets.ok) return budgets;
  const verdict = mayStartTurn(
    {
      now: ctx.clock.now(),
      settings: settings.value,
      agent: { id: s.value.agent_id },
      project: project.value,
      budgets: budgets.value,
    },
    kind,
  );
  return verdict.kind === "admit"
    ? ok(undefined)
    : err(admissionRefused(verdict));
}

/**
 * A stop's or a deadline's end of a queued spawn (MEDIUM-A): only when the waiter was still
 * unclaimed. Once the drain claimed it, the pipeline (after an admit) or the refusal owns the end.
 */
export async function withdrawAndEnd(ctx: Ctx, id: string): Promise<void> {
  const w = ctx.admission.withdraw(id);
  if (w === undefined) return;
  const reason = FrmError.safeParse(ctx.live.get(id)?.abort.signal.reason);
  await endSession(
    ctx,
    id,
    "abort",
    reason.success
      ? {
          exit_reason: "error",
          error_class: reason.data.class,
          error_message: reason.data.message,
        }
      : {
          exit_reason: "killed",
          error_message: `stopped while queued (${w.reason ?? "not yet evaluated"})`,
        },
  );
}

export interface Waiter {
  readonly sessionId: string;
  readonly admitted: Admitted;
  readonly first: FirstRun | undefined;
  /** The gate it is queued on; null until the drain has seen it. */
  readonly reason: QueuedReason | null;
}

export interface Admission {
  /** A created pending session joins behind every waiter; a drain follows. */
  enqueue(w: Omit<Waiter, "reason">): void;
  /** Takes out a waiter the drain has not claimed, with its last reason; else undefined. */
  withdraw(
    sessionId: string,
  ): { readonly reason: QueuedReason | null } | undefined;
  /** A waiter's last queued reason; null when it is not waiting or was never queued. */
  reasonOf(sessionId: string): QueuedReason | null;
  /** A drain now, or one more after the drain in flight. */
  wake(): void;
  /** Settles once no drain is in flight; queued waiters never hold it. */
  settled(): Promise<void>;
  /** A drain is in flight. */
  busy(): boolean;
  /** The waiting session ids, in arrival order (the drain's order). */
  waiting(): readonly string[];
  /** Stops the recheck. Waiters are dropped here; their rows stay pending for the next boot. */
  shutdown(): void;
}

/**
 * Tests only: seams inside the drain. `beforeAdmit` runs after a waiter is claimed and holds its
 * slot, before the admit CAS: where a test puts a stop or a competing move (MEDIUM-A, MEDIUM-1).
 */
export interface AdmissionHooks {
  readonly beforeAdmit?: (sessionId: string) => Promise<void>;
}

interface Shared {
  readonly settings: AdmissionSettings;
  readonly budgets: readonly BudgetFact[];
}

/** Resources an earlier waiter in this pass is queued on: later ones wait behind it for them. */
interface Blocks {
  readonly executors: ReadonlySet<string>;
  readonly agents: ReadonlySet<string>;
  /**
   * Runners that serve one session at a time (§5.1 `concurrentSessions`) and whose one session
   * this pass has already given away — by queueing a waiter on it, or by admitting one, since the
   * admitted session is not in the DB count the next waiter reads until its move lands.
   */
  readonly runners: ReadonlySet<string>;
}

/** The runner takes its whole credential for one session (§5.1). */
const singleSession = (w: Waiter): boolean =>
  !w.admitted.adapter.caps().concurrentSessions;

/** Settings and budgets, once per pass (LOW-D). */
async function sharedFacts(ctx: Ctx): Promise<Result<Shared>> {
  const settings = await readSettings(ctx);
  if (!settings.ok) return settings;
  const budgets = await listBudgets(ctx.db);
  return budgets.ok
    ? ok({ settings: settings.value, budgets: budgets.value })
    : budgets;
}

/** The slow facts before the pass decides: first-use health checks and one MCP probe. */
async function prePass(
  ctx: Ctx,
  waiters: readonly Waiter[],
): Promise<{ readonly mcpReachable: boolean | null }> {
  for (const id of new Set(waiters.map((w) => w.admitted.executorId))) {
    const row = await getExecutor(ctx.db, id);
    if (row.ok && row.value.enabled === 1 && row.value.health === "unknown") {
      await checkHealth(ctx, row.value);
    }
  }
  const mounts = waiters.some((w) => w.admitted.toolset.tools.length > 0);
  return { mcpReachable: mounts ? await ctx.mcpReachable(ctx.mcpUrl) : null };
}

async function spawnFacts(
  ctx: Ctx,
  w: Waiter,
  shared: Shared,
  mcpReachable: boolean | null,
): Promise<Result<SpawnFacts>> {
  const a = w.admitted;
  const early = await gatherEarly(ctx, a, shared.settings);
  if (!early.ok) return early;
  const { row, facts } = early.value;
  // Capacity follows the row at every evaluation (§5); used slots are this process's holds.
  const counter = ctx.executors.get(row.id)?.slots;
  counter?.resize(row.slots);
  const admitted = await countAdmittedSessions(ctx.db, a.agent.id);
  if (!admitted.ok) return admitted;
  // §5.1: only a runner that serves one session at a time needs the count, so only it pays for it.
  const concurrentSessions = a.adapter.caps().concurrentSessions;
  const live = concurrentSessions
    ? ok(0)
    : await countLiveSessionsOfRunner(ctx.db, a.runner.id);
  if (!live.ok) return live;
  const now = ctx.clock.now();
  const storm = shared.settings.retryStorm;
  const failures = await listPairFailuresSince(ctx.db, {
    runnerId: a.runner.id,
    executorId: row.id,
    since: now - storm.windowMs - storm.backoffMs,
  });
  if (!failures.ok) return failures;
  const project = await readProjectFact(ctx.db, spawnProject(a));
  if (!project.ok) return project;
  return ok({
    ...facts,
    now,
    project: project.value,
    budgets: shared.budgets,
    executor: {
      ...facts.executor,
      health: row.health,
      freePct: freePctOf(row.health_detail),
      slots: row.slots,
      used: counter?.capacity().used ?? 0,
    },
    agent: { ...facts.agent, admitted: admitted.value },
    runner: { ...facts.runner, concurrentSessions, live: live.value },
    reviewer: a.gate !== null,
    failures: failures.value,
    mcpUnreachable:
      a.toolset.tools.length > 0 && mcpReachable === false ? ctx.mcpUrl : null,
  });
}

/** An admit for a waiter behind an earlier one on its executor's slots or its agent queues too. */
function behind(
  v: AdmissionVerdict,
  w: Waiter,
  blocks: Blocks,
): AdmissionVerdict {
  if (v.kind !== "admit") return v;
  const { executorId, agent, gate, runner } = w.admitted;
  if (blocks.runners.has(runner.id)) {
    return {
      kind: "queue",
      gate: "runner_concurrency",
      detail: `behind an earlier waiter for the one session of runner ${runner.id}`,
    };
  }
  if (blocks.executors.has(executorId)) {
    return {
      kind: "queue",
      gate: "slot",
      detail: `behind an earlier waiter for a slot on ${executorId}`,
    };
  }
  if (gate === null && blocks.agents.has(agent.id)) {
    return {
      kind: "queue",
      gate: "concurrency",
      detail: `behind an earlier waiter of agent ${agent.id}`,
    };
  }
  return v;
}

function blockOn(blocks: Blocks, w: Waiter, gate: QueuedReason): Blocks {
  if (gate === "runner_concurrency") {
    return {
      ...blocks,
      runners: new Set([...blocks.runners, w.admitted.runner.id]),
    };
  }
  if (gate === "slot") {
    return {
      ...blocks,
      executors: new Set([...blocks.executors, w.admitted.executorId]),
    };
  }
  if (gate === "concurrency") {
    return {
      ...blocks,
      agents: new Set([...blocks.agents, w.admitted.agent.id]),
    };
  }
  return blocks;
}

/**
 * The drain (§2.3.2): one pass at a time, waiters in arrival order. Only the drain admits, so a
 * pass is the admission lock: nothing else takes a slot or moves a pending session to preparing.
 * `start` runs an admitted session's pipeline, from step 2, on its queue.
 */
export function createAdmission(
  ctxOf: () => Ctx,
  start: (a: Admitted, first: FirstRun | undefined) => void,
  hooks: AdmissionHooks = {},
): Admission {
  let waiters: readonly Waiter[] = [];
  let draining: Promise<void> | null = null;
  let again = false;
  let closed = false;
  let timer: AbortController | null = null;
  let recheckMs = FALLBACK_RECHECK_MS;

  const isWaiting = (id: string): boolean =>
    waiters.some((w) => w.sessionId === id);
  const reasonOf = (id: string): QueuedReason | null =>
    waiters.find((w) => w.sessionId === id)?.reason ?? null;

  const drop = (id: string): void => {
    waiters = waiters.filter((w) => w.sessionId !== id);
    if (waiters.length === 0) {
      timer?.abort();
      timer = null;
    }
  };

  const arm = (): void => {
    if (closed || timer !== null || waiters.length === 0) return;
    const t = new AbortController();
    timer = t;
    ctxOf()
      .clock.after(recheckMs, t.signal)
      .then(
        () => {
          if (timer === t) timer = null;
          wake();
        },
        () => undefined, // disarmed: no waiter left, or shut down
      );
  };

  const wake = (): void => {
    if (closed) return;
    if (draining !== null) {
      again = true;
      return;
    }
    draining = drainLoop()
      .catch((e: unknown) => {
        ctxOf().log.error(
          { err: String(e) },
          "admission: a drain failed; the recheck retries",
        );
      })
      .finally(() => {
        draining = null;
        arm();
      });
  };

  async function drainLoop(): Promise<void> {
    do {
      again = false;
      await pass(ctxOf());
    } while (again && !closed);
  }

  async function pass(ctx: Ctx): Promise<void> {
    if (waiters.length === 0) return;
    const pre = await prePass(ctx, waiters);
    const shared = await sharedFacts(ctx);
    if (!shared.ok) {
      ctx.log.error(
        { error: shared.error },
        "admission: cannot read the settings or budgets; every waiter stays queued",
      );
      return;
    }
    recheckMs = shared.value.settings.recheckMs;
    let blocks: Blocks = {
      executors: new Set(),
      agents: new Set(),
      runners: new Set(),
    };
    // A snapshot: an enqueue during the pass waits for the next one (it wakes again).
    for (const w of waiters) {
      if (!isWaiting(w.sessionId)) continue;
      blocks = await consider(ctx, w, shared.value, pre.mcpReachable, blocks);
    }
  }

  async function consider(
    ctx: Ctx,
    w: Waiter,
    shared: Shared,
    mcpReachable: boolean | null,
    blocks: Blocks,
  ): Promise<Blocks> {
    const facts = await spawnFacts(ctx, w, shared, mcpReachable);
    if (!facts.ok) {
      ctx.log.error(
        { sessionId: w.sessionId, error: facts.error },
        "admission: cannot read its facts; it stays queued",
      );
      return blocks;
    }
    // Withdrawn during the reads (a stop, a deadline): not claimed; its end is the withdrawer's.
    if (!isWaiting(w.sessionId)) return blocks;
    const verdict = behind(admitSpawn(facts.value), w, blocks);
    if (verdict.kind === "admit") return admitOne(ctx, w, blocks);
    if (verdict.kind === "refuse") {
      refuseOne(ctx, w, verdict);
      return blocks;
    }
    await queueOne(ctx, w, verdict.gate, verdict.detail);
    return blockOn(blocks, w, verdict.gate);
  }

  /** Claim → slot → entry → CAS → pipeline (MEDIUM-A): the slot is released exactly once. */
  async function admitOne(
    ctx: Ctx,
    w: Waiter,
    blocks: Blocks,
  ): Promise<Blocks> {
    const id = w.sessionId;
    const slot =
      ctx.executors.get(w.admitted.executorId)?.slots.tryAcquire() ?? null;
    if (slot === null) {
      await queueOne(ctx, w, "slot", `no slot on ${w.admitted.executorId}`);
      return blockOn(blocks, w, "slot");
    }
    // The design lists claim, then tryAcquire. The slot is tried first here so a full executor leaves
    // the waiter untouched in its place; no await sits between the waiting check, tryAcquire and
    // this claim, so no withdraw() can land in between and the two orders are the same.
    // Claimed: withdraw() now returns undefined.
    drop(id);
    patchEntry(ctx, id, { slot });
    await hooks.beforeAdmit?.(id);
    // The spawn request is needed only while pending, for a re-admission (LOW-7).
    const moved = await move(ctx, id, "admit", {
      queued_reason: null,
      spawn_request_json: null,
    });
    if (!moved.ok) {
      // The drain's own handle: the entry may be gone already (patchEntry no-ops then).
      slot.release();
      ctx.log.warn(
        { sessionId: id, error: moved.error },
        "admission: another op moved the session first; its slot is released",
      );
      return blocks;
    }
    ctx.log.info(
      { sessionId: id, executor: w.admitted.executorId },
      "admitted",
    );
    start(w.admitted, w.first);
    // Its runner's one session is taken for the rest of this pass, whatever the next waiter's
    // count reads.
    return singleSession(w) ? blockOn(blocks, w, "runner_concurrency") : blocks;
  }

  /** A refuse fact changed while it waited (e.g. its executor was disabled): claimed, then ended. */
  function refuseOne(ctx: Ctx, w: Waiter, v: Blocked): void {
    drop(w.sessionId);
    const error = admissionRefused(v);
    ctx.log.warn(
      { sessionId: w.sessionId, error },
      "admission refused a queued spawn",
    );
    schedule(ctx, w.sessionId, "admission refusal", () =>
      endSession(ctx, w.sessionId, "abort", {
        exit_reason: "error",
        error_class: error.class,
        error_message: error.message,
      }),
    );
  }

  async function queueOne(
    ctx: Ctx,
    w: Waiter,
    gate: QueuedReason,
    detail: string,
  ): Promise<void> {
    if (reasonOf(w.sessionId) === gate) return;
    const moved = await move(ctx, w.sessionId, "queue", {
      queued_reason: gate,
    });
    if (!moved.ok) {
      ctx.log.warn(
        { sessionId: w.sessionId, error: moved.error },
        "admission: cannot record the queued reason",
      );
      return;
    }
    waiters = waiters.map((x) =>
      x.sessionId === w.sessionId ? { ...x, reason: gate } : x,
    );
    ctx.log.info({ sessionId: w.sessionId, gate }, `queued: ${detail}`);
  }

  return {
    enqueue(w) {
      // Already waiting: a no-op, so a requeued session.spawn and a re-admission after a restart
      // converge on one waiter, in its original place.
      if (isWaiting(w.sessionId)) return;
      const ctx = ctxOf();
      waiters = [...waiters, { ...w, reason: null }];
      const signal = ctx.live.get(w.sessionId)?.abort.signal;
      const onAbort = (): void => {
        schedule(ctx, w.sessionId, "withdraw", () =>
          withdrawAndEnd(ctx, w.sessionId),
        );
      };
      if (signal?.aborted === true) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      wake();
    },
    withdraw(sessionId) {
      const w = waiters.find((x) => x.sessionId === sessionId);
      if (w === undefined) return undefined;
      drop(sessionId);
      return { reason: w.reason };
    },
    reasonOf,
    waiting: () => waiters.map((w) => w.sessionId),
    wake,
    busy: () => draining !== null,
    async settled() {
      while (draining !== null) await draining;
    },
    shutdown() {
      closed = true;
      timer?.abort();
      timer = null;
      waiters = [];
    },
  };
}
