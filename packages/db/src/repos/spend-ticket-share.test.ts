import { FakeClock } from "@bayon/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Db } from "../connection.js";
import type { TicketEconomicsRow } from "../schema-work.js";
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
import { gateRow } from "./fixtures.js";
import { appendRun } from "./runs.js";
import { insertSpend } from "./spend.js";
import {
  getSpendReport,
  type SpendScope,
  type TierSpend,
} from "./spend-rollups.js";

// A ticket with no project, worked from two projects: each project's ticket row
// carries only its own share of the ticket's money, the shares and the rows in no project add up to
// the fleet's row, and the ticket counts in no project's tier breakdown, only the fleet's.

const NOW = Date.UTC(2026, 8, 13, 10);

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
  const session = (id: string, agent_id: string, ticket_id: string) => ({
    ...newSessionInput(),
    id,
    agent_id,
    ticket_id,
    state: "idle" as const,
    created_at: 0,
  });
  unwrap(
    await seedRows(db, {
      workspaces: [
        { id: "shop", name: "shop", kind: "single" },
        { id: "blog", name: "blog", kind: "single" },
      ],
      agents: [agent("shop-builder", "shop"), agent("blog-builder", "blog")],
      tickets: [
        // No project, closed, worked from shop, blog and the fleet.
        ticketRow(9, { status: "done", complexity_tier: "complex" }),
        // shop's own, closed.
        ticketRow(8, { status: "done", workspace_id: "shop" }),
      ],
      sessions: [
        session("s-shop", "shop-builder", "ticket-9"),
        session("s-blog", "blog-builder", "ticket-9"),
        session("s-fleet", SPINE_SEED.agentId, "ticket-9"),
        session("s-own", "shop-builder", "ticket-8"),
      ],
      gates: [
        gateRow("g1", { ticket_id: "ticket-9", attempt: 1, state: "failed" }),
        gateRow("g2", { ticket_id: "ticket-9", attempt: 2, state: "passed" }),
      ],
    }),
  );
  const rows = [
    { session: "s-shop", ticket: "ticket-9", cost: 4, cache: 0.5 },
    { session: "s-shop", ticket: "ticket-9", cost: 1, cache: 0.7, wasted: 1 },
    { session: "s-blog", ticket: "ticket-9", cost: 3, cache: 0.2 },
    { session: "s-fleet", ticket: "ticket-9", cost: 2, cache: 0.9 },
    { session: "s-own", ticket: "ticket-8", cost: 6, cache: 0.4 },
  ] as const;
  for (const row of rows) {
    const run = unwrap(await appendRun(db, newRunInput(row.session)));
    unwrap(
      await insertSpend(db, {
        run_id: run.id,
        session_id: row.session,
        ticket_id: row.ticket,
        phase: "build",
        runner_id: SPINE_SEED.runnerId,
        model: "model-a",
        tokens_in: 10,
        tokens_out: 20,
        cost_usd: row.cost,
        cost_source: "reported",
        cache_hit_ratio: row.cache,
        wasted: "wasted" in row ? row.wasted : 0,
        ts: NOW - 60_000,
      }),
    );
  }
});
afterAll(() => t.cleanup());

const SHOP: SpendScope = { workspaceId: "shop" };
const BLOG: SpendScope = { workspaceId: "blog" };

async function ticketsOf(scope?: SpendScope): Promise<TicketEconomicsRow[]> {
  const report = unwrap(await getSpendReport(db, "ticket", scope));
  if (report.group !== "ticket") throw new Error(`got ${report.group}`);
  return report.rows;
}

async function ticket(num: number, scope?: SpendScope) {
  const row = (await ticketsOf(scope)).find((r) => r.num === num);
  if (row === undefined) throw new Error(`no ticket ${num}`);
  return row;
}

async function tiersOf(scope?: SpendScope): Promise<TierSpend[]> {
  const report = unwrap(await getSpendReport(db, "tier", scope));
  if (report.group !== "tier") throw new Error(`got ${report.group}`);
  return report.rows;
}

describe("an unscoped ticket worked from two projects", () => {
  test("each project shows only its own share of the ticket's money, tokens and sessions", async () => {
    const shop = await ticket(9, SHOP);
    expect(shop).toMatchObject({
      cost_usd: 5,
      cost_wasted_usd: 1,
      tokens: 60,
      sessions: 1,
    });
    expect(shop.cache_ratio).toBeCloseTo(0.6);
    const blog = await ticket(9, BLOG);
    expect(blog).toMatchObject({
      cost_usd: 3,
      cost_wasted_usd: 0,
      tokens: 30,
      sessions: 1,
    });
    expect(blog.cache_ratio).toBeCloseTo(0.2);
  });

  test("the projects' shares and the rows in no project add up to the fleet's row", async () => {
    const [shop, blog, fleet] = await Promise.all([
      ticket(9, SHOP),
      ticket(9, BLOG),
      ticket(9),
    ]);
    // The fleet session's row: $2, not wasted, 30 tokens, one session.
    const nowhere = {
      cost_usd: 2,
      cost_wasted_usd: 0,
      tokens: 30,
      sessions: 1,
    };
    for (const field of Object.keys(nowhere) as (keyof typeof nowhere)[])
      expect(shop[field] + blog[field] + nowhere[field]).toBe(fleet[field]);
    expect(fleet).toMatchObject({ cost_usd: 10, sessions: 3 });
  });

  test("its review rounds are the ticket's own, whole under each project", async () => {
    for (const scope of [SHOP, BLOG, undefined])
      expect((await ticket(9, scope)).review_rounds).toBe(2);
  });

  test("a ticket the project owns reads exactly as its fleet row", async () => {
    expect(await ticket(8, SHOP)).toEqual(await ticket(8));
    expect((await ticketsOf(BLOG)).map((r) => r.num)).toEqual([9]);
  });

  test("tier: it counts in no project's breakdown, only the fleet's; an owned one in its own", async () => {
    expect(await tiersOf(SHOP)).toEqual([
      expect.objectContaining({
        tier: "standard",
        closed_tickets: 1,
        cost_total_usd: 6,
      }),
    ]);
    expect(await tiersOf(BLOG)).toEqual([]);
    expect(await tiersOf()).toEqual([
      expect.objectContaining({
        tier: "complex",
        closed_tickets: 1,
        cost_total_usd: 10,
      }),
      expect.objectContaining({
        tier: "standard",
        closed_tickets: 1,
        cost_total_usd: 6,
      }),
    ]);
  });
});
