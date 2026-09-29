import { FakeClock } from "@bayon/core";
import { dumpAllRows, seedRows, tempDb, unwrap } from "@bayon/db/testing";
import { SlotCounter } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import {
  createFixtureAdapter,
  FIXTURE_PROGRAM,
  fixtureProgram,
} from "@bayon/runners/fixture";
import { afterAll, expect, test } from "vitest";
import {
  EXECUTOR_ID,
  lifecycleRows,
  startLifecycle,
} from "../lifecycle/testing/fixtures.js";
import {
  T0,
  TICKET,
  makeRepo,
  remoteRef,
  projectRows,
  tempHome,
} from "./testing/world.js";

// The delivery sweep is a step of the reconciler pass (spike §1.2). This is the wiring
// test: a real booted lifecycle — and a boot IS a reconciler pass — leaves a due ticket's branch on
// its project's own remote, with nothing in this test having called the sweep.

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

test("a reconciler pass delivers a due ticket, and a second pass sends nothing", async () => {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const home = tempHome("frm-recon-");
  unwrap(
    await seedRows(
      t.db,
      lifecycleRows({
        healthArgv: ["ok"],
        // The loop never fires on its own: each pass here is an explicit one.
        settings: { "reconciler.interval_ms": 86_400_000 },
      }),
    ),
  );
  const repo = makeRepo(home.path, "wired");
  unwrap(await seedRows(t.db, projectRows({ repos: [repo], mode: "push" })));

  const slots = new SlotCounter(1);
  const started = await startLifecycle({
    db: t.db,
    clock,
    frmHome: home.path,
    executor: new FakeExecutor({
      id: EXECUTOR_ID,
      slots,
      programs: { [FIXTURE_PROGRAM]: fixtureProgram, ok: () => 0 },
    }),
    slots,
    adapter: createFixtureAdapter({ command: [FIXTURE_PROGRAM], clock }),
  });
  cleanups.push(async () => {
    await started.lifecycle.shutdown();
    t.cleanup();
    home.cleanup();
  });

  // `startLifecycle` boots, and a boot is a reconciler pass: the branch is on the project's own
  // remote with nothing in this test having called the sweep.
  expect(remoteRef(repo.remote)).toBe(repo.head);
  const after = unwrap(await dumpAllRows(t.db)).deliveries ?? [];
  expect(after).toHaveLength(1);

  // And a further pass sends nothing and rewrites nothing.
  await started.lifecycle.reconcile();
  expect(unwrap(await dumpAllRows(t.db)).deliveries).toEqual(after);
  expect(remoteRef(repo.remote)).toBe(repo.head);
});

test("a reconciler pass polls an open pull request right after delivering", async () => {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const home = tempHome("frm-recon-pr-");
  unwrap(
    await seedRows(
      t.db,
      lifecycleRows({
        healthArgv: ["ok"],
        settings: { "reconciler.interval_ms": 86_400_000 },
      }),
    ),
  );
  const repo = makeRepo(home.path, "watched");
  // Delivering nothing (so the delivery sweep leaves it alone), with a request already open on a
  // remote that has no forge: the poll records why it cannot read it, and asks no network at all.
  unwrap(
    await seedRows(t.db, {
      ...projectRows({ repos: [repo], mode: "none" }),
      deliveries: [
        {
          id: "D-1",
          ticket_id: TICKET,
          repo_id: repo.id,
          branch: "frm/s1",
          head_sha: repo.head,
          state: "pr_open",
          pr_url: "https://forge.test/pull/1",
          pr_number: 1,
          remote_url: repo.remote,
          started_at: T0,
        },
      ],
    }),
  );
  const slots = new SlotCounter(1);
  const started = await startLifecycle({
    db: t.db,
    clock,
    frmHome: home.path,
    executor: new FakeExecutor({
      id: EXECUTOR_ID,
      slots,
      programs: { [FIXTURE_PROGRAM]: fixtureProgram, ok: () => 0 },
    }),
    slots,
    adapter: createFixtureAdapter({ command: [FIXTURE_PROGRAM], clock }),
  });
  cleanups.push(async () => {
    await started.lifecycle.shutdown();
    t.cleanup();
    home.cleanup();
  });
  const rows = unwrap(await dumpAllRows(t.db));
  expect(rows.deliveries).toMatchObject([
    {
      state: "pr_open",
      error: expect.stringMatching(/is not a forge Bayon can read/),
    },
  ]);
  expect(rows.human_requests).toHaveLength(1);
});
