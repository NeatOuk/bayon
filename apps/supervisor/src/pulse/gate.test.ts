// The pulse's budget gate (M4-c, §13.4): it reads `budgets`, not settings' daily cap, and a
// breach asks the operator once per budget and window rather than once per pulse.
import { FakeClock } from "@bayon/core";
import { listInboxRequests, type Db } from "@bayon/db";
import { seedRows, tempDb, unwrap } from "@bayon/db/testing";
import { AGENT_ID } from "../lifecycle/testing/fixtures.js";
import { pino } from "pino";
import { afterEach, expect, test } from "vitest";
import { budgetGate } from "./gate.js";
import { ORCH, T0, pulseRows, type BudgetSeed } from "./testing/rig.js";

const BUDGET = "01J0BUDGET000000000000000";
const silent = pino({ level: "silent" });
const closers: (() => void)[] = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
});

/** A fleet/day budget with a zero cap: spent the moment it exists. */
const spent = (over: Partial<BudgetSeed> = {}): BudgetSeed => ({
  id: BUDGET,
  scope: "fleet",
  scope_ref: null,
  period: "day",
  cap_usd: 0,
  updated_at: T0,
  ...over,
});

/** A db holding the pulse rows and whatever budgets the test names. */
async function dbWith(budgets: readonly BudgetSeed[]): Promise<Db> {
  const t = unwrap(await tempDb(new FakeClock(T0)));
  closers.push(() => t.cleanup());
  unwrap(await seedRows(t.db, pulseRows({ budgets })));
  return t.db;
}

const gateOn = (db: Db) => budgetGate({ db, log: silent });
const ask = (db: Db) => gateOn(db)({ agentId: ORCH, trigger: "cron", now: T0 });
const openRequests = async (db: Db) =>
  unwrap(await listInboxRequests(db, { status: "open", limit: 50 })).rows;

test("a budget under its cap allows the pulse and asks nobody", async () => {
  const db = await dbWith([spent({ cap_usd: 10 })]);
  expect(await ask(db)).toEqual({ allow: true });
  expect(await openRequests(db)).toEqual([]);
});

test("no budget at all allows the pulse", async () => {
  expect(await ask(await dbWith([]))).toEqual({ allow: true });
});

test("a spent budget denies, records over_budget and asks the operator once", async () => {
  const db = await dbWith([spent()]);
  const gate = gateOn(db);
  expect(await gate({ agentId: ORCH, trigger: "cron", now: T0 })).toEqual({
    allow: false,
    record: "over_budget",
  });

  const opened = await openRequests(db);
  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatchObject({ kind: "budget", status: "open" });
  expect(opened[0]?.question).toContain("day budget is spent");

  // Every later pulse in this window: still denied, but no second request and no second row.
  for (let i = 1; i <= 3; i += 1) {
    expect(await gate({ agentId: ORCH, trigger: "cron", now: T0 + i })).toEqual(
      { allow: false },
    );
  }
  expect(await openRequests(db)).toHaveLength(1);
});

test("the key, not the gate's memory, is what stops a second request", async () => {
  const db = await dbWith([spent()]);
  expect(await ask(db)).toEqual({ allow: false, record: "over_budget" });
  // A fresh gate is what a supervisor restart leaves: no memory of having asked. The unique
  // dedupe_key in the database is the only thing keeping this to one request for the window.
  expect(await ask(db)).toEqual({ allow: false, record: "over_budget" });
  expect(await openRequests(db)).toHaveLength(1);
});

test("a warn-only budget at its cap never blocks a pulse", async () => {
  const db = await dbWith([spent({ on_breach: "warn" })]);
  expect(await ask(db)).toEqual({ allow: true });
  expect(await openRequests(db)).toEqual([]);
});

test("another agent's budget does not block this agent", async () => {
  const db = await dbWith([
    spent({ scope: "agent", scope_ref: AGENT_ID, cap_usd: 0 }),
  ]);
  expect(await ask(db)).toEqual({ allow: true });
  expect(await openRequests(db)).toEqual([]);
});

test("this agent's own spent budget blocks it", async () => {
  const db = await dbWith([spent({ scope: "agent", scope_ref: ORCH })]);
  expect(await ask(db)).toEqual({ allow: false, record: "over_budget" });
  expect(await openRequests(db)).toHaveLength(1);
});
