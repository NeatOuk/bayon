import { FakeClock } from "@bayon/core";
import { seedRows, tempDb, unwrap } from "@bayon/db/testing";
import { afterEach, expect, test } from "vitest";
import { DELIVERY_SWEEP_MAX, sweepDeliveries } from "./sweep.js";
import {
  PROJECT,
  T0,
  TICKET,
  deliverySince,
  enteredAt,
  makeRepo,
  makeWorld,
  projectRows,
  remoteRef,
  strandOnRemote,
  type World,
} from "./testing/world.js";

// The sweep's own behaviour (spike §1.2): what it pages over, and what it does with a
// ticket whose delivery stopped. What it delivers is deliver.test.ts's.

let world: World | null = null;
let temp: { cleanup(): void } | null = null;

afterEach(() => {
  world?.cleanup();
  world = null;
  temp?.cleanup();
  temp = null;
});

async function worldWith(): Promise<World> {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  temp = t;
  const w = makeWorld(t.db, clock);
  world = w;
  return w;
}

test("a ticket whose delivery stopped is counted and logged, not swallowed", async () => {
  const w = await worldWith();
  const repo = makeRepo(w.home.path, "blocked");
  const theirs = strandOnRemote(w.home.path, repo);
  unwrap(await seedRows(w.db, projectRows({ repos: [repo], mode: "push" })));

  expect(await sweepDeliveries(w.ctx)).toEqual({
    looked: 1,
    delivered: 0,
    failed: 1,
    budgetSpent: false,
  });
  expect(remoteRef(repo.remote)).toBe(theirs);
  expect(
    w.logs.some((l) => l.msg.includes("a ticket's delivery stopped")),
  ).toBe(true);
});

test("more due tickets than one pass's cap: the next pass carries on, then wraps", async () => {
  const w = await worldWith();
  const repo = makeRepo(w.home.path, "many");
  unwrap(await seedRows(w.db, projectRows({ repos: [repo], mode: "none" })));
  // Delivering, but with no worktree of their own: each is a candidate the plan then finds nothing
  // to do for, which is exactly what the paging needs and nothing more.
  unwrap(
    await seedRows(w.db, {
      workspaces: [
        {
          id: "ws-many",
          name: "ws-many",
          kind: "single",
          delivery_mode: "push",
          delivery_since: deliverySince("push"),
        },
      ],
      tickets: Array.from({ length: DELIVERY_SWEEP_MAX + 1 }, (_, i) => ({
        id: `T-${String(i).padStart(3, "0")}`,
        num: 100 + i,
        title: `t${i}`,
        type: "chore" as const,
        status: "done",
        origin: "operator",
        workspace_id: "ws-many",
        created_at: T0,
        updated_at: i,
      })),
      ticket_events: Array.from({ length: DELIVERY_SWEEP_MAX + 1 }, (_, i) =>
        enteredAt(`T-${String(i).padStart(3, "0")}`, "done"),
      ),
    }),
  );
  expect(await sweepDeliveries(w.ctx)).toMatchObject({
    looked: DELIVERY_SWEEP_MAX,
  });
  expect(await sweepDeliveries(w.ctx)).toMatchObject({ looked: 1 });
  // A short page reached the end: the next pass starts from the top again.
  expect(await sweepDeliveries(w.ctx)).toMatchObject({
    looked: DELIVERY_SWEEP_MAX,
  });
  expect(PROJECT).toBe("ws-1");
});

test("a database that cannot be read is logged, and the pass does nothing", async () => {
  const w = await worldWith();
  temp?.cleanup();
  temp = null;
  expect(await sweepDeliveries(w.ctx)).toEqual({
    looked: 0,
    delivered: 0,
    failed: 0,
    budgetSpent: false,
  });
  expect(w.logs.some((l) => l.msg.includes("cannot list the tickets"))).toBe(
    true,
  );
});

// an earlier change code review, MEDIUM 5: the one reconciler step that calls out to a network keeps to a
// wall-clock budget, so a slow remote delays the next delivery and nothing else.
test("the budget stops a pass short, and the next one carries on from there", async () => {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  temp = t;
  // Every reading of the clock is 100 ms later: the budget is spent after the first ticket.
  let ticks = 0;
  const w = makeWorld(t.db, {
    now: () => T0 + ticks++ * 100,
    after: (ms: number, signal?: AbortSignal) => clock.after(ms, signal),
  });
  world = w;
  unwrap(
    await seedRows(t.db, {
      workspaces: [
        {
          id: "ws-slow",
          name: "ws-slow",
          kind: "single",
          delivery_mode: "push",
          delivery_since: deliverySince("push"),
        },
      ],
      tickets: [1, 2, 3].map((n) => ({
        id: `T-${n}`,
        num: 200 + n,
        title: `t${n}`,
        type: "chore" as const,
        status: "done",
        origin: "operator",
        workspace_id: "ws-slow",
        created_at: T0,
        updated_at: n,
      })),
      ticket_events: [1, 2, 3].map((n) => enteredAt(`T-${n}`, "done")),
    }),
  );

  const first = await sweepDeliveries(w.ctx, { budgetMs: 150 });
  expect(first).toMatchObject({ looked: 1, budgetSpent: true });
  expect(
    w.logs.some((l) => l.msg.includes("out of budget for this pass")),
  ).toBe(true);

  // The cursor kept the place: the next pass starts at the ticket after the last one finished.
  const second = await sweepDeliveries(w.ctx, { budgetMs: 150 });
  expect(second).toMatchObject({ looked: 1, budgetSpent: true });
  const third = await sweepDeliveries(w.ctx, { budgetMs: 10_000 });
  expect(third).toMatchObject({ looked: 1, budgetSpent: false });
  // The page is exhausted, so the pass after that starts from the top again.
  expect(await sweepDeliveries(w.ctx, { budgetMs: 10_000 })).toMatchObject({
    looked: 3,
    budgetSpent: false,
  });
});

test("a budget already spent leaves the cursor alone rather than skipping the page", async () => {
  const w = await worldWith();
  const repo = makeRepo(w.home.path, "unbudgeted");
  unwrap(await seedRows(w.db, projectRows({ repos: [repo], mode: "push" })));

  expect(await sweepDeliveries(w.ctx, { budgetMs: 0 })).toMatchObject({
    looked: 0,
    budgetSpent: true,
  });
  expect(remoteRef(repo.remote)).toBeNull();
  // Nothing was skipped: the next pass with a budget delivers it.
  expect(await sweepDeliveries(w.ctx)).toMatchObject({ delivered: 1 });
  expect(remoteRef(repo.remote)).toBe(repo.head);
});

// turning delivery on is not a reason to deliver the project's history. A ticket that
// reached its moment before its project's delivery_since is never paged, so nothing is pushed.
test("a ticket that was already done when delivery was turned on is left where it is", async () => {
  const w = await worldWith();
  const repo = makeRepo(w.home.path, "history");
  const rows = projectRows({ repos: [repo], mode: "push", status: "done" });
  unwrap(
    await seedRows(w.db, {
      ...rows,
      ticket_events: [enteredAt(TICKET, "done", T0 - 1)],
    }),
  );

  expect(await sweepDeliveries(w.ctx)).toEqual({
    looked: 0,
    delivered: 0,
    failed: 0,
    budgetSpent: false,
  });
  expect(remoteRef(repo.remote)).toBeNull();
});
