// runner.conformance end to end: the fixture certified on local through the real command
// path (claimer → handler → the suite on the supervisor's ports, with the real API's /mcp as a
// child on the same database) → report written, certifiable, gate-eligible and unattended; an
// incomplete run writes its report but stores and clears nothing; the broken stub never certifies.
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { LOGIN_IN_PLACE_KEY, ok, systemClock } from "@bayon/core";
import {
  getCommand,
  getRunner,
  listRunnerCertifications,
  listRunnerEligibility,
  openDb,
  type Db,
} from "@bayon/db";
import { migrateUp, upsertRegistration } from "@bayon/db/supervisor";
import { insertCommand, seedRows, unwrap } from "@bayon/db/testing";
import {
  LocalExecutor,
  SlotCounter,
  tryAcquireAll,
  type Executor,
} from "@bayon/executors";
import { RunnerConformanceResult } from "@bayon/proto";
import {
  registrations,
  type RunnerAdapter,
  type SpawnSpec,
} from "@bayon/runners";
import {
  OFFLINE_BUDGETS,
  SUITE_PEAK_SESSIONS,
  conformanceKit,
  type Budgets,
} from "@bayon/runners/conformance";
import { createFixtureAdapter } from "@bayon/runners/fixture";
import { createBrokenStubAdapter } from "@bayon/runners/testing";
import { pino } from "pino";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import {
  LOCAL_EXECUTOR_ID,
  registrationRows,
  upsertBootRows,
} from "../boot.js";
import { createClaimer } from "../commands/claimer.js";
import { envSecrets } from "../lifecycle/secrets.js";
import {
  buildApi,
  startApiChild,
  type ApiChild,
} from "../lifecycle/testing/api-child.js";
import { CMD, tempHome } from "../lifecycle/testing/fixtures.js";
import { dbPath } from "../paths.js";
import {
  conformanceCommand,
  type ConformanceCommandOptions,
} from "./command.js";

/** An executor paired with its own counter, as the command now takes them. */
const slotted = (executor: Executor, slots = 8) => ({
  executor,
  slots: new SlotCounter(slots),
});

/** One local executor with `slots` of capacity, wired the way the command expects. */
const withSlots = (id: string, slots: number) => {
  const counter = new SlotCounter(slots);
  return new Map([
    [
      id,
      { executor: new LocalExecutor({ id, slots: counter }), slots: counter },
    ],
  ]);
};

// The suite's offline budgets, with room for real processes on a busy host.
const BUDGETS: Budgets = {
  ...OFFLINE_BUDGETS,
  callMs: 10_000,
  turnMs: 10_000,
  hangMs: 500,
  graceMs: 500,
};
const OPERATOR = "conformance-e2e-operator-0123456789";
const log = pino({ level: "silent" });

let home: ReturnType<typeof tempHome>;
let db: Db;
let api: ApiChild;
const reports = () => join(home.path, "reports");

beforeAll(async () => {
  buildApi();
  home = tempHome("frm-cf-");
  db = unwrap(await openDb({ path: dbPath(home.path), clock: systemClock }));
  unwrap(await migrateUp(db));
  unwrap(await upsertBootRows(db, { registrations: registrations() }));
  api = await startApiChild({
    home: home.path,
    dbPath: dbPath(home.path),
    token: OPERATOR,
  });
}, 120_000);

afterAll(async () => {
  api.stop();
  await db.close();
  home.cleanup();
});

function command(
  adapters: ReadonlyMap<string, RunnerAdapter>,
  o: Partial<ConformanceCommandOptions> = {},
) {
  return conformanceCommand({
    db,
    clock: systemClock,
    log,
    frmHome: home.path,
    executors: withSlots(LOCAL_EXECUTOR_ID, 8),
    adapters,
    secrets: envSecrets({}),
    path: process.env["PATH"] ?? "",
    mcpUrl: api.mcpUrl,
    budgets: BUDGETS,
    ...o,
  });
}

