import { err, ok, type Result } from "@bayon/core";
import { sql } from "kysely";
import { z } from "zod";
import {
  all,
  first,
  qb,
  readSnapshot,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import type { TicketEconomicsRow } from "../schema-work.js";
import {
  DAY_MS,
  baselineSpanDays,
  burnMove,
  dayStart,
  monthOf,
  percentile,
  projectMonth,
  ratioPct,
  type BurnMove,
} from "./spend-math.js";
import { pausedIn } from "./fleet-control.js";
import {
  ownTicketIds,
  projectSpendIds,
  projectTicketRows,
} from "./spend-scope.js";

// The spend roll-ups of §8.9, for GET /spend and the `spend` topic. Each read runs its dozen
// statements in one deferred read transaction (readSnapshot), so the window, alarm and today numbers
// all come from one WAL snapshot even while the supervisor commits spend rows; times are the Db's
// clock. The window is the last `spend.baseline_days` days up to now, and a trailing window is
// (now − length, now]. Every read takes a project (spend-scope.ts): undefined is the
// fleet, and adds no SQL at all.

export const ALARM_PCT_KEY = "spend.alarm_pct";
export const BASELINE_DAYS_KEY = "spend.baseline_days";
/** Used while the settings rows are absent (migration 004 seeds them: M2 contracts). */
export const SPEND_DEFAULTS: SpendSettings = {
  alarm_pct: 25,
  baseline_days: 30,
};
/** Cost per closed ticket counts delivered tickets. A rejected ticket delivered nothing. */
const CLOSED_STATUS = "done";
/** The alarm compares the last day and the last 7 days against the baseline before each. */
const ALARM_WINDOWS = { last_day: 1, last_7d: 7 } as const;

export interface SpendSettings {
  /** The alarm fires when a burn rises more than this percentage; a fall that far is a drop. */
  readonly alarm_pct: number;
  /** The days in the roll-up window, and in the alarm's baseline. */
  readonly baseline_days: number;
}

export interface SpendSummary {
  /** The roll-up window: (from, to]. */
  readonly window: { readonly from: number; readonly to: number };
  readonly total_usd: number;
  readonly wasted_usd: number;
  /** wasted ÷ total × 100 over the window, null when nothing was spent. §8.9's target is < 15. */
  readonly waste_pct: number | null;
  readonly burn: {
    /** Since the start of the UTC day. */
    readonly today_usd: number;
    readonly month_to_date_usd: number;
    readonly projected_month_usd: number;
  };
  readonly alarm: {
    readonly threshold_pct: number;
    readonly baseline_days: number;
    readonly last_day: BurnMove;
    readonly last_7d: BurnMove;
    /** Either window alarms: burn rose past the threshold (rises only). */
    readonly active: boolean;
    /** The fleet is paused, or on a project's summary that project is: a drop is expected. */
    readonly paused: boolean;
    /** Either window dropped past the threshold and nothing is paused: news, not an alarm. */
    readonly dropped: boolean;
  };
}

/** Cost per closed ticket of one complexity tier (§8.9: the number to manage). */
export interface TierSpend {
  readonly tier: string;
  readonly closed_tickets: number;
  readonly cost_p50_usd: number;
  readonly cost_p95_usd: number;
  readonly cost_total_usd: number;
  readonly review_rounds_avg: number;
  readonly handoffs_avg: number;
}

/** Tokens and cost of one run class (`spend.phase`) over the window. */
export interface ClassSpend {
  readonly run_class: string;
  readonly runs: number;
  readonly tokens_in: number;
  readonly tokens_out: number;
  readonly tokens_cache_read: number;
  readonly tokens_cache_write: number;
  /** Estimated tokens context compression kept out of the input (049; chars/4); 0 with none. */
  readonly tokens_saved: number;
  readonly cost_usd: number;
  readonly wasted_usd: number;
}

/** One UTC day of burn. */
export interface DailySpend {
  /** The day's first millisecond. */
  readonly day: number;
  readonly runs: number;
  readonly cost_usd: number;
  readonly wasted_usd: number;
  /** Estimated tokens context compression kept out of the input that day (049); 0 with none. */
  readonly tokens_saved: number;
}

export type SpendGroup = "ticket" | "tier" | "class" | "day";

/** Whose spend: one project's (`workspaceId`), else the whole fleet's. */
export interface SpendScope {
  readonly workspaceId?: string;
}

/** A project's id, or undefined for the fleet. */
type Project = string | undefined;

export type SpendReport = { readonly summary: SpendSummary } & (
  | { readonly group: "ticket"; readonly rows: TicketEconomicsRow[] }
  | { readonly group: "tier"; readonly rows: TierSpend[] }
  | { readonly group: "class"; readonly rows: ClassSpend[] }
  | { readonly group: "day"; readonly rows: DailySpend[] }
);

const SETTINGS = {
  alarm_pct: { key: ALARM_PCT_KEY, schema: z.number().positive() },
  baseline_days: { key: BASELINE_DAYS_KEY, schema: z.int().positive() },
} as const;

function setting(ix: Internals, name: keyof typeof SETTINGS): Result<number> {
  const { key, schema } = SETTINGS[name];
  const row = first(
    ix,
    qb.selectFrom("settings").select("value_json").where("key", "=", key),
  );
  if (row === undefined) return ok(SPEND_DEFAULTS[name]);
  let value: unknown;
  try {
    value = JSON.parse(row.value_json);
  } catch {
    return err(failure("internal", `${key} is not JSON`));
  }
  const parsed = schema.safeParse(value);
  return parsed.success
    ? ok(parsed.data)
    : err(
        failure(
          "internal",
          `${key} must be a positive number, not ${row.value_json}`,
        ),
      );
}

function spendSettings(ix: Internals): Result<SpendSettings> {
  const alarm_pct = setting(ix, "alarm_pct");
  if (!alarm_pct.ok) return alarm_pct;
  const baseline_days = setting(ix, "baseline_days");
  if (!baseline_days.ok) return baseline_days;
  return ok({ alarm_pct: alarm_pct.value, baseline_days: baseline_days.value });
}

/** A run's saving summed over rows that have one; a run never proxied (NULL) adds nothing. */
const savedTokens = sql<number>`total(${sql.ref("tokens_saved")})`;

const wastedCost = sql<
  number | null
>`sum(CASE WHEN ${sql.ref("wasted")} = 1 THEN ${sql.ref("cost_usd")} ELSE 0 END)`;

/** Total and wasted cost of the project's spend rows with from < ts ≤ to. */
function costBetween(
  ix: Internals,
  project: Project,
  from: number,
  to: number,
): { readonly total: number; readonly wasted: number } {
  const row = first(
    ix,
    qb
      .selectFrom("spend")
      .select((eb) => [
        eb.fn.sum<number | null>("cost_usd").as("total"),
        wastedCost.as("wasted"),
      ])
      .where("ts", ">", from)
      .where("ts", "<=", to)
      .$if(project !== undefined, (b) =>
        b.where("spend.id", "in", projectSpendIds(project ?? "")),
      ),
  );
  return { total: row?.total ?? 0, wasted: row?.wasted ?? 0 };
}

function firstSpendTs(ix: Internals, project: Project): number | null {
  const row = first(
    ix,
    qb
      .selectFrom("spend")
      .select((eb) => eb.fn.min<number | null>("ts").as("ts"))
      .$if(project !== undefined, (b) =>
        b.where("spend.id", "in", projectSpendIds(project ?? "")),
      ),
  );
  return row?.ts ?? null;
}

/** The fleet's kill switch, or on a project's summary also that project's pause. */
function pausedFor(ix: Internals, project: Project): Result<boolean> {
  const fleet = pausedIn(ix);
  if (!fleet.ok || fleet.value || project === undefined) return fleet;
  const row = first(
    ix,
    qb.selectFrom("workspaces").select("paused").where("id", "=", project),
  );
  return ok(row?.paused === 1);
}

function summary(
  ix: Internals,
  s: SpendSettings,
  project: Project,
): Result<SpendSummary> {
  const paused = pausedFor(ix, project);
  if (!paused.ok) return paused;
  const now = ix.clock.now();
  const from = now - s.baseline_days * DAY_MS;
  const window = costBetween(ix, project, from, now);
  const firstTs = firstSpendTs(ix, project);
  const move = (days: number): BurnMove => {
    const start = now - days * DAY_MS;
    const span = baselineSpanDays({
      windowStart: start,
      baselineDays: s.baseline_days,
      firstTs,
    });
    return burnMove({
      windowUsd: costBetween(ix, project, start, now).total,
      windowDays: days,
      baselineUsd: costBetween(ix, project, start - span * DAY_MS, start).total,
      baselineDays: span,
      alarmPct: s.alarm_pct,
    });
  };
  const last_day = move(ALARM_WINDOWS.last_day);
  const last_7d = move(ALARM_WINDOWS.last_7d);
  // `- 1`: costBetween's lower bound is exclusive, and these windows start at the boundary.
  const monthToDate = costBetween(
    ix,
    project,
    monthOf(now).start - 1,
    now,
  ).total;
  return ok({
    window: { from, to: now },
    total_usd: window.total,
    wasted_usd: window.wasted,
    waste_pct: ratioPct(window.wasted, window.total),
    burn: {
      today_usd: costBetween(ix, project, dayStart(now) - 1, now).total,
      month_to_date_usd: monthToDate,
      projected_month_usd: projectMonth(now, monthToDate),
    },
    alarm: {
      threshold_pct: s.alarm_pct,
      baseline_days: s.baseline_days,
      last_day,
      last_7d,
      active: last_day.alarm || last_7d.alarm,
      paused: paused.value,
      dropped: !paused.value && (last_day.drop || last_7d.drop),
    },
  });
}

/**
 * Tickets with any spend, newest first: cost, waste, rounds and hand-offs from v_ticket_economics.
 * A project's are projectTicketRows: each ticket with only the project's share of its spend.
 */
function ticketRows(ix: Internals, project: Project): TicketEconomicsRow[] {
  if (project !== undefined) return projectTicketRows(ix, project);
  return all(
    ix,
    qb
      .selectFrom("v_ticket_economics as v")
      .selectAll("v")
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("spend")
            .select("spend.id")
            .whereRef("spend.ticket_id", "=", "v.id"),
        ),
      )
      .orderBy("v.num", "desc"),
  );
}

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

