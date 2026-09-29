import { FakeClock } from "@bayon/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { all, read, type Db } from "../connection.js";
import {
  SPINE_SEED,
  newRunInput,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
  type TempDb,
} from "../testing.js";
import { setFleetPaused } from "./fleet-control.js";
import { setProjectPaused } from "./project-pause.js";
import { appendRun } from "./runs.js";
import { insertSpend } from "./spend.js";
import { DAY_MS } from "./spend-math.js";
import {
  getSpendReport,
  type SpendGroup,
  type SpendReport,
  type SpendScope,
} from "./spend-rollups.js";
import { projectSpendIds } from "./spend-scope.js";

// GET /spend?project=: a spend row's project is its ticket's, else its session's, else
// that session's agent's, else its pulse's agent's. Every grouping and the summary read only the
// project's rows; the fleet's read is unchanged (spend-rollups.test.ts pins it).

const NOW = Date.UTC(2026, 8, 13, 10); // 10:00 UTC
const TODAY = Date.UTC(2026, 8, 13);

let t: TempDb;
let db: Db;
beforeAll(async () => {
  t = unwrap(await tempDb(new FakeClock(NOW)));
  db = t.db;
  unwrap(await seedSpine(db, 3));
  const agent = (id: string, workspace_id: string) => ({
    id,
    name: id,
    kind: "builder" as const,
    runner_id: SPINE_SEED.runnerId,
    workspace_id,
    created_at: 0,
  });
  const session = (id: string, agent_id: string, workspace_id?: string) => ({
    ...newSessionInput(),
    id,
    agent_id,
    state: "idle" as const,
    created_at: 0,
    ...(workspace_id === undefined ? {} : { workspace_id }),
  });
  unwrap(
    await seedRows(db, {
      workspaces: [
        { id: "shop", name: "shop", kind: "single" },
        { id: "blog", name: "blog", kind: "single" },
      ],
      agents: [agent("shop-builder", "shop"), agent("blog-builder", "blog")],
      tickets: [
        ticketRow(1, { workspace_id: "shop", status: "done" }),
        ticketRow(2, {
          workspace_id: "blog",
          status: "done",
          complexity_tier: "complex",
        }),
        // No project: it shows under shop's tickets (U below), never in a project's tiers.
        ticketRow(3, { status: "done" }),
        // shop's, closed, and never spent on: still a closed ticket of shop's.
        ticketRow(4, { workspace_id: "shop", status: "done" }),
        ticketRow(5, { workspace_id: "shop", status: "building" }),
      ],
      sessions: [
        session("s-shop", "shop-builder"),
        session("s-blog", "blog-builder"),
        // The fleet's agent, placed in shop.
        session("s-placed", SPINE_SEED.agentId, "shop"),
      ],
      pulses: [
        {
          id: "p-shop",
          agent_id: "shop-builder",
          trigger: "manual",
          scheduled_at: NOW,
          state: "done",
        },
      ],
    }),
  );
  const rows: readonly (readonly [
    string,
    string,
    {
      readonly cost: number;
      readonly ts: number;
      readonly ticket?: string;
      readonly pulse?: string;
      readonly phase?: string;
      readonly wasted?: 0 | 1;
    },
  ])[] = [
    ["A-ticket", "s-shop", { cost: 3, ts: NOW - 1_000, ticket: "ticket-1" }],
    [
      "A-wasted",
      "s-shop",
      {
        cost: 1.5,
        ts: NOW - 2 * DAY_MS,
        ticket: "ticket-1",
        phase: "review",
        wasted: 1,
      },
    ],
    // No ticket: the session's agent's project.
    ["A-agent", "s-shop", { cost: 0.5, ts: NOW - 4_000, phase: "pulse" }],
    // No ticket, an agent with no project: the session's own.
    ["A-session", "s-placed", { cost: 0.25, ts: NOW - 5 * DAY_MS }],
    // No ticket, a fleet session and agent: the pulse's agent's.
    [
      "A-pulse",
      SPINE_SEED.sessionId,
      { cost: 4, ts: NOW - 6_000, pulse: "p-shop", phase: "pulse" },
    ],
    // A ticket with no project: the session's agent's.
    [
      "A-unscoped",
      "s-shop",
      { cost: 0.75, ts: NOW - 8_000, ticket: "ticket-3" },
    ],
    ["B-ticket", "s-blog", { cost: 7, ts: NOW - 3_000, ticket: "ticket-2" }],
    [
      "B-old",
      "s-blog",
      { cost: 2, ts: NOW - 10 * DAY_MS, ticket: "ticket-2", phase: "plan" },
    ],
    // shop's session on blog's ticket: the ticket wins.
    ["B-over", "s-shop", { cost: 0.8, ts: NOW - 9_000, ticket: "ticket-2" }],
    // In no project.
    ["F-fleet", SPINE_SEED.sessionId, { cost: 9, ts: NOW - 7_000 }],
  ];
  for (const [id, sessionId, s] of rows) {
    const run = unwrap(await appendRun(db, newRunInput(sessionId)));
    unwrap(
      await insertSpend(db, {
        id,
        run_id: run.id,
        session_id: sessionId,
        ticket_id: s.ticket ?? null,
        pulse_id: s.pulse ?? null,
        phase: s.phase ?? "build",
        runner_id: SPINE_SEED.runnerId,
        model: "model-a",
        tokens_in: 10,
        tokens_out: 20,
        tokens_cache_read: 30,
        tokens_cache_write: 40,
        cost_usd: s.cost,
        cost_source: "reported",
        wasted: s.wasted ?? 0,
        ts: s.ts,
      }),
    );
  }
});
afterAll(() => t.cleanup());

