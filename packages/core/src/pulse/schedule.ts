// The pulse scheduler's next-wake math (§9.7). Pure: no clock, no I/O. The
// caller passes `now`, the agent's policy and its pulse history as read from `pulses`; the same
// inputs always give the same wake, so re-planning never moves one.
import { z } from "zod";

/** The run class a pulse's orchestrator session runs under (amendment k). */
export const PULSE_RUN_CLASS = "pulse";
/** The role a pulse's session takes: §11.1's orchestrator row. */
export const PULSE_ROLE = "orchestrator";
/** The MCP tool a pulse session must mount: without it the pulse cannot report (§10.1). */
export const PULSE_REPORT_TOOL = "pulse_report";
/** The rate cap's window: a trailing hour, not the clock hour (review answer 3). */
export const PULSE_WINDOW_MS = 3_600_000;

/** `agents.pulse_mode` (§9.7). */
export const PulseMode = z.enum(["interval", "on_idle", "hybrid", "manual"]);
export type PulseMode = z.infer<typeof PulseMode>;

/** `pulses.trigger`: which path fired the pulse. */
export const PulseTrigger = z.enum(["cron", "completion", "manual", "catchup"]);
export type PulseTrigger = z.infer<typeof PulseTrigger>;

/** `pulses.skip_reason` of a skipped pulse. `over_budget` reuses the error class's name (rule 7). */
export const PulseSkipReason = z.enum([
  "nothing_to_do",
  "rate_capped",
  "paused",
  "over_budget",
]);
export type PulseSkipReason = z.infer<typeof PulseSkipReason>;

const ms = z.int().nonnegative();

/** An agent's `pulse_*` columns and `created_at`, re-read for every decision. */
export const PulsePolicy = z.object({
  mode: PulseMode,
  intervalMs: z.int().positive(),
  debounceMs: ms,
  minGapMs: ms,
  maxPerHour: z.int().positive(),
  jitterPct: z.int().min(0).max(100),
  /** The cron anchor of an agent that has never pulsed (review M1). */
  createdAt: ms,
});
export type PulsePolicy = z.infer<typeof PulsePolicy>;

/** What the planner needs from `pulses`. "Ran" means any state but skipped, by `scheduled_at`. */
export interface PulseHistory {
  /** `scheduled_at` of the newest pulse that is not skipped(rate_capped); the cron base. */
  readonly lastAt: number | null;
  /** That pulse's id: the jitter seed. */
  readonly lastSeed: string | null;
  /** `scheduled_at` of the newest pulse that ran: the floor's base. */
  readonly lastRanAt: number | null;
  /** `scheduled_at` of the pulses that ran in the trailing hour, any order. */
  readonly ranAts: readonly number[];
}

/** Completions not yet served by a pulse. */
export interface Burst {
  readonly firstAt: number;
  readonly lastAt: number;
}

export interface Wake {
  readonly at: number;
  readonly trigger: "cron" | "completion";
}

/** FNV-1a of `seed`, mapped to [-1, 1]; 0 without a seed. Deterministic, so re-plans agree. */
export function pulseJitter(seed: string | null): number {
  if (seed === null) return 0;
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash / 0xffffffff) * 2 - 1;
}

/** A burst with one more completion at `at`. */
export const extendBurst = (burst: Burst | null, at: number): Burst =>
  burst === null
    ? { firstAt: at, lastAt: at }
    : {
        firstAt: Math.min(burst.firstAt, at),
        lastAt: Math.max(burst.lastAt, at),
      };

const inWindow = (h: PulseHistory, now: number): number[] =>
  h.ranAts.filter((t) => t > now - PULSE_WINDOW_MS && t <= now);

/** At or over `maxPerHour` pulses that ran in the trailing hour. */
export const rateCapped = (
  p: PulsePolicy,
  h: PulseHistory,
  now: number,
): boolean => inWindow(h, now).length >= p.maxPerHour;

/** The interval wake: the last pulse (else the agent's creation) plus the jittered interval. */
export function cronAt(p: PulsePolicy, h: PulseHistory): number {
  const base = h.lastAt ?? p.createdAt;
  const factor = 1 + (pulseJitter(h.lastSeed) * p.jitterPct) / 100;
  return base + Math.round(p.intervalMs * factor);
}

/** Never pulse within `minGapMs` of the last pulse that ran. */
const floorOf = (p: PulsePolicy, h: PulseHistory): number =>
  h.lastRanAt === null ? Number.NEGATIVE_INFINITY : h.lastRanAt + p.minGapMs;

/**
 * Each completion resets the debounce, but a burst never waits past the gap from its first one.
 */
const completionAt = (p: PulsePolicy, burst: Burst): number =>
  Math.min(
    burst.lastAt + p.debounceMs,
    burst.firstAt + Math.max(p.debounceMs, p.minGapMs),
  );

/**
 * The agent's next wake, or null when nothing will wake it (manual, or on_idle without a burst).
 * While capped, a pending burst still wakes once, so the lease records the breach (the window's
 * one skipped(rate_capped) row and its warning; the scheduler then drops the burst); without a
 * burst the wake is the cron one, no earlier than the moment the window has room again.
 * A cron wake that came due before the burst began was held back (a leased pulse, a parked agent):
 * the burst's wake replaces it, so the one pulse that serves both is a completion.
 */
export function nextWake(
  p: PulsePolicy,
  h: PulseHistory,
  burst: Burst | null,
  now: number,
): Wake | null {
  if (p.mode === "manual") return null;
  const floor = floorOf(p, h);
  if (rateCapped(p, h, now)) {
    if (burst !== null && p.mode !== "interval") {
      return {
        at: Math.max(completionAt(p, burst), floor),
        trigger: "completion",
      };
    }
    const roomAt = Math.min(...inWindow(h, now)) + PULSE_WINDOW_MS;
    return { at: Math.max(cronAt(p, h), roomAt, floor), trigger: "cron" };
  }
  const cron = p.mode === "on_idle" ? null : cronAt(p, h);
  const completion =
    p.mode === "interval" || burst === null ? null : completionAt(p, burst);
  const cronHeld = cron !== null && burst !== null && cron <= burst.firstAt;
  if (completion !== null && (cron === null || completion < cron || cronHeld)) {
    return { at: Math.max(completion, floor), trigger: "completion" };
  }
  return cron === null ? null : { at: Math.max(cron, floor), trigger: "cron" };
}

/**
 * The one catchup wake at boot, however long the downtime. interval: only when the cron wake is
 * overdue. on_idle/hybrid: always, to pick up what completed while down; the no-op check makes it
 * free when nothing did. manual: never.
 */
export function catchupAt(
  p: PulsePolicy,
  h: PulseHistory,
  now: number,
): number | null {
  if (p.mode === "manual") return null;
  const at = Math.max(now, floorOf(p, h));
  if (p.mode === "interval") return cronAt(p, h) <= now ? at : null;
  return at;
}
