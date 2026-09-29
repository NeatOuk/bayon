import { ExecutorHealthFields, err, ok, type Result } from "@bayon/core";
import { z } from "zod";
import {
  all,
  first,
  qb,
  read,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import type { BackupOutcome } from "../schema-fleet.js";
import { budgetsIn, type BudgetStatus } from "./budgets.js";
import { pausedIn } from "./fleet-control.js";
import {
  openRunnerUpdatesIn,
  type OpenRunnerUpdate,
} from "./runner-updates.js";

// What the Fleet shows beside v_fleet (§12.3, amendment 8): today's spend against the daily cap,
// busy slots per executor, and the sessions that need attention. Every time is the Db's clock.

/** Amendment 8 (§4.1 v_needs_attention): a running or idle session this long without an event. */
export const STALE_AFTER_MS = 30 * 60_000;
/** Amendment 8: how long an error exit stays on the attention strip. */
export const ERRORED_WITHIN_MS = 24 * 60 * 60_000;
/** The settings key of the daily cap; its seeded value is null, meaning no cap. */
export const DAILY_CAP_KEY = "budget.daily_cap_usd";

const DAY_MS = 24 * 60 * 60_000;

export interface FleetBudget {
  /** Sum of `spend.cost_usd` since the start of the current UTC day. */
  readonly today_usd: number;
  readonly daily_cap_usd: number | null;
}

export interface ExecutorSlots {
  readonly executor_id: string;
  /** Live (v_fleet) sessions on it. */
  readonly busy: number;
  /** `executors.slots`. */
  readonly capacity: number;
}

export interface AttentionItem {
  readonly session_id: string;
  readonly agent: string;
  readonly why: "stale" | "errored";
  /** Stale: the last event. Errored: the exit. */
  readonly since: number;
  /** Errored: `sessions.error_message`. */
  readonly detail: string | null;
}

/** An enabled executor's free disk as its last health check measured it (§6.1). */
export interface ExecutorDisk {
  readonly executor_id: string;
  /** The lowest free % over the paths it measured; null when it measured none (or never ran). */
  readonly free_pct: number | null;
  /** The floor that check judged against. */
  readonly min_free_pct: number | null;
  /** `executors.health_checked_at`. */
  readonly checked_at: number | null;
}

/** A pending session admission is holding. */
export interface QueuedSession {
  readonly session_id: string;
  readonly agent: string;
  readonly executor_id: string;
  /** `sessions.queued_reason`: a core QueuedReason; the wire schema parses it. */
  readonly reason: string;
  /** Pending since: the session's created_at. */
  readonly since: number;
}

/** `GET /fleet`'s admission block: queued sessions, oldest first, and a count by reason. */
export interface FleetAdmission {
  readonly queued: QueuedSession[];
  readonly by_reason: Readonly<Record<string, number>>;
}

/** A finished backup attempt, as `GET /fleet` shows it. */
export interface BackupAttempt {
  readonly outcome: BackupOutcome;
  readonly started_at: number;
  readonly ended_at: number;
  /** The encrypted file an ok attempt wrote. */
  readonly path: string | null;
  /** Why a failed attempt failed. */
  readonly error: string | null;
}

/** `GET /fleet`'s backup block (§13.2, M4 §12.1): the newest attempt and the last good one. */
export interface FleetBackup {
  readonly last: BackupAttempt | null;
  readonly last_ok_at: number | null;
}

export interface FleetOverview {
  /** `fleet.paused` (the kill switch). */
  readonly paused: boolean;
  /** Amendment 8's daily cap; `budgets` is §13.4's full set, spend computed at read time. */
  readonly budget: FleetBudget;
  readonly budgets: BudgetStatus[];
  readonly slots: ExecutorSlots[];
  readonly attention: AttentionItem[];
  readonly disk: ExecutorDisk[];
  readonly admission: FleetAdmission;
  readonly backup: FleetBackup;
  /** Open runner update checks: a newer release, not dismissed. */
  readonly runner_updates: OpenRunnerUpdate[];
}

/** A finite non-negative number, or null for no cap; shared with budget.ts's writer. */
export const DailyCap = z.number().nonnegative().nullable();

/** The daily cap inside a transaction; staffTicket refuses at it (amendment f). */
export function dailyCap(ix: Internals): Result<number | null> {
  const row = first(
    ix,
    qb
      .selectFrom("settings")
      .select("value_json")
      .where("key", "=", DAILY_CAP_KEY),
  );
  if (row === undefined) return ok(null);
  let value: unknown;
  try {
    value = JSON.parse(row.value_json);
  } catch {
    return err(failure("internal", `${DAILY_CAP_KEY} is not JSON`));
  }
  const cap = DailyCap.safeParse(value);
  return cap.success
    ? ok(cap.data)
    : err(
        failure(
          "internal",
          `${DAILY_CAP_KEY} must be a non-negative number or null`,
        ),
      );
}

/** Spend since the start of `now`'s UTC day. Exported: the pulse gate reads it too. */
export function todayUsd(ix: Internals, now: number): number {
  const dayStart = now - (now % DAY_MS); // epoch millis are UTC
  const row = first(
    ix,
    qb
      .selectFrom("spend")
      .select((eb) => eb.fn.sum<number | null>("cost_usd").as("total"))
      .where("ts", ">=", dayStart)
      .where("ts", "<", dayStart + DAY_MS),
  );
  return row?.total ?? 0;
}

/** Enabled executors, plus any disabled one that still has live sessions. */
function executorSlots(ix: Internals): ExecutorSlots[] {
  const rows = all(
    ix,
    qb
      .selectFrom("executors as e")
      .leftJoin("v_fleet as f", "f.executor_id", "e.id")
      .select((eb) => [
        "e.id as executor_id",
        "e.slots as capacity",
        "e.enabled",
        eb.fn.count<number>("f.id").as("busy"),
      ])
      .groupBy("e.id")
      .orderBy("e.id"),
  );
  return rows
    .filter((row) => row.enabled === 1 || row.busy > 0)
    .map(({ executor_id, busy, capacity }) => ({
      executor_id,
      busy,
      capacity,
    }));
}

function attention(ix: Internals, now: number): AttentionItem[] {
  const errored = all(
    ix,
    qb
      .selectFrom("sessions as s")
      .innerJoin("agents as a", "a.id", "s.agent_id")
      // An error the operator has dismissed stays gone, rather than sitting here for its full
      // ERRORED_WITHIN_MS. Only error exits are dismissible, so only this half joins.
      .leftJoin("attention_acks as ack", "ack.session_id", "s.id")
      .select([
        "s.id as session_id",
        "a.name as agent",
        "s.ended_at",
        "s.error_message",
      ])
      .where("s.state", "=", "exited")
      .where("s.exit_reason", "=", "error")
      .where("s.ended_at", ">=", now - ERRORED_WITHIN_MS)
      .where("ack.session_id", "is", null)
      .orderBy("s.ended_at", "desc")
      .orderBy("s.id"),
  );
  const stale = all(
    ix,
    qb
      .selectFrom("sessions as s")
      .innerJoin("agents as a", "a.id", "s.agent_id")
      .select(["s.id as session_id", "a.name as agent", "s.last_event_at"])
      .where("s.state", "in", ["running", "idle"])
      .where("s.last_event_at", "<", now - STALE_AFTER_MS)
      .orderBy("s.last_event_at")
      .orderBy("s.id"),
  );
  return [
    ...errored.flatMap((r): AttentionItem[] =>
      r.ended_at === null
        ? []
        : [
            {
              session_id: r.session_id,
              agent: r.agent,
              why: "errored",
              since: r.ended_at,
              detail: r.error_message,
            },
          ],
    ),
    ...stale.flatMap((r): AttentionItem[] =>
      r.last_event_at === null
        ? []
        : [
            {
              session_id: r.session_id,
              agent: r.agent,
              why: "stale",
              since: r.last_event_at,
              detail: null,
            },
          ],
    ),
  ];
}

/** The two health_detail fields the Fleet shows; a detail without them is no measurement. */
const DiskFields = ExecutorHealthFields.pick({
  free_pct: true,
  min_free_pct: true,
});

function diskFields(detail: string | null): z.infer<typeof DiskFields> | null {
  if (detail === null) return null;
  try {
    const parsed = DiskFields.safeParse(JSON.parse(detail));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Each enabled executor's disk from its last health check (the detail every kind reports). */
function executorDisk(ix: Internals): ExecutorDisk[] {
  const rows = all(
    ix,
    qb
      .selectFrom("executors")
      .select(["id", "health_detail", "health_checked_at"])
      .where("enabled", "=", 1)
      .orderBy("id"),
  );
  return rows.map((r) => {
    const d = diskFields(r.health_detail);
    return {
      executor_id: r.id,
      free_pct: d?.free_pct ?? null,
      min_free_pct: d?.min_free_pct ?? null,
      checked_at: r.health_checked_at,
    };
  });
}

/** Pending sessions with a queued_reason; an ended row keeps its reason but is not listed. */
function admission(ix: Internals): FleetAdmission {
  const rows = all(
    ix,
    qb
      .selectFrom("sessions as s")
      .innerJoin("agents as a", "a.id", "s.agent_id")
      .select([
        "s.id as session_id",
        "a.name as agent",
        "s.executor_id",
        "s.queued_reason",
        "s.created_at",
      ])
      .where("s.state", "=", "pending")
      .where("s.queued_reason", "is not", null)
      .orderBy("s.created_at")
      .orderBy("s.id"),
  );
  const queued = rows.flatMap((r): QueuedSession[] =>
    r.queued_reason === null
      ? []
      : [
          {
            session_id: r.session_id,
            agent: r.agent,
            executor_id: r.executor_id,
            reason: r.queued_reason,
            since: r.created_at,
          },
        ],
  );
  const by_reason = queued.reduce<Readonly<Record<string, number>>>(
    (counts, q) => ({ ...counts, [q.reason]: (counts[q.reason] ?? 0) + 1 }),
    {},
  );
  return { queued, by_reason };
}

/** The newest backup attempt (the one backup_failed keys on) and when one last succeeded. */
function fleetBackup(ix: Internals): FleetBackup {
  const last = first(
    ix,
    qb
      .selectFrom("backups")
      .select(["outcome", "started_at", "ended_at", "path", "error"])
      .orderBy("ended_at", "desc")
      .orderBy("id", "desc"),
  );
  const good = first(
    ix,
    qb
      .selectFrom("backups")
      .select((eb) => eb.fn.max<number | null>("ended_at").as("at"))
      .where("outcome", "=", "ok"),
  );
  return { last: last ?? null, last_ok_at: good?.at ?? null };
}

/**
 * Budget, slots, attention, admission, disk and backup for `GET /fleet` and the `fleet` topic, in
 * one read.
 */
export async function getFleetOverview(db: Db): R<FleetOverview> {
  const got = await read(db, (ix): Result<FleetOverview> => {
    const now = ix.clock.now();
    const cap = dailyCap(ix);
    if (!cap.ok) return cap;
    const paused = pausedIn(ix);
    if (!paused.ok) return paused;
    return ok({
      paused: paused.value,
      budget: { today_usd: todayUsd(ix, now), daily_cap_usd: cap.value },
      budgets: budgetsIn(ix),
      slots: executorSlots(ix),
      attention: attention(ix, now),
      disk: executorDisk(ix),
      admission: admission(ix),
      backup: fleetBackup(ix),
      runner_updates: openRunnerUpdatesIn(ix),
    });
  });
  return got.ok ? got.value : got;
}
