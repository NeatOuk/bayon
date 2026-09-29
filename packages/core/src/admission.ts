// Admission v1 (§9.1; M4 amendments 1–4): one ordered table of gates, evaluated by
// pure functions over facts the supervisor gathers. The first failing gate decides. A refuse gate
// fails the spawn (admission_refused, cause.gate); a queue gate keeps it pending with
// sessions.queued_reason. The table's turn rows are mayStartTurn.
import { z } from "zod";
import {
  QueuedReason,
  SINGLE_SESSION_CAP,
  type AdmissionGate,
  type TurnKind,
} from "./admission-gates.js";
import type { BudgetOnBreach, BudgetPeriod, BudgetScope } from "./budget.js";
import { err, ok, type FrmError, type Result } from "./errors.js";
import { UNTRUSTED_ROLES_KEY, UntrustedRoles } from "./gates/settings.js";
import { trustRefusal } from "./trust.js";

export {
  AdmissionGate,
  AdmissionRefusalCause,
  QueuedReason,
  SINGLE_SESSION_CAP,
  TurnKind,
} from "./admission-gates.js";

export interface AdmissionSettings {
  readonly paused: boolean;
  readonly requireCertified: boolean;
  readonly diskMinFreePct: number;
  readonly recheckMs: number;
  readonly untrustedRoles: readonly string[];
  readonly retryStorm: RetryStormSettings;
}

export interface RetryStormSettings {
  readonly count: number;
  readonly windowMs: number;
  readonly backoffMs: number;
}

/** The settings key of each admission setting (M4 contracts; 012 seeds them). */
export const ADMISSION_SETTING_KEYS = {
  paused: "fleet.paused",
  requireCertified: "admission.require_certified",
  diskMinFreePct: "admission.disk_min_free_pct",
  recheckMs: "admission.recheck_ms",
  untrustedRoles: UNTRUSTED_ROLES_KEY,
  stormCount: "watchdog.retry_storm_count",
  stormWindowMs: "watchdog.retry_storm_window_ms",
  stormBackoffMs: "watchdog.retry_storm_backoff_ms",
} as const;

/** A 0/1 flag, as 012 seeds it; a boolean is accepted too. */
export const SettingFlag = z
  .union([z.literal(0), z.literal(1), z.boolean()])
  .transform((v) => v === 1 || v === true);

const Rows = z.object({
  paused: SettingFlag,
  requireCertified: SettingFlag,
  diskMinFreePct: z.number().min(0).max(100),
  recheckMs: z.int().positive(),
  untrustedRoles: UntrustedRoles,
  stormCount: z.int().positive(),
  stormWindowMs: z.int().positive(),
  stormBackoffMs: z.int().nonnegative(),
});

/** AdmissionSettings from the parsed settings rows. A missing row is a config error, never a default. */
export function readAdmissionSettings(
  rows: ReadonlyMap<string, unknown>,
): Result<AdmissionSettings> {
  const parsed = Rows.safeParse(
    Object.fromEntries(
      Object.entries(ADMISSION_SETTING_KEYS).map(([field, key]) => [
        field,
        rows.get(key),
      ]),
    ),
  );
  if (!parsed.success) {
    return err({
      class: "validation",
      message: `admission settings: ${z.prettifyError(parsed.error)}`,
      retryable: false,
    });
  }
  const { stormCount, stormWindowMs, stormBackoffMs, ...rest } = parsed.data;
  return ok({
    ...rest,
    retryStorm: {
      count: stormCount,
      windowMs: stormWindowMs,
      backoffMs: stormBackoffMs,
    },
  });
}

/** A budget with its spend in its current window (db listBudgets). */
export interface BudgetFact {
  readonly id: string;
  readonly scope: BudgetScope;
  readonly scope_ref: string | null;
  readonly period: BudgetPeriod;
  readonly cap_usd: number | null;
  readonly cap_tokens: number | null;
  readonly on_breach: BudgetOnBreach;
  readonly spent_usd: number;
  readonly spent_tokens: number;
}

