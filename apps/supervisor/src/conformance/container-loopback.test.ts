// runner.conformance on a container executor over the loopback: the real command
// with the real ContainerExecutor and its scripts on a stand-in docker, and the real API's /mcp as
// a child. The fixture is certified per (runner, container); every session's container and root go
// by label; never more than SUITE_PEAK_SESSIONS are held at once; the child's PATH is the
// executor's; the report shows the executor's rtt and image. And the refusals: a runner that
// cannot run in a container at once, then the pre-flight's.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { containerReadiness, systemClock } from "@bayon/core";
import { listRunnerEligibility, openDb, type Db } from "@bayon/db";
import { migrateUp } from "@bayon/db/supervisor";
import { seedRows, unwrap } from "@bayon/db/testing";
import { RunnerConformanceResult } from "@bayon/proto";
import { registrations, type RunnerAdapter } from "@bayon/runners";
import { loadStubAdapter, STUB_RUNNER_IDS } from "@bayon/runners/testing";
import {
  OFFLINE_BUDGETS,
  SUITE_PEAK_SESSIONS,
  type Budgets,
} from "@bayon/runners/conformance";
import { FIXTURE_COMMAND, createFixtureAdapter } from "@bayon/runners/fixture";
import { pino } from "pino";
import { afterAll, beforeAll, expect, test } from "vitest";
import { upsertBootRows } from "../boot.js";
import { envSecrets } from "../lifecycle/secrets.js";
import {
  buildApi,
  startApiChild,
  type ApiChild,
} from "../lifecycle/testing/api-child.js";
import { CMD, tempHome } from "../lifecycle/testing/fixtures.js";
import { dbPath } from "../paths.js";
import { conformanceCommand } from "./command.js";
import {
  LOOPBACK_ENV_PATH,
  LOOPBACK_IMAGE,
  LOOPBACK_RTT_MS,
  loopbackContainer,
  seedUnreadyRunner,
  type Loopback,
} from "./testing.js";

const CTR = "ctr-loop";
const BUDGETS: Budgets = {
  ...OFFLINE_BUDGETS,
  callMs: 10_000,
  turnMs: 10_000,
  hangMs: 500,
  graceMs: 500,
};
const OPERATOR = "conformance-ctr-operator-0123456789";
const log = pino({ level: "silent" });

let home: ReturnType<typeof tempHome>;
let db: Db;
let api: ApiChild;
let ctr: Loopback;
const reports = () => join(home.path, "reports");

beforeAll(async () => {
  buildApi();
  home = tempHome("frm-cfc-");
  db = unwrap(await openDb({ path: dbPath(home.path), clock: systemClock }));
  unwrap(await migrateUp(db));
  unwrap(await upsertBootRows(db, { registrations: registrations() }));
  unwrap(
    await seedRows(db, {
      executors: [
        {
          id: CTR,
          kind: "container",
          config_json: "{}",
          slots: 2,
          trust: "untrusted",
          egress_policy: "allowlist",
        },
      ],
    }),
  );
  api = await startApiChild({
    home: home.path,
    dbPath: dbPath(home.path),
    token: OPERATOR,
  });
  ctr = loopbackContainer(home.path, CTR);
}, 120_000);

afterAll(async () => {
  api.stop();
  await ctr.executor.close();
  await db.close();
  home.cleanup();
});

const command = (adapters: ReadonlyMap<string, RunnerAdapter>) =>
  conformanceCommand({
    db,
    clock: systemClock,
    log,
    frmHome: home.path,
    executors: new Map([[CTR, ctr]]),
    adapters,
    secrets: envSecrets({}),
    path: process.env["PATH"] ?? "",
    mcpUrl: api.mcpUrl,
    budgets: BUDGETS,
  });

test(
  "the fixture is certified on a container executor: its sessions in containers, freed by label, the report naming the executor",
  { timeout: 240_000 },
  async () => {
    const paths: string[] = [];
    // The loopback's "image" is this host: its program, not the image's.
    const fx = createFixtureAdapter({ graceMs: 500, command: FIXTURE_COMMAND });
    const adapter: RunnerAdapter = {
      ...fx,
      spawn: (spec, ex) => {
        paths.push(spec.env["PATH"] ?? "");
        return fx.spawn(spec, ex);
      },
    };
    const conformance = command(new Map([["fixture", adapter]]));
    const done = await conformance.handler.handle(
      {
        runner_id: "fixture",
        executor_id: CTR,
        model_id: "fixture.cheap",
        report_dir: reports(),
      },
      CMD,
    );
    await conformance.stop();
    const result = RunnerConformanceResult.parse(unwrap(done));
    expect(result).toMatchObject({
      runner_id: "fixture",
      executor_id: CTR,
      stored: true,
      model_id: "fixture.cheap",
      report_path: join(reports(), `fixture-1-fixture-model@${CTR}.md`),
    });
    expect(result.summary).toMatchObject({
      failed: [],
      incomplete: [],
      na: [12, 13],
      certifiable: true,
      gate_eligible: true,
      unattended_allowed: true,
    });
    const report = readFileSync(result.report_path, "utf8");
    expect(report).toContain(
      "# Conformance — fixture 1 · fixture-model on ctr-loop",
    );
    expect(report).toContain(
      `executor container · rtt ${LOOPBACK_RTT_MS} ms · image ${LOOPBACK_IMAGE}`,
    );
    const eligible = unwrap(
      await listRunnerEligibility(db, CTR, ["fixture.cheap"]),
    );
    expect(eligible.find((r) => r.id === "fixture")).toMatchObject({
      gate_eligible: 1,
    });
    // The child's PATH is the executor's, never the supervisor's.
    expect(paths.length).toBeGreaterThan(0);
    expect(new Set(paths)).toEqual(new Set([LOOPBACK_ENV_PATH]));
    // Never more than the suite's peak at once, and nothing left: no container, root or run dir.
    expect(ctr.executor.peak).toBeGreaterThan(0);
    expect(ctr.executor.peak).toBeLessThanOrEqual(SUITE_PEAK_SESSIONS);
    expect(ctr.executor.held).toBe(0);
    expect(await ctr.executor.listOwned()).toEqual([]);
    expect(readdirSync(join(ctr.remoteRoot, "work"))).toEqual([]);
    expect(readdirSync(join(home.path, "conformance", "runs"))).toEqual([]);
  },
);