const SHOP: SpendScope = { workspaceId: "shop" };
const BLOG: SpendScope = { workspaceId: "blog" };
const NOWHERE: SpendScope = { workspaceId: "nowhere" };

type RowsOf<G extends SpendGroup> = Extract<SpendReport, { group: G }>["rows"];

async function rowsOf<G extends SpendGroup>(
  group: G,
  scope?: SpendScope,
): Promise<RowsOf<G>> {
  const report = unwrap(await getSpendReport(db, group, scope));
  expect(report.group).toBe(group);
  return report.rows as unknown as RowsOf<G>;
}

const spendIds = async (workspaceId: string) =>
  unwrap(
    await read(db, (ix) =>
      all(ix, projectSpendIds(workspaceId).orderBy("ps.id")),
    ),
  ).map((row) => row.id);

describe("a spend row's project", () => {
  test("its ticket's, else its session's, else the session's agent's, else its pulse's agent's", async () => {
    expect(await spendIds("shop")).toEqual([
      "A-agent",
      "A-pulse",
      "A-session",
      "A-ticket",
      "A-unscoped",
      "A-wasted",
    ]);
    expect(await spendIds("blog")).toEqual(["B-old", "B-over", "B-ticket"]);
    expect(await spendIds("nowhere")).toEqual([]);
  });
});

