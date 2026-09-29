import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "@bayon/core";
import type { SmokeOptions } from "../cli.js";
import { SMOKE } from "./config.js";
import {
  Harness,
  StepFailure,
  refuse,
  seconds,
  type SmokeIo,
} from "./harness.js";
import { m1 } from "./m1-phases.js";
import { M2_MISSIONS, m2Config } from "./m2-config.js";
import { m2 } from "./m2-phases.js";
import { ctrTarget, newCtrRun, type CtrRun } from "./m3-ctr-host.js";
import { m3Container } from "./m3-ctr-phases.js";
import { ctrBeforeSupervisor } from "./m3-ctr-setup.js";
import { m3 } from "./m3-phases.js";
import { m4Config } from "./m4-config.js";
import { m4 } from "./m4-phases.js";
import { schemaStandIn, standInEnv, type StandIn } from "./m3-stand-in.js";
import {
  apiRestart,
  buildSession,
  setUp,
  type SetUpOptions,
  type World,
} from "./phases.js";
import { logTail } from "./procs.js";
import { chooseRunner } from "./runner.js";
import { repoRoot } from "./stack.js";
import { ADMISSION_SETTING_KEYS } from "@bayon/core";
import { seedConfig } from "@bayon/db/operator";
import { FIXTURE_RUNNER_ID } from "@bayon/runners/fixture";
import { ALL_TIERS, certify } from "./certify.js";

export type { SmokeIo } from "./harness.js";

// `frm smoke` (FOR-10, the M0 acceptance test): a fresh FRM_HOME, a fixture repo, the supervisor
// and the API as child processes, one session driven to `terminal` and checked, then an API
// restart under a second, open session. Resolves to the exit code; never throws.

function asFailure(thrown: unknown): StepFailure {
  if (thrown instanceof StepFailure) return thrown;
  const message =
    thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown);
  return new StepFailure("unexpected error", {
    class: "internal",
    message,
    retryable: false,
  });
}

function report(h: Harness, failure: StepFailure): void {
  h.io.out(`FAIL  ${failure.message}`);
  for (const log of ["supervisor", "api"])
    h.io.out(
      `----- ${log}.log (tail) -----\n${logTail(join(h.home, "logs", `${log}.log`), 15)}`,
    );
  for (const note of h.notes()) h.io.out(`note  ${note}`);
}

/**
 * Where --m3 reviews: null for the smoke's local executor, else the executor name of its container
 * run, which touches the shared docker host and so needs FRM_CONTAINER=1 as well. The plain --m3
 * stays local and fast.
 */
export function m3Placement(
  options: SmokeOptions,
  env: SmokeIo["env"],
): Result<string | null> {
  if (options.mode !== "m3") return ok(null);
  const executor = options.executor;
  if (executor === undefined || executor === SMOKE.executor) return ok(null);
  if (env["FRM_CONTAINER"] !== "1") {
    return err(
      refuse(
        `--m3 --executor ${executor} runs on the shared docker host: set FRM_CONTAINER=1 to opt in`,
      ),
    );
  }
  return ok(executor);
}

interface Container {
  readonly run: CtrRun;
  readonly frmEntry: string;
}

/** What setUp seeds for this mode; M3's supervisor finds the reviewer's stand-in on its PATH. */
function setUpOptions(
  options: SmokeOptions,
  io: SmokeIo,
  standIn: StandIn | undefined,
  container: Container | undefined,
): SetUpOptions {
  if (options.mode === "m2") return { config: m2Config, missions: M2_MISSIONS };
  // --m4 has its own agents (m4-config.ts) and saves no missions: none of them is an orchestrator.
  if (options.mode === "m4") return { config: m4Config, missions: [] };
  if (standIn === undefined) return {};
  if (container !== undefined) {
    return {
      missions: [],
      beforeSupervisor: (h, db) =>
        ctrBeforeSupervisor(h, db, { ...container, standIn }),
    };
  }
  return {
    missions: [],
    beforeSupervisor: (h) =>
      h.step(
        "the reviewer's stand-in first on the supervisor's PATH",
        async () => standInEnv(h.home, standIn, io.env["PATH"] ?? ""),
      ),
  };
}

/** Printed at the start and in the report of a smoke that runs a real runner uncertified. */
export const UNCERTIFIED_BANNER =
  "!!! ADMISSION: require_certified=0 — this runner is NOT certified in this run";

/**
 * 012's admission.require_certified=1: the fixture runner every smoke spawns
 * (its gated and hang agents always use it) is certified over REST first. A real runner is certified
 * only with --certify (the §15 suite, real spend); without it the smoke seeds require_certified=0,
 * never imports a certification, and says so out loud. Resolves to the banner to repeat, if any.
 */