/** Each stand-in runner's adapter, with its container readiness as its registration declares it. */
const stubs = STUB_RUNNER_IDS.map((id) => {
  const adapter = unwrap(loadStubAdapter(id));
  const reg = registrations().find((r) => r.runner.id === id);
  return { id, adapter, readiness: containerReadiness(reg?.runner.defaults) };
});

test("a runner that cannot run in a container is refused on one in under a second, naming the reason; nothing is placed or written", async () => {
  // Every registered runner is ready, so the subject is a row of the test's own.
  const id = "ctr-unready";
  const reason = "no image holds it (test)";
  await seedUnreadyRunner(db, id, reason);
  const conformance = command(new Map());
  try {
    const dir = join(reports(), `unready-${id}`);
    const began = performance.now();
    const done = await conformance.handler.handle(
      {
        runner_id: id,
        executor_id: CTR,
        model_id: `${id}.cheap`,
        report_dir: dir,
      },
      CMD,
    );
    expect(performance.now() - began).toBeLessThan(1_000);
    expect(done).toEqual({
      ok: false,
      error: {
        class: "validation",
        retryable: false,
        message: `runner ${id} cannot run on container executor ${CTR}: ${reason}`,
        cause: { rule: "container_ready", runner: id, executor: CTR, reason },
      },
    });
    expect(existsSync(dir)).toBe(false);
  } finally {
    await conformance.stop();
  }
  expect(ctr.executor.held).toBe(0);
  expect(await ctr.executor.listOwned()).toEqual([]);
});

test("a runner that can run in a container is not refused for it: it reaches the pre-flight", async () => {
  const ready = stubs.filter((s) => s.readiness.ready);
  // A stand-in's runner is ready on a container unless its own defaults say why not (the one
  // rule, containerReadiness): an unready runner must name its reason, and the rest are tried.
  expect(ready.length).toBeGreaterThan(0);
  for (const s of stubs) {
    if (!s.readiness.ready) expect(s.readiness.reason).not.toBe("");
  }
  expect([...ready, ...stubs.filter((s) => !s.readiness.ready)].length).toBe(
    STUB_RUNNER_IDS.length,
  );
  const conformance = command(new Map(ready.map((s) => [s.id, s.adapter])));
  // Unhealthy, so the pre-flight stops it: nothing runs, yet it got past the readiness rule.
  ctr.executor.healthy = false;
  try {
    for (const s of ready) {
      expect(
        await conformance.handler.handle(
          {
            runner_id: s.id,
            executor_id: CTR,
            model_id: `${s.id}.cheap`,
            report_dir: reports(),
          },
          CMD,
        ),
      ).toMatchObject({
        ok: false,
        error: { class: "admission_refused", retryable: true },
      });
    }
  } finally {
    ctr.executor.healthy = true;
    await conformance.stop();
  }
});

test("an unhealthy executor, or one with fewer free slots than the suite's peak, is refused before anything runs", async () => {
  const conformance = command(
    new Map([
      [
        "fixture",
        createFixtureAdapter({ graceMs: 500, command: FIXTURE_COMMAND }),
      ],
    ]),
  );
  const payload = {
    runner_id: "fixture",
    executor_id: CTR,
    model_id: "fixture.cheap",
    report_dir: join(reports(), "refused"),
  };
  ctr.executor.healthy = false;
  expect(await conformance.handler.handle(payload, CMD)).toMatchObject({
    ok: false,
    error: { class: "admission_refused", retryable: true },
  });
  ctr.executor.healthy = true;
  const slot = ctr.slots.tryAcquire();
  if (slot === null)
    throw new Error("the loopback executor had no slot free to hold");
  try {
    expect(await conformance.handler.handle(payload, CMD)).toMatchObject({
      ok: false,
      error: {
        class: "admission_refused",
        retryable: true,
        message: expect.stringContaining("has 1 of 2 slots free"),
      },
    });
  } finally {
    slot.release();
    await conformance.stop();
  }
  expect(existsSync(join(reports(), "refused"))).toBe(false);
  expect(await ctr.executor.listOwned()).toEqual([]);
});