/**
 * Closed tickets by tier, by tier name: cost p50/p95 (nearest rank), total, rounds, hand-offs. A
 * project's are the tickets it owns (ownTicketIds), so each closed ticket counts in one project.
 */
function tierRows(ix: Internals, project: Project): TierSpend[] {
  const rows = all(
    ix,
    qb
      .selectFrom("v_ticket_economics")
      .select(["complexity_tier", "cost_usd", "review_rounds", "handoff_count"])
      .where("status", "=", CLOSED_STATUS)
      .$if(project !== undefined, (b) =>
        b.where("v_ticket_economics.id", "in", ownTicketIds(project ?? "")),
      ),
  );
  const tiers = Map.groupBy(rows, (row) => row.complexity_tier);
  return [...tiers.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([tier, group]) => {
      const costs = group.map((row) => row.cost_usd);
      return {
        tier,
        closed_tickets: group.length,
        // A tier is here because it has a ticket, so neither percentile is null.
        cost_p50_usd: percentile(costs, 50) ?? 0,
        cost_p95_usd: percentile(costs, 95) ?? 0,
        cost_total_usd: costs.reduce((a, b) => a + b, 0),
        review_rounds_avg: mean(group.map((row) => row.review_rounds)),
        handoffs_avg: mean(group.map((row) => row.handoff_count)),
      };
    });
}

