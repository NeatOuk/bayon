import { FakeClock, ok } from "@bayon/core";
import { afterAll, describe, expect, test } from "vitest";
import { execute, qb, write, type Db } from "../connection.js";
import {
  SPINE_SEED,
  newRunInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "../testing.js";
import { getSettings } from "./config.js";
import { setFleetPaused } from "./fleet-control.js";
import { appendRun } from "./runs.js";
import { insertSpend } from "./spend.js";
import { DAY_MS } from "./spend-math.js";
import {
  ALARM_PCT_KEY,
  BASELINE_DAYS_KEY,
  getSpendReport,
  getSpendSummary,
  type SpendGroup,
  type SpendReport,
} from "./spend-rollups.js";

const NOW = Date.UTC(2026, 8, 13, 10); // Sunday 13 September 2026, 10:00 UTC
const TODAY = Date.UTC(2026, 8, 13);
const HOUR = 60 * 60_000;

const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function fresh(): Promise<Db> {
  const t = unwrap(await tempDb(new FakeClock(NOW)));
  cleanups.push(t.cleanup);
  unwrap(await seedSpine(t.db, 2));
  return t.db;
}

interface Spend {
  readonly cost: number;
  readonly ts: number;
  readonly ticket?: string;
  readonly phase?: string;
  readonly wasted?: 0 | 1;
  readonly tokens?: number;
  /** The run's estimated saving from context compression (049); absent: not proxied. */
  readonly saved?: number;
}

/** One run of the seeded session and its spend row. */
async function spend(db: Db, s: Spend): Promise<void> {
  const run = unwrap(await appendRun(db, newRunInput(SPINE_SEED.sessionId)));
  const tokens = s.tokens ?? 0;
  unwrap(
    await insertSpend(db, {
      run_id: run.id,
      session_id: SPINE_SEED.sessionId,
      ticket_id: s.ticket ?? null,
      phase: s.phase ?? "build",
      runner_id: SPINE_SEED.runnerId,
      model: "model-a",
      tokens_in: tokens,
      tokens_out: tokens * 2,
      tokens_cache_read: tokens * 3,
      tokens_cache_write: tokens * 4,
      ...(s.saved === undefined ? {} : { tokens_saved: s.saved }),
      cost_usd: s.cost,
      cost_source: "reported",
      wasted: s.wasted ?? 0,
      ts: s.ts,
    }),
  );
}

/** Sets a settings row; 004 seeds the spend.* keys, so this upserts. */
async function setting(db: Db, key: string, value: unknown): Promise<void> {
  const value_json = JSON.stringify(value);
  unwrap(
    await write(db, (ix) => {
      execute(
        ix,
        qb
          .insertInto("settings")
          .values({ key, value_json, updated_at: NOW })
          .onConflict((oc) =>
            oc.column("key").doUpdateSet({ value_json, updated_at: NOW }),
          ),
      );
      return ok(undefined);
    }),
  );
}

/** Deletes a settings row, as on a database from before 004. */
async function dropSetting(db: Db, key: string): Promise<void> {
  unwrap(
    await write(db, (ix) => {
      execute(ix, qb.deleteFrom("settings").where("key", "=", key));
      return ok(undefined);
    }),
  );
}

type RowsOf<G extends SpendGroup> = Extract<SpendReport, { group: G }>["rows"];

/** The group's rows. The expect checks the discriminant the cast relies on. */
async function rowsOf<G extends SpendGroup>(
  db: Db,
  group: G,
): Promise<RowsOf<G>> {
  const report = unwrap(await getSpendReport(db, group));
  expect(report.group).toBe(group);
  return report.rows as unknown as RowsOf<G>;
}

describe("an empty ledger", () => {
  test("the summary is zeros and nulls, with the default settings", async () => {
    const db = await fresh();
    const quiet = {
      daily_usd: 0,
      baseline_daily_usd: null,
      change_pct: null,
      alarm: false,
      drop: false,
    };
    expect(unwrap(await getSpendSummary(db))).toEqual({
      window: { from: NOW - 30 * DAY_MS, to: NOW },
      total_usd: 0,
      wasted_usd: 0,
      waste_pct: null,
      burn: { today_usd: 0, month_to_date_usd: 0, projected_month_usd: 0 },
      alarm: {
        threshold_pct: 25,
        baseline_days: 30,
        last_day: quiet,
        last_7d: quiet,
        active: false,
        paused: false,
        dropped: false,
      },
    });
  });

  test("every grouping is empty, except 30 zero days", async () => {
    const db = await fresh();
    expect(await rowsOf(db, "ticket")).toEqual([]);
    expect(await rowsOf(db, "tier")).toEqual([]);
    expect(await rowsOf(db, "class")).toEqual([]);
    const days = await rowsOf(db, "day");
    expect(days).toHaveLength(30);
    expect(days[0]).toEqual({
      day: TODAY - 29 * DAY_MS,
      runs: 0,
      cost_usd: 0,
      wasted_usd: 0,
      tokens_saved: 0,
    });
    expect(days.at(-1)?.day).toBe(TODAY);
    expect(days.every((d) => d.cost_usd === 0 && d.runs === 0)).toBe(true);
  });
});

describe("window roll-ups", () => {
  async function seeded(): Promise<Db> {
    const db = await fresh();
    await spend(db, {
      cost: 3,
      ts: NOW,
      phase: "build",
      tokens: 10,
      saved: 700,
    });
    await spend(db, {
      cost: 1,
      ts: TODAY,
      phase: "review",
      wasted: 1,
      tokens: 1,
      saved: 20,
    });
    await spend(db, {
      cost: 2,
      ts: TODAY - HOUR,
      phase: "build",
      wasted: 1,
      tokens: 5,
    });
    await spend(db, { cost: 4, ts: NOW - 29 * DAY_MS, phase: "review" });
    // Outside the window: 30 days ago exactly (the bound is exclusive), and the future.
    await spend(db, {
      cost: 100,
      ts: NOW - 30 * DAY_MS,
      phase: "build",
      wasted: 1,
    });
    await spend(db, { cost: 100, ts: NOW + 1, phase: "build" });
    return db;
  }

  test("waste % is wasted over total within the window", async () => {
    const s = unwrap(await getSpendSummary(await seeded()));
    expect(s.total_usd).toBe(10);
    expect(s.wasted_usd).toBe(3);
    expect(s.waste_pct).toBeCloseTo(30);
  });

  test("tokens by run class, costliest first", async () => {
    expect(await rowsOf(await seeded(), "class")).toEqual([
      {
        run_class: "build",
        runs: 2,
        tokens_in: 15,
        tokens_out: 30,
        tokens_cache_read: 45,
        tokens_cache_write: 60,
        tokens_saved: 700,
        cost_usd: 5,
        wasted_usd: 2,
      },
      {
        run_class: "review",
        runs: 2,
        tokens_in: 1,
        tokens_out: 2,
        tokens_cache_read: 3,
        tokens_cache_write: 4,
        tokens_saved: 20,
        cost_usd: 5,
        wasted_usd: 1,
      },
    ]);
  });

  test("daily burn buckets by UTC day, midnight into its own day", async () => {
    const days = await rowsOf(await seeded(), "day");
    expect(days.at(-1)).toEqual({
      day: TODAY,
      runs: 2,
      cost_usd: 4,
      wasted_usd: 1,
      tokens_saved: 720,
    });
    expect(days.at(-2)).toEqual({
      day: TODAY - DAY_MS,
      runs: 1,
      cost_usd: 2,
      wasted_usd: 2,
      tokens_saved: 0,
    });
    expect(days[0]).toEqual({
      day: TODAY - 29 * DAY_MS,
      runs: 1,
      cost_usd: 4,
      wasted_usd: 0,
      tokens_saved: 0,
    });
    const sum = days.reduce((a, d) => a + d.cost_usd, 0);
    expect(sum).toBe(10);
  });

  test("today, month-to-date and a straight-line month projection", async () => {
    const s = unwrap(await getSpendSummary(await seeded()));
    expect(s.burn.today_usd).toBe(4);
    // From 1 September: the rows of 12 and 13 September.
    expect(s.burn.month_to_date_usd).toBe(6);
    const elapsed = NOW - Date.UTC(2026, 8, 1);
    expect(s.burn.projected_month_usd).toBeCloseTo((6 * 30 * DAY_MS) / elapsed);
  });
});

describe("cost per closed ticket, rounds and hand-offs", () => {
  async function seeded(): Promise<Db> {
    const db = await fresh();
    unwrap(
      await seedRows(db, {
        tickets: [
          ticketRow(1, { status: "done", complexity_tier: "standard" }),
          ticketRow(2, { status: "done", complexity_tier: "standard" }),
          ticketRow(3, { status: "done", complexity_tier: "standard" }),
          ticketRow(4, { status: "done", complexity_tier: "standard" }),
          ticketRow(5, { status: "done", complexity_tier: "complex" }),
          ticketRow(6, { status: "building", complexity_tier: "standard" }),
          ticketRow(7, { status: "rejected", complexity_tier: "standard" }),
          ticketRow(8, { status: "backlog" }),
        ],
        gates: [1, 2].map((attempt) => ({
          id: `gate-${attempt}`,
          ticket_id: "ticket-1",
          kind: "code_review" as const,
          state: "failed",
          attempt,
          subject_kind: "diff",
          subject_ref: `sha-${attempt}`,
        })),
        handoffs: [
          {
            id: "handoff-1",
            ticket_id: "ticket-1",
            reason: "turn_ceiling",
            facts_json: "{}",
            packet_path: "/tmp/handoff-1.md",
            packet_hash: "0".repeat(64),
            created_at: NOW,
          },
        ],
      }),
    );
    const costs: readonly [string, number][] = [
      ["ticket-1", 1],
      ["ticket-2", 2],
      ["ticket-3", 3],
      ["ticket-4", 4],
      ["ticket-5", 10],
      ["ticket-6", 100],
      ["ticket-7", 50],
    ];
    for (const [ticket, cost] of costs) {
      await spend(db, { cost, ts: NOW - DAY_MS, ticket });
    }
    // A second, wasted row on ticket 1: its cost is 1 + 0.5.
    await spend(db, { cost: 0.5, ts: NOW, ticket: "ticket-1", wasted: 1 });
    return db;
  }

  test("by tier: nearest-rank p50/p95 over done tickets only", async () => {
    expect(await rowsOf(await seeded(), "tier")).toEqual([
      {
        tier: "complex",
        closed_tickets: 1,
        cost_p50_usd: 10,
        cost_p95_usd: 10,
        cost_total_usd: 10,
        review_rounds_avg: 0,
        handoffs_avg: 0,
      },
      {
        tier: "standard",
        closed_tickets: 4,
        cost_p50_usd: 2,
        cost_p95_usd: 4,
        cost_total_usd: 10.5,
        review_rounds_avg: 0.5,
        handoffs_avg: 0.25,
      },
    ]);
  });

  test("by ticket: every ticket with spend, newest first", async () => {
    const rows = await rowsOf(await seeded(), "ticket");
    expect(rows.map((r) => r.num)).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect(rows.at(-1)).toMatchObject({
      id: "ticket-1",
      status: "done",
      complexity_tier: "standard",
      cost_usd: 1.5,
      cost_wasted_usd: 0.5,
      review_rounds: 2,
      handoff_count: 1,
    });
  });
});

describe("settings rows", () => {
  test("the rows 004 seeds are what the summary reads when untouched", async () => {
    const db = await fresh();
    const seeded = unwrap(
      await getSettings(db, [ALARM_PCT_KEY, BASELINE_DAYS_KEY]),
    );
    expect(Object.fromEntries(seeded)).toEqual({
      [ALARM_PCT_KEY]: 25,
      [BASELINE_DAYS_KEY]: 30,
    });
    const { alarm, window } = unwrap(await getSpendSummary(db));
    expect(alarm).toMatchObject({ threshold_pct: 25, baseline_days: 30 });
    expect(window.from).toBe(NOW - 30 * DAY_MS);
  });

  test("absent rows fall back to the defaults, never an error", async () => {
    const db = await fresh();
    await dropSetting(db, ALARM_PCT_KEY);
    await dropSetting(db, BASELINE_DAYS_KEY);
    const { alarm } = unwrap(await getSpendSummary(db));
    expect(alarm).toMatchObject({ threshold_pct: 25, baseline_days: 30 });
  });
});

describe("the burn alarm", () => {
  /** $10 a day for the 30 days before the last one: each day's row mid-day. */
  async function steady(lastDayUsd: readonly number[]): Promise<Db> {
    const db = await fresh();
    for (let k = 1; k <= 30; k += 1) {
      await spend(db, { cost: 10, ts: NOW - k * DAY_MS - 12 * HOUR });
    }
    for (const cost of lastDayUsd) {
      await spend(db, { cost, ts: NOW - HOUR });
    }
    return db;
  }

  test("a last day exactly 25 % over the baseline does not alarm", async () => {
    const { alarm } = unwrap(await getSpendSummary(await steady([12.5])));
    expect(alarm.last_day).toEqual({
      daily_usd: 12.5,
      baseline_daily_usd: 10,
      change_pct: 25,
      alarm: false,
      drop: false,
    });
    expect(alarm.active).toBe(false);
  });

  test("a last day just over 25 % alarms; the 7-day mean stays quiet", async () => {
    const { alarm } = unwrap(await getSpendSummary(await steady([12.5, 0.1])));
    expect(alarm.last_day.alarm).toBe(true);
    expect(alarm.last_day.change_pct).toBeCloseTo(26);
    // (6 × $10 + $12.60) ÷ 7 against the 24 days of baseline before the window.
    expect(alarm.last_7d.baseline_daily_usd).toBe(10);
    expect(alarm.last_7d.daily_usd).toBeCloseTo(72.6 / 7);
    expect(alarm.last_7d.alarm).toBe(false);
    expect(alarm.active).toBe(true);
  });

  test("a drop never alarms: nothing spent in the last day is a drop", async () => {
    const { alarm } = unwrap(await getSpendSummary(await steady([])));
    expect(alarm.last_day).toMatchObject({
      change_pct: -100,
      alarm: false,
      drop: true,
    });
    expect(alarm).toMatchObject({
      active: false,
      paused: false,
      dropped: true,
    });
  });

  test("while the fleet is paused a drop is expected: not reported", async () => {
    const db = await steady([]);
    unwrap(
      await setFleetPaused(db, {
        paused: true,
        actor: "operator",
        via: "rest",
      }),
    );
    for (const { alarm } of [
      unwrap(await getSpendSummary(db)),
      unwrap(await getSpendReport(db, "day")).summary,
    ]) {
      expect(alarm.last_day.drop).toBe(true);
      expect(alarm).toMatchObject({
        active: false,
        paused: true,
        dropped: false,
      });
    }
  });

  test("a paused fleet still alarms on a rise", async () => {
    const db = await steady([12.5, 0.1]);
    unwrap(
      await setFleetPaused(db, {
        paused: true,
        actor: "operator",
        via: "rest",
      }),
    );
    const { alarm } = unwrap(await getSpendSummary(db));
    expect(alarm).toMatchObject({ active: true, paused: true });
  });

  test("the settings rows override the defaults", async () => {
    const db = await steady([12.5, 0.1]);
    await setting(db, ALARM_PCT_KEY, 50);
    await setting(db, BASELINE_DAYS_KEY, 10);
    const s = unwrap(await getSpendSummary(db));
    expect(s.window.from).toBe(NOW - 10 * DAY_MS);
    // +26 % over the last day is within 50 %; both baselines are the 10 days before each window.
    expect(s.alarm).toMatchObject({
      threshold_pct: 50,
      baseline_days: 10,
      active: false,
    });
    expect(s.alarm.last_day).toMatchObject({
      baseline_daily_usd: 10,
      alarm: false,
    });
    expect(s.alarm.last_7d).toMatchObject({
      baseline_daily_usd: 10,
      alarm: false,
    });
    expect(await rowsOf(db, "day")).toHaveLength(10);
  });

  test.each([
    [BASELINE_DAYS_KEY, 2.5],
    [BASELINE_DAYS_KEY, 0],
    [ALARM_PCT_KEY, -1],
    [ALARM_PCT_KEY, "25"],
  ])(
    "%s = %j is an internal error, never a silent default",
    async (key, value) => {
      const db = await fresh();
      await setting(db, key, value);
      for (const got of [
        await getSpendSummary(db),
        await getSpendReport(db, "day"),
      ]) {
        expect(got.ok).toBe(false);
        if (!got.ok) expect(got.error.class).toBe("internal");
      }
    },
  );
});