/** A session's project and whether it is paused (`workspaces.paused`). */
export interface ProjectFact {
  readonly id: string;
  readonly paused: boolean;
}

/** What a turn reads: the turn gates' facts, and nothing else. */
export interface TurnFacts {
  readonly now: number;
  readonly settings: AdmissionSettings;
  readonly agent: { readonly id: string };
  /**
   * The session's project: its own workspace, else its agent's (a pulse runs with none of its
   * own). Null for fleet work, which no project's pause holds.
   */
  readonly project: ProjectFact | null;
  readonly budgets: readonly BudgetFact[];
}

/** What the early gates read before the row exists: no counts, health, budgets or failures. */
export interface EarlyFacts {
  readonly settings: AdmissionSettings;
  readonly executor: {
    readonly id: string;
    readonly loaded: boolean;
    readonly enabled: boolean;
    readonly trust: string;
  };
  readonly runner: {
    readonly id: string;
    readonly loaded: boolean;
    readonly enabled: boolean;
    /**
     * A live certification of (runner, executor, the session's model, `compression`) (§15;
     *).
     */
    readonly certified: boolean;
    /**
     * The session's model calls go through the context proxy (spec M12): the certificate above is
     * the one earned with compression on.
     */
    readonly compression: boolean;
    /** One of the supervisor's own job runners: exempt from `uncertified` only. */
    readonly jobRunner: boolean;
  };
  readonly agent: {
    readonly id: string;
    readonly enabled: boolean;
    readonly maxConcurrency: number;
  };
  /** The active model of the profile's tier; null when there is none. */
  readonly model: string | null;
  /** That model's models row, which `frm runner conformance --model` names; null with `model`. */
  readonly modelId: string | null;
  /**
   * The model has no input or output price (`models.price_in_per_mtok`/`price_out_per_mtok` null,
   *): its spend could not be counted, so the budget could not bound it. 0 is a price.
   */
  readonly modelUnpriced?: boolean;
  readonly tier: string;
  readonly role: string;
  readonly untrustedInput: boolean;
  /** The session's MCP tools, fixed at resolve. */
  readonly tools: {
    /** The profile whose tool_allowlist_json decided them. */
    readonly profileId: string;
    /** The role's catalogue row: what a work role can be served; 0 for any other role. */
    readonly roleTools: number;
    /** The runner mounts an MCP server at all; without one it mounts none, and that is not this gate. */
    readonly mcpClient: boolean;
    /** What it mounts: the role's row ∩ the profile's allowlist. */
    readonly mounted: number;
    /** A gate's reviewer (M3-h): its verdict is its output file, which the daemon reads. */
    readonly gateReviewer: boolean;
  };
  /** The run class's context cap against the runner's session baseline. */
  readonly context: {
    readonly runClass: string;
    /** run_classes.context_tokens_cap; 0 is n/a. */
    readonly capTokens: number;
    /**
     * The runner's own `sessionBaselineTokens` default: the smallest context a session with its
     * own tools needs before it reads a file. 0 when it declares none.
     */
    readonly baselineTokens: number;
    /** The session runs with the runner's own tools; an MCP-only one (the pulse) withholds them. */
    readonly ownTools: boolean;
  };
}

/** Everything the drain reads for one waiter. */
export interface SpawnFacts extends EarlyFacts, TurnFacts {
  readonly executor: EarlyFacts["executor"] & {
    readonly health: string;
    /** The last health check's free disk; null when it measured none. */
    readonly freePct: number | null;
    readonly slots: number;
    readonly used: number;
  };
  readonly agent: EarlyFacts["agent"] & { readonly admitted: number };
  readonly runner: EarlyFacts["runner"] & {
    /** The runner's §5.1 `concurrentSessions`, as its adapter declares it. */
    readonly concurrentSessions: boolean;
    /**
     * Sessions of this runner admission let in and that have not ended — the waiter itself is
     * still pending, so it never counts itself. Only read when the cap is absent.
     */
    readonly live: number;
  };
  /** A gate's reviewer (M3-h): exempt from `concurrency`. */
  readonly reviewer: boolean;
  /** When this (runner, executor) pair's failed runner_error runs ended. */
  readonly failures: readonly number[];
  /** The MCP URL when tools are mounted and it does not answer; else null. */
  readonly mcpUnreachable: string | null;
}