/** Tokens by run class over the window, costliest first. */
function classRows(
  ix: Internals,
  project: Project,
  from: number,
  to: number,
): ClassSpend[] {
  const rows = all(
    ix,
    qb
      .selectFrom("spend")
      .select((eb) => [
        "phase",
        eb.fn.countAll<number>().as("runs"),
        eb.fn.sum<number>("tokens_in").as("tokens_in"),
        eb.fn.sum<number>("tokens_out").as("tokens_out"),
        eb.fn.sum<number>("tokens_cache_read").as("tokens_cache_read"),
        eb.fn.sum<number>("tokens_cache_write").as("tokens_cache_write"),
        savedTokens.as("tokens_saved"),
        eb.fn.sum<number>("cost_usd").as("cost_usd"),
        wastedCost.as("wasted"),
      ])
      .where("ts", ">", from)
      .where("ts", "<=", to)
      .$if(project !== undefined, (b) =>
        b.where("spend.id", "in", projectSpendIds(project ?? "")),
      )
      .groupBy("phase")
      .orderBy("cost_usd", "desc")
      .orderBy("phase"),
  );
  return rows.map(({ phase, wasted, ...rest }) => ({
    run_class: phase,
    ...rest,
    wasted_usd: wasted ?? 0,
  }));
}