const fixtureAdapters = () =>
  new Map([["fixture", createFixtureAdapter({ graceMs: 500 })]]);

test(
  "the fixture is certified on local through the real command path: report written, certifiable, gate-eligible, unattended",
  { timeout: 180_000 },
  async () => {
    const conformance = command(fixtureAdapters());
    const claimer = createClaimer({ db, clock: systemClock, log });
    claimer.register(conformance.handler);
    const cmd = unwrap(
      await insertCommand(db, {
        type: "runner.conformance",
        payload: {
          runner_id: "fixture",
          executor_id: LOCAL_EXECUTOR_ID,
          model_id: "fixture.cheap",
          report_dir: reports(),
        },
      }),
    );
    claimer.start();
    const row = await vi.waitFor(
      async () => {
        const r = unwrap(await getCommand(db, cmd.id));
        expect(["done", "failed"]).toContain(r.state);
        return r;
      },
      { timeout: 170_000, interval: 200 },
    );
    await claimer.stop();
    await conformance.stop();
    expect(row.error).toBeNull();
    const result = RunnerConformanceResult.parse(
      JSON.parse(row.result_json ?? "null"),
    );
    expect(result).toMatchObject({
      runner_id: "fixture",
      executor_id: "local",
      model_id: "fixture.cheap",
      model: "fixture-model",
      runner_version: "1",
      stored: true,
      report_path: join(reports(), "fixture-1-fixture-model@local.md"),
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
      "# Conformance — fixture 1 · fixture-model on local",
    );
    expect(report).toContain(
      "ports ingest=supervisor, watchdog=supervisor, mcp=supervisor, workspace=supervisor",
    );
    expect(report).toContain(
      "**certifiable: yes · gate_eligible: yes · unattended: yes**",
    );
    const [pair] = unwrap(await listRunnerCertifications(db));
    expect(pair).toMatchObject({
      runner_id: "fixture",
      executor_id: "local",
      model_id: "fixture.cheap",
      model: "fixture-model",
      gate_eligible: 1,
      report_path: result.report_path,
    });
    expect(pair?.passed_at).not.toBeNull();
    expect(unwrap(await getRunner(db, "fixture"))).toMatchObject({
      gate_eligible: 1,
      conformance_version: "1",
    });
    const eligible = unwrap(
      await listRunnerEligibility(db, LOCAL_EXECUTOR_ID, ["fixture.cheap"]),
    );
    expect(eligible.find((r) => r.id === "fixture")).toMatchObject({
      gate_eligible: 1,
    });
    // Certified on the cheap model alone: another model of the runner is not.
    const complex = unwrap(
      await listRunnerEligibility(db, LOCAL_EXECUTOR_ID, ["fixture.complex"]),
    );
    expect(complex.find((r) => r.id === "fixture")).toMatchObject({
      gate_eligible: 0,
      conformance_passed_at: null,
    });
  },
);

test(
  "an incomplete run writes its report but stores nothing and clears nothing",
  { timeout: 120_000 },
  async () => {
    const before = unwrap(await listRunnerCertifications(db));
    expect(before).toHaveLength(1);
    const conformance = command(fixtureAdapters(), {
      budgets: { ...BUDGETS, maxUsd: 0 },
    });
    const done = await conformance.handler.handle(
      {
        runner_id: "fixture",
        executor_id: LOCAL_EXECUTOR_ID,
        model_id: "fixture.cheap",
        report_dir: join(reports(), "incomplete"),
      },
      CMD,
    );
    await conformance.stop();
    const result = RunnerConformanceResult.parse(unwrap(done));
    expect(result.stored).toBe(false);
    expect(result.summary.certifiable).toBe(false);
    expect(result.summary.incomplete.length).toBeGreaterThan(0);
    expect(existsSync(result.report_path)).toBe(true);
    expect(unwrap(await listRunnerCertifications(db))).toEqual(before);
  },
);

test(
  "the broken stub never certifies on the supervisor's ports",
  { timeout: 180_000 },
  async () => {
    const broken = createBrokenStubAdapter(
      {
        terminalOnExit: true,
        dropUnknown: true,
        ignoreHomeClaim: true,
        sharedState: true,
      },
      { graceMs: 500 },
    );
    unwrap(
      await upsertRegistration(
        db,
        unwrap(registrationRows(broken.registration())),
      ),
    );
    const conformance = command(new Map([[broken.id, broken]]), {
      kits: () => ok(unwrap(conformanceKit("fixture"))),
    });
    const done = await conformance.handler.handle(
      {
        runner_id: broken.id,
        executor_id: LOCAL_EXECUTOR_ID,
        model_id: `${broken.id}.cheap`,
        report_dir: reports(),
      },
      CMD,
    );
    await conformance.stop();
    const result = RunnerConformanceResult.parse(unwrap(done));
    expect(result.summary.failed).toEqual(expect.arrayContaining([9, 10, 14]));
    expect(result.summary).toMatchObject({
      gate_eligible: false,
      unattended_allowed: false,
    });
    const pair = unwrap(await listRunnerCertifications(db)).find(
      (c) => c.runner_id === broken.id,
    );
    expect(pair ?? { gate_eligible: 0, passed_at: null }).toMatchObject({
      gate_eligible: 0,
      passed_at: null,
    });
    expect(unwrap(await getRunner(db, broken.id))).toMatchObject({
      gate_eligible: 0,
      conformance_passed_at: null,
    });
  },
);

test(
  "one run at a time: a refusal answers while a run is in flight, and never lets the next run overtake it",
  { timeout: 30_000 },
  async () => {
    const local = new LocalExecutor({
      id: "q-local",
      slots: new SlotCounter(8),
    });
    /** Each health check (the pre-flight's first step) waits for the test to answer it. */
    const checks: (() => void)[] = [];
    const held = (id: string, kind: Executor["kind"]): Executor => ({
      id,
      kind,
      capabilities: { pty: false },
      prepare: (s) => local.prepare(s),
      exec: (argv, o) => local.exec(argv, o),
      pty: (argv, o) => local.pty(argv, o),
      health: async (limits) => {
        const report = await local.health(limits);
        await new Promise<void>((resolve) => checks.push(resolve));
        return { ...report, healthy: false }; // pre-flight refuses: nothing runs
      },
      probe: (ref) => local.probe(ref),
      cleanup: (ref, mode) => local.cleanup(ref, mode),
      capacity: () => local.capacity(),
    });
    // Both executors as rows too: the command reads `executors.enabled` before its pre-flight
    //, and only the row can say whether the operator disabled one.
    unwrap(
      await seedRows(db, {
        executors: [
          { id: "q-local", kind: "local", config_json: "{}" },
          { id: "q-ctr", kind: "container", config_json: "{}" },
        ],
      }),
    );
    // A runner row whose defaults say it cannot run in a container. The refusal comes before
    // any adapter is looked up, so it needs none.
    const base = createFixtureAdapter().registration().runner;
    unwrap(
      await upsertRegistration(
        db,
        unwrap(
          registrationRows({
            models: [],
            runner: {
              ...base,
              id: "q-unready",
              adapter: "q-unready",
              defaults: { containerUnready: "no image holds it (test)" },
            },
          }),
        ),
      ),
    );
    const conformance = command(
      new Map<string, RunnerAdapter>(fixtureAdapters()),
      {
        executors: new Map([
          ["q-local", slotted(held("q-local", "local"))],
          ["q-ctr", slotted(held("q-ctr", "container"))],
        ]),
      },
    );
    const payload = (runner_id: string, executor_id: string) => ({
      runner_id,
      executor_id,
      model_id: `${runner_id}.cheap`,
      report_dir: join(reports(), "queue"),
    });
    const settled: string[] = [];
    const track = <T>(name: string, p: Promise<T>): Promise<T> =>
      p.finally(() => settled.push(name));
    const first = track(
      "first",
      conformance.handler.handle(payload("fixture", "q-local"), CMD),
    );
    await vi.waitFor(() => expect(checks).toHaveLength(1), { timeout: 10_000 });
    const refused = track(
      "refused",
      conformance.handler.handle(payload("q-unready", "q-ctr"), CMD),
    );
    const second = track(
      "second",
      conformance.handler.handle(payload("fixture", "q-local"), CMD),
    );
    expect(await refused).toMatchObject({
      ok: false,
      error: { class: "validation", cause: { rule: "container_ready" } },
    });
    // The first run is still in its pre-flight, and the second has not reached its own.
    expect(settled).toEqual(["refused"]);
    expect(checks).toHaveLength(1);
    checks[0]?.();
    expect(await first).toMatchObject({
      ok: false,
      error: { class: "admission_refused" },
    });
    await vi.waitFor(() => expect(checks).toHaveLength(2), { timeout: 10_000 });
    checks[1]?.();
    expect(await second).toMatchObject({
      ok: false,
      error: { class: "admission_refused" },
    });
    expect(settled).toEqual(["refused", "first", "second"]);
    await conformance.stop();
  },
);

test(
  "a run whose end fails still writes its report with every result, stores nothing, and leaves no process behind",
  { timeout: 180_000 },
  async () => {
    const before = unwrap(await listRunnerCertifications(db));
    const fx = createFixtureAdapter({ graceMs: 500 });
    const strays: string[] = [];
    // Starts a process outside every session and never stops it: only the run's end can find it.
    const leaky: RunnerAdapter = {
      ...fx,
      spawn: async (spec, ex) => {
        if (strays.length === 0) {
          const stray = await ex.exec(
            [process.execPath, "-e", "setInterval(() => {}, 1 << 30)"],
            {
              cwd: home.path,
              env: { PATH: process.env["PATH"] ?? "" },
              stdin: "ignore",
            },
          );
          strays.push(stray.ref);
        }
        return fx.spawn(spec, ex);
      },
    };
    const conformance = command(new Map([["fixture", leaky]]), {
      // The owner's failure, as removing the run's directory raised it.
      removeDir: () =>
        Promise.reject(
          Object.assign(new Error("ENOTEMPTY: directory not empty (test)"), {
            code: "ENOTEMPTY",
          }),
        ),
    });
    const done = await conformance.handler.handle(
      {
        runner_id: "fixture",
        executor_id: LOCAL_EXECUTOR_ID,
        model_id: "fixture.cheap",
        report_dir: join(reports(), "teardown"),
      },
      CMD,
    );
    await conformance.stop();
    const result = RunnerConformanceResult.parse(unwrap(done));
    // Its tests certify; its end did not, so nothing is stored or cleared.
    expect(result.summary.certifiable).toBe(true);
    expect(result).toMatchObject({ stored: false, passed_at: null });
    expect(result.teardown).toEqual([
      "1 process group(s) the suite started were still alive at its end and were killed",
      "its run directory could not be removed (ENOTEMPTY)",
    ]);
    const report = readFileSync(result.report_path, "utf8");
    expect(report).toContain("## Teardown");
    expect(report).toContain(
      "- its run directory could not be removed (ENOTEMPTY)",
    );
    expect(report).toMatch(/^\| 14 +\| home claim +\| pass /m);
    expect(report).toMatch(/^\| 15 +\| concurrent home isolation +\| pass /m);
    expect(unwrap(await listRunnerCertifications(db))).toEqual(before);
    const probe = new LocalExecutor({ id: "probe", slots: new SlotCounter(1) });
    expect(strays).toHaveLength(1);
    for (const ref of strays) expect(await probe.probe(ref)).toBe("dead");
  },
);

// `executors.enabled = 0` is the operator's kill switch. Admission refuses a session
// spawn on a disabled executor; the suite never goes through admission, so the command reads the
// row itself — at the moment the run would start, so a disable while it waited behind another run
// is still obeyed. The row is the authority: a disabled executor is still wired and still healthy.
test("a conformance run on a disabled executor is refused before its health check, and an enabled one still reaches it", async () => {
  const checked: string[] = [];
  /** A local executor that records every health check — the pre-flight's first step — then fails it. */
  const watched = (id: string): Executor => {
    const local = new LocalExecutor({ id, slots: new SlotCounter(8) });
    return {
      id,
      kind: "local",
      capabilities: { pty: false },
      prepare: (s) => local.prepare(s),
      exec: (argv, o) => local.exec(argv, o),
      pty: (argv, o) => local.pty(argv, o),
      health: async (limits) => {
        checked.push(id);
        return { ...(await local.health(limits)), healthy: false };
      },
      probe: (ref) => local.probe(ref),
      cleanup: (ref, mode) => local.cleanup(ref, mode),
      capacity: () => local.capacity(),
    };
  };
  unwrap(
    await seedRows(db, {
      executors: [
        { id: "off", kind: "local", config_json: "{}", enabled: 0 },
        { id: "on", kind: "local", config_json: "{}" },
      ],
    }),
  );
  const conformance = command(fixtureAdapters(), {
    executors: new Map([
      ["off", slotted(watched("off"))],
      ["on", slotted(watched("on"))],
    ]),
  });
  const payload = (executor_id: string) => ({
    runner_id: "fixture",
    executor_id,
    model_id: "fixture.cheap",
    report_dir: join(reports(), "disabled"),
  });

  const refused = await conformance.handler.handle(payload("off"), CMD);
  expect(refused).toMatchObject({
    ok: false,
    error: {
      class: "admission_refused",
      retryable: false,
      cause: { gate: "disabled" },
    },
  });
  expect(refused.ok ? "" : refused.error.message).toContain(
    "executor off is disabled",
  );
  // Refused before anything was asked of the executor: no health check, no slot taken.
  expect(checked).toEqual([]);

  // Not a blanket refusal: the enabled executor's run gets past the switch into its pre-flight,
  // where this stub's unhealthy report stops it (the full suite on an enabled local is the first
  // test in this file).
  const enabled = await conformance.handler.handle(payload("on"), CMD);
  expect(enabled).toMatchObject({
    ok: false,
    error: { class: "admission_refused" },
  });
  expect(enabled.ok ? "" : enabled.error.message).toContain("is unhealthy");
  expect(checked).toEqual(["on"]);
  await conformance.stop();
});

// the suite spawns its sessions straight through the executor, never through admission,
// so it takes SUITE_PEAK_SESSIONS slots for the run rather than merely counting free ones. On a
// shared host (ctr-lab, 2 slots) a run on top of two sessions would otherwise break the cap.
test("a model that is not an active model of the runner is refused before anything runs, and stores nothing", async () => {
  // Another runner's models rows, so one of them is a real model that is not the fixture's.
  const other = createBrokenStubAdapter({}, { graceMs: 500 });
  unwrap(
    await upsertRegistration(
      db,
      unwrap(registrationRows(other.registration())),
    ),
  );
  const before = unwrap(await listRunnerCertifications(db));
  const conformance = command(fixtureAdapters());
  for (const model_id of ["no-such-model", `${other.id}.cheap`]) {
    const refused = await conformance.handler.handle(
      {
        runner_id: "fixture",
        executor_id: LOCAL_EXECUTOR_ID,
        model_id,
        report_dir: reports(),
      },
      CMD,
    );
    expect(refused.ok, model_id).toBe(false);
    if (!refused.ok && model_id !== "no-such-model") {
      expect(refused.error).toMatchObject({
        class: "validation",
        message: `model ${model_id} is not an active model of runner fixture`,
      });
    }
  }
  await conformance.stop();
  expect(unwrap(await listRunnerCertifications(db))).toEqual(before);
});

test("a compression run of a runner that does not compress on the executor is refused before anything runs", async () => {
  const before = unwrap(await listRunnerCertifications(db));
  const counter = new SlotCounter(SUITE_PEAK_SESSIONS);
  const conformance = command(fixtureAdapters(), {
    executors: new Map([
      [
        LOCAL_EXECUTOR_ID,
        {
          executor: new LocalExecutor({
            id: LOCAL_EXECUTOR_ID,
            slots: counter,
          }),
          slots: counter,
        },
      ],
    ]),
  });
  const refused = await conformance.handler.handle(
    {
      runner_id: "fixture",
      executor_id: LOCAL_EXECUTOR_ID,
      model_id: "fixture.cheap",
      report_dir: reports(),
      compression: true,
    },
    CMD,
  );
  await conformance.stop();
  expect(refused).toMatchObject({
    ok: false,
    error: {
      class: "validation",
      message: expect.stringContaining(
        "runner fixture does not compress context on executor local",
      ),
    },
  });
  expect(counter.capacity().used).toBe(0);
  expect(unwrap(await listRunnerCertifications(db))).toEqual(before);
});

test(
  "a compression run reaches the suite: test 17 runs, the report says so, and what it stores is the compression-on row, beside the off one",
  { timeout: 180_000 },
  async () => {
    const before = unwrap(await listRunnerCertifications(db));
    // The fixture declaring compression, with no compression scenario in its kit: test 17 cannot
    // pass, so the run is stored but never certified (no passed_at), whatever 1–16 say.
    const fixture = createFixtureAdapter({ graceMs: 500 });
    const conformance = command(
      new Map([
        [
          "fixture",
          { ...fixture, compressesContext: (ex) => ex.kind === "local" },
        ],
      ]),
    );
    const done = await conformance.handler.handle(
      {
        runner_id: "fixture",
        executor_id: LOCAL_EXECUTOR_ID,
        model_id: "fixture.cheap",
        report_dir: reports(),
        compression: true,
      },
      CMD,
    );
    await conformance.stop();
    const result = RunnerConformanceResult.parse(unwrap(done));
    expect(result).toMatchObject({ compression: true, passed_at: null });
    expect(result.summary.unattended_allowed).toBe(false);
    expect([...result.summary.failed, ...result.summary.incomplete]).toContain(
      17,
    );
    expect(result.report_path).toMatch(/@local\+ctx1\.md$/);
    expect(readFileSync(result.report_path, "utf8")).toContain(
      "compression ctx1",
    );
    const after = unwrap(await listRunnerCertifications(db));
    // The compression-off rows are as they were; a compression-on one joined them, uncertified.
    expect(after.filter((c) => c.compression === 0)).toEqual(before);
    expect(after.filter((c) => c.compression === 1)).toMatchObject(
      result.stored
        ? [
            {
              runner_id: "fixture",
              model_id: "fixture.cheap",
              passed_at: null,
            },
          ]
        : [],
    );
  },
);

test("a conformance run on a full executor is refused as busy, and strands no slot", async () => {
  const slots = new SlotCounter(SUITE_PEAK_SESSIONS);
  const executor = new LocalExecutor({ id: LOCAL_EXECUTOR_ID, slots });
  const conformance = command(fixtureAdapters(), {
    executors: new Map([[LOCAL_EXECUTOR_ID, { executor, slots }]]),
  });
  // Every slot taken, as two live sessions would: nothing is left for the suite's peak.
  const held = tryAcquireAll(slots, SUITE_PEAK_SESSIONS);
  expect(held).not.toBeNull();

  const refused = await conformance.handler.handle(
    {
      runner_id: "fixture",
      executor_id: LOCAL_EXECUTOR_ID,
      model_id: "fixture.cheap",
      report_dir: reports(),
    },
    { id: "cmd-busy", attempts: 1 },
  );
  await conformance.stop();

  expect(refused.ok).toBe(false);
  if (!refused.ok) {
    expect(refused.error.class).toBe("admission_refused");
    expect(refused.error.message).toContain("0 of 2 slots free");
    expect(refused.error.message).toContain(
      `the suite needs ${SUITE_PEAK_SESSIONS}`,
    );
  }
  // The refusal took nothing: the sessions that were there still hold exactly what they held.
  expect(slots.capacity()).toEqual({
    slots: SUITE_PEAK_SESSIONS,
    used: SUITE_PEAK_SESSIONS,
  });
  held?.release();
  expect(slots.capacity()).toEqual({ slots: SUITE_PEAK_SESSIONS, used: 0 });
});

// a conformance run takes its credentials as a session does. Before it, the run read
// the host store only, so a runner whose login was granted in place, with no copy in the store, had
// working sessions and a conformance run that could not start — and so could not stay certified.
// The runner here is the fixture under another id whose defaults need one of two credentials, as
// a real runner's do; it records the grant every process start was handed.
const GRANTED_RUNNER = "granted-fixture";
const GRANTED_LOGIN = '{"tokens":{"refresh_token":"r-1"}}';

function grantedFixture(
  seen: SpawnSpec["grantedLogin"][],
  // whether its registration says it reads a login in place.
  reads = true,
): RunnerAdapter {
  const fx = createFixtureAdapter({ graceMs: 500 });
  const reg = fx.registration();
  return {
    ...fx,
    id: GRANTED_RUNNER,
    registration: () => ({
      models: reg.models.map((m) => ({
        ...m,
        id: `${GRANTED_RUNNER}.${m.tier}`,
      })),
      runner: {
        ...reg.runner,
        id: GRANTED_RUNNER,
        adapter: GRANTED_RUNNER,
        defaults: {
          ...reg.runner.defaults,
          secretEnvAnyOf: [["G_KEY"], ["G_LOGIN"]],
          ...(reads ? { readsGrantedLogin: true } : {}),
        },
      },
    }),
    spawn: (spec, ex) => {
      seen.push(spec.grantedLogin);
      return fx.spawn(spec, ex);
    },
    adopt: (spec, ex) => {
      seen.push(spec.grantedLogin);
      return fx.adopt(spec, ex);
    },
  };
}

async function grantLogin(grants: Record<string, string>): Promise<void> {
  unwrap(
    await seedRows(db, {
      settings: [
        {
          key: LOGIN_IN_PLACE_KEY,
          value_json: JSON.stringify(grants),
          updated_at: Date.now(),
        },
      ],
    }),
  );
}

/** The operator's login file, 0600, in the run's temp home. */
function loginFile(): string {
  const dir = realpathSync(mkdtempSync(join(home.path, "login-")));
  const path = join(dir, "auth.json");
  writeFileSync(path, GRANTED_LOGIN, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

const grantedPayload = (report: string) => ({
  runner_id: GRANTED_RUNNER,
  executor_id: LOCAL_EXECUTOR_ID,
  model_id: `${GRANTED_RUNNER}.cheap`,
  report_dir: join(reports(), report),
});

test("a grant whose file is missing refuses the run before it starts, naming the setting, the runner and the path, and never falls back to the store's copy", async () => {
  const seen: SpawnSpec["grantedLogin"][] = [];
  const adapter = grantedFixture(seen);
  unwrap(
    await upsertRegistration(
      db,
      unwrap(registrationRows(adapter.registration())),
    ),
  );
  const path = join(loginFile(), "..", "gone.json");
  await grantLogin({ [GRANTED_RUNNER]: path });
  try {
    const conformance = command(new Map([[GRANTED_RUNNER, adapter]]), {
      kits: () => ok(unwrap(conformanceKit("fixture"))),
      // The copy the fallback would reach for: it must not be used.
      secrets: envSecrets({ FRM_SECRET_G_KEY: "sk-the-host-store-copy" }),
    });
    const refused = await conformance.handler.handle(
      grantedPayload("grant-missing"),
      CMD,
    );
    await conformance.stop();
    expect(refused).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
    const message = refused.ok ? "" : refused.error.message;
    expect(message).toContain(LOGIN_IN_PLACE_KEY);
    expect(message).toContain(GRANTED_RUNNER);
    expect(message).toContain(path);
    expect(JSON.stringify(refused)).not.toContain("sk-the-host-store-copy");
    // Nothing started, and nothing was stored.
    expect(seen).toEqual([]);
    expect(
      unwrap(await listRunnerCertifications(db)).find(
        (c) => c.runner_id === GRANTED_RUNNER,
      ),
    ).toBeUndefined();
  } finally {
    await grantLogin({});
  }
});

test("a grant to a runner that cannot read one refuses the run before it starts, naming the setting and the runner, and never falls back to the store's copy", async () => {
  const seen: SpawnSpec["grantedLogin"][] = [];
  const adapter = grantedFixture(seen, false);
  unwrap(
    await upsertRegistration(
      db,
      unwrap(registrationRows(adapter.registration())),
    ),
  );
  await grantLogin({ [GRANTED_RUNNER]: loginFile() });
  try {
    const conformance = command(new Map([[GRANTED_RUNNER, adapter]]), {
      kits: () => ok(unwrap(conformanceKit("fixture"))),
      // The copy that would let it run on the store: a grant it cannot read must not fall back.
      secrets: envSecrets({ FRM_SECRET_G_KEY: "sk-the-host-store-copy" }),
    });
    const refused = await conformance.handler.handle(
      grantedPayload("grant-unreadable"),
      CMD,
    );
    await conformance.stop();
    expect(refused).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
    const message = refused.ok ? "" : refused.error.message;
    expect(message).toContain(LOGIN_IN_PLACE_KEY);
    expect(message).toContain(GRANTED_RUNNER);
    expect(message).toContain("cannot read a login in place");
    expect(JSON.stringify(refused)).not.toContain("sk-the-host-store-copy");
    // Nothing started, and nothing was stored.
    expect(seen).toEqual([]);
    expect(
      unwrap(await listRunnerCertifications(db)).find(
        (c) => c.runner_id === GRANTED_RUNNER,
      ),
    ).toBeUndefined();
  } finally {
    await grantLogin({});
  }
});

test(
  "a grant and no copy in the host store: the runner certifies through the real command path, every process it starts handed the grant",
  { timeout: 180_000 },
  async () => {
    const seen: SpawnSpec["grantedLogin"][] = [];
    const adapter = grantedFixture(seen);
    unwrap(
      await upsertRegistration(
        db,
        unwrap(registrationRows(adapter.registration())),
      ),
    );
    const path = loginFile();
    await grantLogin({ [GRANTED_RUNNER]: path });
    try {
      const conformance = command(new Map([[GRANTED_RUNNER, adapter]]), {
        kits: () => ok(unwrap(conformanceKit("fixture"))),
        secrets: envSecrets({}), // no G_KEY, no G_LOGIN: the grant is the only credential
      });
      const done = await conformance.handler.handle(
        grantedPayload("granted"),
        CMD,
      );
      await conformance.stop();
      const result = RunnerConformanceResult.parse(unwrap(done));
      expect(result.summary).toMatchObject({
        failed: [],
        incomplete: [],
        certifiable: true,
      });
      expect(result).toMatchObject({
        runner_id: GRANTED_RUNNER,
        stored: true,
      });
      expect(result.passed_at).not.toBeNull();
      expect(seen.length).toBeGreaterThan(0);
      expect(
        seen.filter(
          (g) =>
            g?.path !== path || g.value !== GRANTED_LOGIN || g.mode !== 0o600,
        ),
      ).toEqual([]);
      expect(readFileSync(result.report_path, "utf8")).not.toContain(
        "refresh_token",
      );
    } finally {
      await grantLogin({});
    }
  },
);