export type Blocked =
  | {
      readonly kind: "refuse";
      readonly gate: AdmissionGate;
      readonly detail: string;
    }
  | {
      readonly kind: "queue";
      readonly gate: QueuedReason;
      readonly detail: string;
    };
export type AdmissionVerdict = { readonly kind: "admit" } | Blocked;

type Check<F> = (f: F) => string | null;

interface GateRow {
  readonly gate: AdmissionGate;
  readonly early?: Check<EarlyFacts>;
  readonly spawn: Check<SpawnFacts>;
  readonly turn?: Check<TurnFacts>;
}

const disabled: Check<EarlyFacts> = ({ executor: e, runner: r, agent: a }) => {
  if (!e.loaded) return `executor ${e.id} is not loaded`;
  if (!e.enabled) return `executor ${e.id} is disabled`;
  if (!r.loaded) return `no adapter is loaded for runner ${r.id}`;
  if (!r.enabled) return `runner ${r.id} is disabled`;
  if (!a.enabled) return `agent ${a.id} is disabled`;
  return a.maxConcurrency === 0 ? `agent ${a.id} has max_concurrency 0` : null;
};

const noModel: Check<EarlyFacts> = (f) => {
  if (f.model === null)
    return `no active ${f.tier} model of runner ${f.runner.id}`;
  return f.modelUnpriced === true
    ? `model ${f.model} of runner ${f.runner.id} is unpriced: set its price_in_per_mtok and price_out_per_mtok (0 is allowed) with frm config apply or on the Runners page`
    : null;
};

/**
 * A work role whose runner speaks MCP, mounting none of its tools: it could not write back. A
 * gate's reviewer can without them: its verdict is its output file, never an MCP call (M3-h).
 */
const noTools: Check<EarlyFacts> = ({ tools: t, agent, role }) =>
  !t.gateReviewer && t.mcpClient && t.roleTools > 0 && t.mounted === 0
    ? `agent ${agent.id}: profile ${t.profileId} allows none of role ${role}'s ${t.roleTools} MCP tools (tool_allowlist_json), so the session could not write back: no accept, no plan, no hand-off`
    : null;

/**
 * A run class whose context cap is below what a session with the runner's own tools needs before it
 * reads a file: the session would be over its ceiling from its first turn. A 0 cap is
 * n/a, and so is a runner that declares no baseline. An MCP-only session (the pulse) withholds the
 * runner's own tools, so that baseline is not its.
 */
const contextBaseline: Check<EarlyFacts> = ({ context: c, runner }) =>
  c.ownTools && c.capTokens > 0 && c.capTokens < c.baselineTokens
    ? `run class ${c.runClass}'s context_tokens_cap ${c.capTokens} is below runner ${runner.id}'s session baseline of ${c.baselineTokens} tokens (sessionBaselineTokens), so a session could not start in it: raise the cap (frm config apply run_classes) or staff another runner`
    : null;

const trust: Check<EarlyFacts> = (f) =>
  trustRefusal({
    role: f.role,
    untrustedInput: f.untrustedInput,
    untrustedRoles: f.settings.untrustedRoles,
    executorId: f.executor.id,
    trust: f.executor.trust,
  });

/**
 * The certificate the spawn needs is missing: the sentence names the exact command that earns it,
 * with `--compression` when the session would run compressed (a compression-off certificate never
 * stands in for it, spec M12).
 */
const uncertified: Check<EarlyFacts> = ({
  settings,
  runner: r,
  executor,
  model,
  modelId,
}) =>
  settings.requireCertified && !r.jobRunner && !r.certified
    ? // `no_model` precedes this gate in GATES, so a model is always named here.
      `runner ${r.id} with model ${String(model)} is not certified${r.compression ? " with context compression" : ""} on executor ${executor.id} (admission.require_certified=1): certify it with frm runner conformance ${r.id} --model ${modelId ?? "<id>"} --executor ${executor.id}${r.compression ? " --compression" : ""}`
    : null;

