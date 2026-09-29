// GET/PUT/DELETE /budgets over HTTP (M4-c, §12.1, §13.4): the operator's caps, each write audited,
// `on_breach: 'kill'` refused at the door, and every budget carrying the window it counts — which
// is computed at read time, never stored.
import { FakeClock, systemClock } from "@bayon/core";
import { listAudit, tempDb, unwrap, type TempDb } from "@bayon/db/testing";
import { ApiErrorBody, BudgetView, BudgetsView, Fleet } from "@bayon/proto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { dbStore } from "./db-store.js";
import { startApi, type RunningApi } from "./server.js";

const TOKEN = "e2e-budgets-bearer-0123456789abcdef";
/** Midday, so a day budget's window is unambiguously the day around it. */
const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);

let t: TempDb;
let api: RunningApi;

beforeAll(async () => {
  t = unwrap(await tempDb(new FakeClock(T0)));
  api = await startApi({
    config: { token: TOKEN, host: "127.0.0.1", port: 0 },
    store: dbStore(t.db),
    clock: systemClock,
    logger: false,
  });
});

afterAll(async () => {
  await api.close();
  t.cleanup();
});

const call = (path: string, init: RequestInit = {}) =>
  fetch(`${api.url}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });

const put = (body: unknown) =>
  call("/budgets", { method: "PUT", body: JSON.stringify(body) });
const list = async () =>
  BudgetsView.parse(await (await call("/budgets")).json()).budgets;
const actions = async () =>
  unwrap(await listAudit(t.db)).map((r) => [r.actor, r.action]);

test("PUT creates a budget, GET lists it with its window and zero spend", async () => {
  expect(await list()).toEqual([]);

  const res = await put({ scope: "fleet", period: "day", cap_usd: 40 });
  expect(res.status).toBe(200);
  const made = BudgetView.parse(await res.json());
  expect(made).toMatchObject({
    scope: "fleet",
    scope_ref: null,
    period: "day",
    cap_usd: 40,
    cap_tokens: null,
    // The column defaults, since the body named neither (§13.4: warn at 70 %).
    warn_pct: 70,
    on_breach: "pause_admission",
    spent_usd: 0,
    spent_tokens: 0,
  });
  // The window is the UTC day holding the clock, computed rather than stored.
  expect(made.window_start).toBe(Date.UTC(2026, 0, 15));
  expect(made.window_end).toBe(Date.UTC(2026, 0, 16));

  expect(await list()).toEqual([made]);
  expect(await actions()).toContainEqual(["operator", "budget.put"]);
});

test("PUT on the same scope and period replaces it whole, keeping its id", async () => {
  const before = (await list())[0];
  const after = BudgetView.parse(
    await (
      await put({ scope: "fleet", period: "day", cap_usd: 99, warn_pct: 50 })
    ).json(),
  );
  expect(after.id).toBe(before?.id);
  expect(after).toMatchObject({ cap_usd: 99, warn_pct: 50 });
  expect(await list()).toHaveLength(1);
});

// What a budget has spent, and which spend rows fall inside its window, is covered against real
// spend rows in packages/db's budgets.test.ts; this file is about the HTTP surface.

test("GET /fleet carries the same budgets", async () => {
  const fleet = Fleet.parse(await (await call("/fleet")).json());
  expect(fleet.budgets).toEqual(await list());
});

test("on_breach 'kill' is refused (deferred past M4) and writes nothing", async () => {
  const before = await list();
  const res = await put({
    scope: "fleet",
    period: "month",
    cap_usd: 10,
    on_breach: "kill",
  });
  expect(res.status).toBe(400);
  expect(ApiErrorBody.parse(await res.json()).error.class).toBe("validation");
  expect(await list()).toEqual(before);
});

test("a budget naming neither cap is refused", async () => {
  const before = await list();
  const res = await put({ scope: "fleet", period: "month" });
  expect(res.status).toBe(400);
  expect(await list()).toEqual(before);
});

test("a fleet budget naming an agent is refused, and an agent budget naming none too", async () => {
  expect(
    (await put({ scope: "fleet", period: "month", cap_usd: 1, scope_ref: "a" }))
      .status,
  ).toBe(400);
  expect(
    (await put({ scope: "agent", period: "month", cap_usd: 1 })).status,
  ).toBe(400);
});

test("an agent budget for an agent that does not exist is 404", async () => {
  const res = await put({
    scope: "agent",
    scope_ref: "no-such-agent",
    period: "day",
    cap_usd: 5,
  });
  expect(res.status).toBe(404);
});

test("DELETE removes it, is audited, and a second DELETE is 404", async () => {
  const [budget] = await list();
  const id = budget?.id ?? "";
  const res = await call(`/budgets/${id}`, { method: "DELETE" });
  expect(res.status).toBe(200);
  // The deleted budget comes back with what it had spent: the row is gone after this, so this is
  // the only chance to see it.
  expect(BudgetView.parse(await res.json())).toMatchObject({ id, cap_usd: 99 });
  expect(await list()).toEqual([]);
  expect(await actions()).toContainEqual(["operator", "budget.delete"]);

  expect((await call(`/budgets/${id}`, { method: "DELETE" })).status).toBe(404);
});