/** The last `days` UTC days up to today, oldest first; a day with no spend is a zero row. */
function dayRows(ix: Internals, project: Project, days: number): DailySpend[] {
  const now = ix.clock.now();
  const firstDay = dayStart(now) - (days - 1) * DAY_MS;
  const day = sql<number>`(${sql.ref("ts")} / ${sql.lit(DAY_MS)}) * ${sql.lit(DAY_MS)}`;
  const rows = all(
    ix,
    qb
      .selectFrom("spend")
      .select((eb) => [
        day.as("day"),
        eb.fn.countAll<number>().as("runs"),
        eb.fn.sum<number>("cost_usd").as("cost_usd"),
        wastedCost.as("wasted"),
        savedTokens.as("tokens_saved"),
      ])
      .where("ts", ">=", firstDay)
      .where("ts", "<=", now)
      .$if(project !== undefined, (b) =>
        b.where("spend.id", "in", projectSpendIds(project ?? "")),
      )
      .groupBy("day"),
  );
  const byDay = new Map(rows.map((row) => [row.day, row]));
  return Array.from({ length: days }, (_, i) => {
    const start = firstDay + i * DAY_MS;
    const row = byDay.get(start);
    return {
      day: start,
      runs: row?.runs ?? 0,
      cost_usd: row?.cost_usd ?? 0,
      wasted_usd: row?.wasted ?? 0,
      tokens_saved: row?.tokens_saved ?? 0,
    };
  });
}

/** The summary alone: what the `spend` topic sends. Always the fleet's. */
export async function getSpendSummary(db: Db): R<SpendSummary> {
  const got = await readSnapshot(db, (ix): Result<SpendSummary> => {
    const s = spendSettings(ix);
    return s.ok ? summary(ix, s.value, undefined) : s;
  });
  return got.ok ? got.value : got;
}

/**
 * `GET /spend?group=&project=`: the summary and one grouping's rows, from one snapshot. With a
 * project every figure is that project's, the summary included: its today and window totals are the
 * IDE's headline. An unknown project is zeros and empty rows, never an error.
 */
export async function getSpendReport(
  db: Db,
  group: SpendGroup,
  scope: SpendScope = {},
): R<SpendReport> {
  const project = scope.workspaceId;
  const got = await readSnapshot(db, (ix): Result<SpendReport> => {
    const s = spendSettings(ix);
    if (!s.ok) return s;
    const got = summary(ix, s.value, project);
    if (!got.ok) return got;
    const head = got.value;
    const { from, to } = head.window;
    switch (group) {
      case "ticket":
        return ok({ group, summary: head, rows: ticketRows(ix, project) });
      case "tier":
        return ok({ group, summary: head, rows: tierRows(ix, project) });
      case "class":
        return ok({
          group,
          summary: head,
          rows: classRows(ix, project, from, to),
        });
      case "day":
        return ok({
          group,
          summary: head,
          rows: dayRows(ix, project, s.value.baseline_days),
        });
    }
  });
  return got.ok ? got.value : got;
}