async function admissionReady(
  w: World,
  options: SmokeOptions,
): Promise<string | undefined> {
  if (w.runnerId !== FIXTURE_RUNNER_ID && !options.certify) {
    w.h.io.out(UNCERTIFIED_BANNER);
    await w.h.step(
      "admission.require_certified=0: a real runner without --certify",
      () =>
        seedConfig(w.db, {
          settings: { [ADMISSION_SETTING_KEYS.requireCertified]: 0 },
        }),
    );
    return UNCERTIFIED_BANNER;
  }
  // The fixture's suite is free, and its sessions run several tiers: every model of it.
  await certify(w, FIXTURE_RUNNER_ID, "", ALL_TIERS);
  if (w.runnerId !== FIXTURE_RUNNER_ID) await certify(w, w.runnerId);
  return undefined;
}

async function runMode(
  world: World,
  options: SmokeOptions,
  standIn: StandIn | undefined,
  container: Container | undefined,
): Promise<void> {
  switch (options.mode) {
    case "m1":
      return m1(world);
    case "m2":
      return m2(world);
    case "m3":
      if (standIn === undefined) throw new Error("--m3 has no stand-in");
      return container === undefined
        ? m3(world, {
            schemaRunner: standIn.runnerId,
            reviewExecutor: SMOKE.executor,
          })
        : m3Container(world, {
            run: container.run,
            schemaRunner: standIn.runnerId,
          });
    case "m4":
      return m4(world);
    case "hang":
      return buildSession(world, true);
    case "normal":
      await buildSession(world, false);
      return apiRestart(world);
  }
}

/** The container run's executor, host and CLI, once FRM_HOME exists (its host key goes there). */
function containerOf(
  name: string,
  env: SmokeIo["env"],
  home: string,
): Result<Container> {
  const target = ctrTarget(env);
  if (!target.ok) return target;
  const root = repoRoot();
  if (!root.ok) return root;
  const run = newCtrRun(name, target.value, home);
  if (!run.ok) return run;
  return ok({
    run: run.value,
    frmEntry: join(root.value, "tools", "frm", "dist", "main.js"),
  });
}

/**
 * Where a smoke's FRM_HOME is made. Short on purpose: the supervisor's socket lives in FRM_HOME, and
 * socket paths cap at 104 bytes. Smoke-specific: other tests share /tmp/frm-*; the smoke removes only
 * its own directory. Never the default home, so the smoke's stack reads its own Keychain service,
 * not the live install's.
 */
export const SMOKE_HOME_PREFIX = "/tmp/frm-smoke-";

export async function runSmoke(
  options: SmokeOptions,
  io: SmokeIo,
): Promise<number> {
  const runner = chooseRunner(options.runner, io.env);
  if (!runner.ok) {
    io.out(`FAIL  ${runner.error.message}`);
    return 1;
  }
  const placement = m3Placement(options, io.env);
  if (!placement.ok) {
    io.out(`FAIL  ${placement.error.message}`);
    return 1;
  }
  const found = options.mode === "m3" ? schemaStandIn() : undefined;
  if (found !== undefined && !found.ok) {
    io.out(`FAIL  ${found.error.message}`);
    return 1;
  }
  const standIn = found?.value;
  const home = mkdtempSync(SMOKE_HOME_PREFIX);
  mkdirSync(join(home, "logs"));
  const made =
    placement.value === null
      ? ok(undefined)
      : containerOf(placement.value, io.env, home);
  if (!made.ok) {
    rmSync(home, { recursive: true, force: true });
    io.out(`FAIL  ${made.error.message}`);
    return 1;
  }
  const container = made.value;
  const mode =
    options.mode === "normal"
      ? ""
      : ` · ${options.mode}${container === undefined ? "" : ` · container ${container.run.executorId} on ${container.run.target.host}`}`;
  io.out(`frm smoke · runner ${runner.value}${mode} · FRM_HOME=${home}`);
  const t0 = io.clock.now();
  const h = new Harness(io, home);
  let failure: StepFailure | undefined;
  let banner: string | undefined;
  try {
    const world = await setUp(
      h,
      runner.value,
      setUpOptions(options, io, standIn, container),
    );
    // Every mode, the container run included: its builders run the fixture runner on local.
    banner = await admissionReady(world, options);
    await runMode(world, options, standIn, container);
  } catch (thrown) {
    failure = asFailure(thrown);
  }
  const leftovers = await h.teardown();
  if (failure) report(h, failure);
  for (const leftover of leftovers) io.out(`FAIL  ${leftover}`);
  const passed = failure === undefined && leftovers.length === 0;
  if (passed && !options.keep) rmSync(home, { recursive: true, force: true });
  else io.out(`FRM_HOME kept at ${home}`);
  if (banner !== undefined) io.out(banner);
  io.out(
    `smoke ${passed ? "passed" : "FAILED"} in ${seconds(io.clock.now() - t0)}`,
  );
  return passed ? 0 : 1;
}