describe("the summary", () => {
  test("is the project's own: its today and window totals are the headline", async () => {
    const shop = unwrap(await getSpendReport(db, "day", SHOP)).summary;
    expect(shop.total_usd).toBeCloseTo(10);
    expect(shop.wasted_usd).toBeCloseTo(1.5);
    expect(shop.burn.today_usd).toBeCloseTo(8.25);
    const blog = unwrap(await getSpendReport(db, "day", BLOG)).summary;
    expect(blog.total_usd).toBeCloseTo(9.8);
    expect(blog.burn.today_usd).toBeCloseTo(7.8);
  });

  test("the projects and the rows in none add up to the fleet", async () => {
    const total = async (scope?: SpendScope) =>
      unwrap(await getSpendReport(db, "day", scope)).summary.total_usd;
    expect((await total(SHOP)) + (await total(BLOG)) + 9).toBeCloseTo(
      await total(),
    );
  });

  test("an unknown project is an empty ledger: zeros, and no baseline from the fleet's history", async () => {
    const quiet = {
      daily_usd: 0,
      baseline_daily_usd: null,
      change_pct: null,
      alarm: false,
      drop: false,
    };
    expect(unwrap(await getSpendReport(db, "day", NOWHERE)).summary).toEqual({
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
});

describe("paused", () => {
  const pausedOf = async (scope?: SpendScope) =>
    unwrap(await getSpendReport(db, "day", scope)).summary.alarm.paused;

  test("a project's summary is paused while that project is, never another's or the fleet's", async () => {
    unwrap(await setProjectPaused(db, "blog", true, "operator"));
    try {
      expect(await pausedOf(BLOG)).toBe(true);
      expect(await pausedOf(SHOP)).toBe(false);
      expect(await pausedOf()).toBe(false);
    } finally {
      unwrap(await setProjectPaused(db, "blog", false, "operator"));
    }
    expect(await pausedOf(BLOG)).toBe(false);
  });

  test("a paused fleet pauses every project's summary", async () => {
    const fleet = (paused: boolean) =>
      setFleetPaused(db, { paused, actor: "operator", via: "rest" });
    unwrap(await fleet(true));
    try {
      expect(await pausedOf(SHOP)).toBe(true);
      expect(await pausedOf(NOWHERE)).toBe(true);
      expect(await pausedOf()).toBe(true);
    } finally {
      unwrap(await fleet(false));
    }
  });

  test("a paused project's real drop is not reported on its report; the fleet's still is", async () => {
    // Its own ledger: $10 a day for 30 days in project `quiet`, then nothing in the last day.
    const own = unwrap(await tempDb(new FakeClock(NOW)));
    try {
      const qdb = own.db;
      unwrap(await seedSpine(qdb, 1));
      unwrap(
        await seedRows(qdb, {
          workspaces: [{ id: "quiet", name: "quiet", kind: "single" }],
          sessions: [
            {
              ...newSessionInput(),
              id: "s-quiet",
              agent_id: SPINE_SEED.agentId,
              state: "idle" as const,
              created_at: 0,
              workspace_id: "quiet",
            },
          ],
        }),
      );
      for (let k = 1; k <= 30; k += 1) {
        const run = unwrap(await appendRun(qdb, newRunInput("s-quiet")));
        unwrap(
          await insertSpend(qdb, {
            run_id: run.id,
            session_id: "s-quiet",
            phase: "build",
            runner_id: SPINE_SEED.runnerId,
            model: "model-a",
            cost_usd: 10,
            cost_source: "reported",
            ts: NOW - k * DAY_MS - 12 * 3_600_000,
          }),
        );
      }
      const alarmOf = async (scope?: SpendScope) =>
        unwrap(await getSpendReport(qdb, "day", scope)).summary.alarm;
      const QUIET: SpendScope = { workspaceId: "quiet" };
      expect(await alarmOf(QUIET)).toMatchObject({
        last_day: { change_pct: -100, alarm: false, drop: true },
        active: false,
        paused: false,
        dropped: true,
      });
      unwrap(await setProjectPaused(qdb, "quiet", true, "operator"));
      expect(await alarmOf(QUIET)).toMatchObject({
        last_day: { change_pct: -100, drop: true },
        active: false,
        paused: true,
        dropped: false,
      });
      expect(await alarmOf()).toMatchObject({
        last_day: { change_pct: -100, drop: true },
        active: false,
        paused: false,
        dropped: true,
      });
    } finally {
      own.cleanup();
    }
  });
});

describe("each grouping", () => {
  test("ticket: tickets with spend in the project, never another's", async () => {
    const nums = async (scope: SpendScope) =>
      (await rowsOf("ticket", scope)).map((row) => row.num);
    expect(await nums(SHOP)).toEqual([3, 1]);
    expect(await nums(BLOG)).toEqual([2]);
    expect(await nums(NOWHERE)).toEqual([]);
  });

  test("tier: the closed tickets the project owns, never an unscoped one its spend touched", async () => {
    // ticket-1 and ticket-4; ticket-3 has no project, so it counts only in the fleet's.
    expect(await rowsOf("tier", SHOP)).toEqual([
      expect.objectContaining({ tier: "standard", closed_tickets: 2 }),
    ]);
    expect(await rowsOf("tier", BLOG)).toEqual([
      expect.objectContaining({ tier: "complex", closed_tickets: 1 }),
    ]);
    expect(await rowsOf("tier", NOWHERE)).toEqual([]);
  });

  test("class: the project's rows by run class, costliest first", async () => {
    const shop = await rowsOf("class", SHOP);
    expect(shop.map((row) => [row.run_class, row.runs, row.cost_usd])).toEqual([
      ["pulse", 2, 4.5],
      ["build", 3, 4],
      ["review", 1, 1.5],
    ]);
    expect(shop.find((row) => row.run_class === "review")?.wasted_usd).toBe(
      1.5,
    );
    expect(
      (await rowsOf("class", BLOG)).map((row) => [row.run_class, row.runs]),
    ).toEqual([
      ["build", 2],
      ["plan", 1],
    ]);
    expect(await rowsOf("class", NOWHERE)).toEqual([]);
  });

  test("day: every day of the window, the project's spend on each", async () => {
    const spent = (rows: RowsOf<"day">) =>
      rows
        .filter((row) => row.runs > 0)
        .map((row) => [(TODAY - row.day) / DAY_MS, row.runs, row.cost_usd]);
    const shop = await rowsOf("day", SHOP);
    expect(shop).toHaveLength(30);
    expect(spent(shop)).toEqual([
      [5, 1, 0.25],
      [2, 1, 1.5],
      [0, 4, 8.25],
    ]);
    expect(spent(await rowsOf("day", BLOG))).toEqual([
      [10, 1, 2],
      [0, 2, 7.8],
    ]);
    const nowhere = await rowsOf("day", NOWHERE);
    expect(nowhere).toHaveLength(30);
    expect(spent(nowhere)).toEqual([]);
  });

  test("no scope is the fleet: every row, as with no project", async () => {
    for (const group of ["day", "ticket", "tier", "class"] as const)
      expect(unwrap(await getSpendReport(db, group, {}))).toEqual(
        unwrap(await getSpendReport(db, group)),
      );
    expect((await rowsOf("ticket")).map((row) => row.num)).toEqual([3, 2, 1]);
  });
});