const paused: Check<TurnFacts> = (f) =>
  f.settings.paused ? "the fleet is paused (fleet.paused=1)" : null;

const projectPaused: Check<TurnFacts> = ({ project }) =>
  project?.paused === true
    ? `project ${project.id} is paused (workspaces.paused=1)`
    : null;

const budget: Check<TurnFacts> = (f) => {
  const breach = budgetBreach(f.budgets, f.agent.id);
  return breach === null
    ? null
    : `budget ${breach.budget.scope}/${breach.budget.period} ${breach.budget.id}: ${breach.detail}`;
};

const disk: Check<SpawnFacts> = ({ executor: e, settings }) =>
  e.freePct !== null && e.freePct < settings.diskMinFreePct
    ? `executor ${e.id} has ${e.freePct} % disk free, under admission.disk_min_free_pct ${settings.diskMinFreePct}`
    : null;

const retryStorm: Check<SpawnFacts> = (f) => {
  const c = f.settings.retryStorm;
  const until = retryStormUntil(f.failures, f.now, c);
  return until === null
    ? null
    : `runner ${f.runner.id} on executor ${f.executor.id}: ${c.count} runner_error failures within ${c.windowMs} ms; admission reopens at ${new Date(until).toISOString()}`;
};

const concurrency: Check<SpawnFacts> = ({ reviewer, agent: a }) =>
  !reviewer && a.admitted >= a.maxConcurrency
    ? `agent ${a.id} runs ${a.admitted} of max_concurrency ${a.maxConcurrency}`
    : null;

/**
 * §5.1 `concurrentSessions`: a runner whose credential serves one session at a time gets its next
 * spawn **queued**, never refused — the same shape as a budget cap or a fleet pause. The adapter's
 * own refusal is a backstop; this is the mechanism, and conformance test 15's N/A rests on it.
 */
const runnerConcurrency: Check<SpawnFacts> = ({ runner: r }) =>
  !r.concurrentSessions && r.live > 0
    ? `runner ${r.id} serves one session at a time (${SINGLE_SESSION_CAP}=false) and runs ${r.live}`
    : null;

const unhealthy: Check<SpawnFacts> = ({ executor: e, mcpUnreachable }) => {
  if (e.health !== "healthy") return `executor ${e.id} is ${e.health}`;
  return mcpUnreachable === null
    ? null
    : `mcp ${mcpUnreachable} does not answer`;
};

const slot: Check<SpawnFacts> = ({ executor: e }) =>
  e.used >= e.slots ? `no slot on ${e.id}: ${e.used} of ${e.slots} held` : null;

/** The table: order and scopes are data. */
const GATES: readonly GateRow[] = [
  { gate: "disabled", early: disabled, spawn: disabled },
  { gate: "no_model", early: noModel, spawn: noModel },
  { gate: "no_tools", early: noTools, spawn: noTools },
  { gate: "context_baseline", early: contextBaseline, spawn: contextBaseline },
  { gate: "trust", early: trust, spawn: trust },
  { gate: "uncertified", early: uncertified, spawn: uncertified },
  { gate: "fleet_paused", spawn: paused, turn: paused },
  { gate: "project_paused", spawn: projectPaused, turn: projectPaused },
  { gate: "budget", spawn: budget, turn: budget },
  { gate: "disk", spawn: disk },
  { gate: "retry_storm", spawn: retryStorm },
  { gate: "concurrency", spawn: concurrency },
  { gate: "runner_concurrency", spawn: runnerConcurrency },
  { gate: "unhealthy", spawn: unhealthy },
  { gate: "slot", spawn: slot },
];

const ADMIT: AdmissionVerdict = { kind: "admit" };

function blocked(gate: AdmissionGate, detail: string): Blocked {
  const queued = QueuedReason.safeParse(gate);
  return queued.success
    ? { kind: "queue", gate: queued.data, detail }
    : { kind: "refuse", gate, detail };
}

