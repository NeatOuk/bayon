import { FakeClock } from "@bayon/core";
import type { Insertable } from "kysely";
import { afterAll, expect, test } from "vitest";
import type { Db } from "../connection.js";
import type { SpendTable } from "../schema.js";
import {
  SPINE_SEED,
  listAudit,
  newRunInput,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
} from "../testing.js";
import {
  KILL_DEFERRED,
  deleteBudget,
  listBudgets,
  putBudget,
  type BudgetPut,
} from "./budgets.js";

// budgets: the API's PUT and DELETE, each audited, and listBudgets' spend, computed at
// read time over the window of the Db's clock.
const NOW = Date.UTC(2026, 8, 14, 12); // 2026-09-14 12:00 UTC
const DAY_MS = 24 * 60 * 60_000;
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

const run = (id: string, session_id: string) => ({
  ...newRunInput(session_id),
  id,
  seq: 1,
  state: "ok" as const,
  started_at: 0,
});

/** The spine at the latest schema, plus agent-2 with session-2; runs R-1 (the spine's) and R-2. */
async function seeded(): Promise<{ db: Db; clock: FakeClock }> {
  const clock = new FakeClock(NOW);
  const t = unwrap(await tempDb(clock));
  cleanups.push(t.cleanup);
  unwrap(await seedSpine(t.db, 12));
  unwrap(
    await seedRows(t.db, {
      agents: [
        {
          id: "agent-2",
          name: "second",
          kind: "builder",
          runner_id: SPINE_SEED.runnerId,
          executor_id: SPINE_SEED.executorId,
          created_at: 0,
        },
      ],
      sessions: [
        {
          ...newSessionInput(),
          id: "session-2",
          agent_id: "agent-2",
          state: "idle",
          created_at: 0,
        },
      ],
      runs: [run("R-1", SPINE_SEED.sessionId), run("R-2", "session-2")],
    }),
  );
  return { db: t.db, clock };
}

const spend = (
  id: string,
  runId: "R-1" | "R-2",
  cost_usd: number,
  tokens: number,
  ts: number,
): Insertable<SpendTable> => ({
  id,
  run_id: runId,
  session_id: runId === "R-1" ? SPINE_SEED.sessionId : "session-2",
  phase: "build",
  runner_id: SPINE_SEED.runnerId,
  model: "fixture-model",
  tokens_in: tokens - 10,
  tokens_out: 10,
  cost_usd,
  cost_source: "reported",
  ts,
});

const validation = { ok: false, error: { class: "validation" } };
const notFound = { ok: false, error: { class: "not_found" } };

test("putBudget creates a fleet budget with the column defaults, and audits budget.put", async () => {
  const { db } = await seeded();
  const row = unwrap(
    await putBudget(
      db,
      { scope: "fleet", period: "day", cap_usd: 5 },
      "operator",
    ),
  );
  expect(row).toMatchObject({
    scope: "fleet",
    scope_ref: null,
    period: "day",
    cap_usd: 5,
    cap_tokens: null,
    warn_pct: 70,
    on_breach: "pause_admission",
    updated_at: NOW,
  });
  const audit = unwrap(await listAudit(db)).at(-1);
  expect(audit).toMatchObject({
    ts: NOW,
    actor: "operator",
    action: "budget.put",
    target_kind: "budget",
    target_id: row.id,
  });
  expect(JSON.parse(audit?.payload_json ?? "null")).toEqual({
    scope: "fleet",
    scope_ref: null,
    period: "day",
    cap_usd: 5,
    cap_tokens: null,
    warn_pct: 70,
    on_breach: "pause_admission",
  });
});

test("a second PUT for the scope and period replaces the budget and keeps its id; omitted fields take the defaults again", async () => {
  const { db, clock } = await seeded();
  const agent = { scope: "agent", scope_ref: SPINE_SEED.agentId } as const;
  const first = unwrap(
    await putBudget(
      db,
      {
        ...agent,
        period: "month",
        cap_tokens: 1000,
        warn_pct: 50,
        on_breach: "warn",
      },
      "operator",
    ),
  );
  expect(first).toMatchObject({ warn_pct: 50, on_breach: "warn" });
  await clock.advance(1_000);
  const second = unwrap(
    await putBudget(db, { ...agent, period: "month", cap_usd: 3 }, "operator"),
  );
  expect(second).toEqual({
    ...first,
    cap_usd: 3,
    cap_tokens: null,
    warn_pct: 70,
    on_breach: "pause_admission",
    updated_at: NOW + 1_000,
  });
  // Another agent or another period is another budget.
  unwrap(
    await putBudget(
      db,
      { scope: "agent", scope_ref: "agent-2", period: "month", cap_usd: 3 },
      "operator",
    ),
  );
  unwrap(
    await putBudget(db, { ...agent, period: "day", cap_usd: 3 }, "operator"),
  );
  expect(unwrap(await listBudgets(db))).toHaveLength(3);
  expect(
    unwrap(await listAudit(db)).filter((a) => a.action === "budget.put"),
  ).toHaveLength(4);
});