function walk<F>(
  f: F,
  pick: (row: GateRow) => Check<F> | undefined,
): AdmissionVerdict {
  for (const row of GATES) {
    const detail = pick(row)?.(f) ?? null;
    if (detail !== null) return blocked(row.gate, detail);
  }
  return ADMIT;
}

/** Before the row exists: the early (refuse-only) gates, so it admits or refuses, never queues. */
export const admitEarly = (f: EarlyFacts): AdmissionVerdict =>
  walk(f, (row) => row.early);

/** The drain's verdict for one waiter: every gate. */
export const admitSpawn = (f: SpawnFacts): AdmissionVerdict =>
  walk(f, (row) => row.spawn);

/**
 * Whether a live session may start this run: only `fleet_paused`, `project_paused` and `budget`,
 * and only for a `run`. A spawn's first run and a hand-off packet are never checked.
 */
export const mayStartTurn = (f: TurnFacts, kind: TurnKind): AdmissionVerdict =>
  kind === "run" ? walk(f, (row) => row.turn) : ADMIT;

/** The one error shape a refusal takes; a queue gate's is retryable. */
export function admissionRefused(v: Blocked): FrmError {
  return {
    class: "admission_refused",
    message: `refused (${v.gate}): ${v.detail}`,
    retryable: v.kind === "queue",
    cause: { gate: v.gate, detail: v.detail },
  };
}

/** One retry-storm burst and the hold it causes. */
export interface StormHold {
  /** The first of the `count` failures within `windowMs`. */
  readonly burstStart: number;
  /** The last of them: the hold starts here. */
  readonly triggeredAt: number;
  /** triggeredAt + backoffMs. */
  readonly until: number;
}

/**
 * Every burst in `failures`, oldest first, and with no `now`: any `count` failures within
 * `windowMs` of each other trigger at the last one, and the hold lasts `backoffMs`. The gate reads
 * the latest (retryStormUntil); the circuit breaker excludes failures inside any of them, lapsed
 * ones included, so an outage never counts against the tickets it touched.
 */
export function retryStormHolds(
  failures: readonly number[],
  c: RetryStormSettings,
): StormHold[] {
  const sorted = [...failures].toSorted((a, b) => a - b);
  return sorted.flatMap((last, i) => {
    const first = sorted[i - c.count + 1];
    return first !== undefined && last - first <= c.windowMs
      ? [{ burstStart: first, triggeredAt: last, until: last + c.backoffMs }]
      : [];
  });
}

/** Whether `at` falls inside one of `holds`, from its burst's first failure to its end. */
export const inStormHold = (at: number, holds: readonly StormHold[]): boolean =>
  holds.some((h) => at >= h.burstStart && at <= h.until);

/** When a retry storm's hold ends, if one holds at `now`; else null. The latest hold wins. */
export function retryStormUntil(
  failures: readonly number[],
  now: number,
  c: RetryStormSettings,
): number | null {
  const until = Math.max(...retryStormHolds(failures, c).map((h) => h.until));
  return until > now ? until : null;
}

function breachOf(b: BudgetFact): string | null {
  if (b.cap_usd !== null && b.spent_usd >= b.cap_usd) {
    return `$${b.spent_usd.toFixed(2)} of $${b.cap_usd.toFixed(2)}`;
  }
  if (b.cap_tokens !== null && b.spent_tokens >= b.cap_tokens) {
    return `${b.spent_tokens} of ${b.cap_tokens} tokens`;
  }
  return null;
}

/** The first `pause_admission` budget in scope (the fleet's, or this agent's) spent to its cap. */
export function budgetBreach(
  budgets: readonly BudgetFact[],
  agentId: string,
): { readonly budget: BudgetFact; readonly detail: string } | null {
  for (const b of budgets) {
    if (b.on_breach !== "pause_admission") continue;
    if (b.scope === "agent" && b.scope_ref !== agentId) continue;
    const detail = breachOf(b);
    if (detail !== null) return { budget: b, detail };
  }
  return null;
}