test("on_breach 'kill' is refused (deferred past M4), and nothing is written or audited", async () => {
  const { db } = await seeded();
  const before = unwrap(await listAudit(db)).length;
  const refused = await putBudget(
    db,
    { scope: "fleet", period: "day", cap_usd: 5, on_breach: "kill" },
    "operator",
  );
  expect(refused).toMatchObject(validation);
  expect(refused.ok ? "" : refused.error.message).toBe(KILL_DEFERRED);
  expect(unwrap(await listBudgets(db))).toEqual([]);
  expect(unwrap(await listAudit(db))).toHaveLength(before);
});

const shared = await seeded();
const fleetDay = { scope: "fleet", period: "day", cap_usd: 1 } as const;

test.each<readonly [string, BudgetPut]>([
  ["an unknown scope", { ...fleetDay, scope: "team" }],
  ["an unknown period", { ...fleetDay, period: "week" }],
  [
    "a fleet budget naming an agent",
    { ...fleetDay, scope_ref: SPINE_SEED.agentId },
  ],
  ["an agent budget naming none", { ...fleetDay, scope: "agent" }],
  ["no cap", { scope: "fleet", period: "day" }],
  ["a negative cap", { ...fleetDay, cap_usd: -1 }],
  ["an infinite cap", { ...fleetDay, cap_usd: Infinity }],
  ["a NaN cap", { ...fleetDay, cap_usd: Number.NaN }],
  [
    "a fractional token cap",
    { scope: "fleet", period: "day", cap_tokens: 1.5 },
  ],
  ["warn_pct 0", { ...fleetDay, warn_pct: 0 }],
  ["warn_pct 101", { ...fleetDay, warn_pct: 101 }],
  ["a fractional warn_pct", { ...fleetDay, warn_pct: 70.5 }],
  ["an unknown on_breach", { ...fleetDay, on_breach: "page" }],
])("putBudget refuses %s", async (_, put) => {
  expect(await putBudget(shared.db, put, "operator")).toMatchObject(validation);
  expect(unwrap(await listBudgets(shared.db))).toEqual([]);
});

test("putBudget refuses a blank actor, and an agent that does not exist", async () => {
  const { db } = await seeded();
  expect(await putBudget(db, fleetDay, " ")).toMatchObject(validation);
  expect(
    await putBudget(
      db,
      { scope: "agent", scope_ref: "nobody", period: "day", cap_usd: 1 },
      "operator",
    ),
  ).toMatchObject(notFound);
});

test("deleteBudget removes the budget and audits budget.delete; a missing one is not_found", async () => {
  const { db } = await seeded();
  const row = unwrap(await putBudget(db, fleetDay, "operator"));
  expect(unwrap(await deleteBudget(db, row.id, "operator"))).toEqual(row);
  expect(unwrap(await listBudgets(db))).toEqual([]);
  expect(unwrap(await listAudit(db)).at(-1)).toMatchObject({
    action: "budget.delete",
    target_id: row.id,
  });
  expect(await deleteBudget(db, row.id, "operator")).toMatchObject(notFound);
  expect(await deleteBudget(db, row.id, "")).toMatchObject(validation);
});

test("listBudgets computes each budget's spend now, over its UTC window and scope, and the window rolls by itself", async () => {
  const { db, clock } = await seeded();
  const today = Date.UTC(2026, 8, 14);
  const month = Date.UTC(2026, 8, 1);
  const nextMonth = Date.UTC(2026, 9, 1);
  for (const put of [
    {
      scope: "agent",
      scope_ref: SPINE_SEED.agentId,
      period: "day",
      cap_usd: 100,
    },
    { scope: "fleet", period: "day", cap_usd: 100 },
    { scope: "fleet", period: "month", cap_usd: 100 },
  ] as const) {
    unwrap(await putBudget(db, put, "operator"));
  }
  unwrap(
    await seedRows(db, {
      spend: [
        spend("mine-today", "R-1", 1, 100, NOW - 3_600_000),
        spend("other-today", "R-2", 2, 200, NOW - 7_200_000),
        spend("mine-this-month", "R-1", 4, 400, month + 3_600_000),
        spend("mine-last-month", "R-1", 8, 800, month - 1),
        spend("mine-tomorrow", "R-1", 16, 1600, today + DAY_MS),
      ],
    }),
  );
  const view = async () =>
    unwrap(await listBudgets(db)).map((b) => ({
      scope: b.scope,
      period: b.period,
      window: [b.window_start, b.window_end],
      usd: b.spent_usd,
      tokens: b.spent_tokens,
    }));
  expect(await view()).toEqual([
    {
      scope: "agent",
      period: "day",
      window: [today, today + DAY_MS],
      usd: 1,
      tokens: 100,
    },
    {
      scope: "fleet",
      period: "day",
      window: [today, today + DAY_MS],
      usd: 3,
      tokens: 300,
    },
    {
      scope: "fleet",
      period: "month",
      window: [month, nextMonth],
      usd: 23,
      tokens: 2300,
    },
  ]);
  await clock.advance(nextMonth - NOW);
  expect(await view()).toEqual([
    {
      scope: "agent",
      period: "day",
      window: [nextMonth, nextMonth + DAY_MS],
      usd: 0,
      tokens: 0,
    },
    {
      scope: "fleet",
      period: "day",
      window: [nextMonth, nextMonth + DAY_MS],
      usd: 0,
      tokens: 0,
    },
    {
      scope: "fleet",
      period: "month",
      window: [nextMonth, Date.UTC(2026, 10, 1)],
      usd: 0,
      tokens: 0,
    },
  ]);
});
