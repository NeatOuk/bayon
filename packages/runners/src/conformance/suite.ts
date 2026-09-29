// runConformance (§15): the tests against one runner with one model on one executor, through
// the given ports. Each test's status follows amendment (a): its gating cap declared → pass/fail;
// declared absent → its fallback, N/A only if that holds. The draft goes through core `certify`,
// which recomputes the summary; the result is what an earlier change stores per (runner, executor).
import {
  CONFORMANCE_TEST_NAMES,
  CONTEXT_RULESET,
  GATING_CAP,
  SUITE_VERSION,
  canonicalJson,
  certify,
  sha256Hex,
  type ConformanceResult,
  type ConformanceTestId,
  type ConformanceTestResult,
  type JsonValue,
  type Result,
  err,
  ok,
} from "@bayon/core";
import { frmError } from "../errors.js";
import { PREFLIGHT_TIMEOUT_MS, preflightModel } from "../preflight.js";
import type { ExecutorKind } from "@bayon/executors";
import { CallTimeout, Incomplete, StepFailed, SuiteCtx } from "./harness.js";
import {
  check,
  clip,
  type Branch,
  type ConformanceTest,
} from "./tests/define.js";
import { COMPRESSION_TESTS, TESTS } from "./tests/index.js";
import {
  SCENARIO_NAMES,
  type Check,
  type CompressionVars,
  type ConformanceKit,
  type ConformanceOptions,
  type ConformancePorts,
  type ConformanceSubject,
  type ScenarioVars,
} from "./types.js";

const PLACEHOLDERS: ScenarioVars = {
  nonce: "{nonce}",
  mcpTool: "{mcpTool}",
  marker: "{marker}",
  roots: ["{root}"],
  outside: "{outside}",
  rootMarker: "{rootMarker}",
};

/** Test 17's scenario, rendered for the hash (spec M12). */
const COMPRESSION_PLACEHOLDERS: CompressionVars = {
  nonce: "{nonce}",
  logFile: "{logFile}",
  jsonFile: "{jsonFile}",
};

/** Every executor kind, so a kit's per-kind declarations hash whatever this run ran on. */
const EXECUTOR_KINDS: readonly ExecutorKind[] = [
  "local",
  "container",
  "remote",
];

/**
 * `sha256:` of the kit's canonical JSON with the model the run spawns (and its settings, when it
 * has any), every scenario rendered with
 * placeholders (§8.1). The model comes from the suite's subject, not the kit, under the
 * key the kit's own model had: a certificate stored before certification was per model hashes the
 * same for the model it was earned on, and so keeps applying to that model alone (spec v67).
 */
export async function kitHash(
  kit: ConformanceKit,
  model: string,
  modelSettings: Readonly<Record<string, unknown>> = {},
  compression?: { readonly ruleset: string },
): Promise<string> {
  const described = {
    runnerId: kit.runnerId,
    model,
    // The model's own adapter settings (e.g. the provider URL it runs on) are part of
    // what was certified. Only a model that has some adds the key, so every certificate of a model
    // with none — all of them before operator models — hashes exactly as before and holds.
    ...(Object.keys(modelSettings).length === 0 ? {} : { modelSettings }),
    scenarios: Object.fromEntries(
      SCENARIO_NAMES.map((name) => [name, kit.scenario(name, PLACEHOLDERS)]),
    ),
    unknownLines: kit.unknownLines(PLACEHOLDERS.nonce),
    // A declaration a test may report N/A on is a kit input like any other (§15 #16): change it
    // and the certification lapses.
    grantsExtraRoots: Object.fromEntries(
      EXECUTOR_KINDS.map((kind) => [kind, kit.grantsExtraRoots(kind)]),
    ),
    // Spec M12: a compression-on certificate is pinned to its ruleset and test 17's scenario. Only a
    // run with compression on adds the key, so every compression-off hash is exactly as before and
    // a new ruleset lapses the compression-on certificates alone.
    ...(compression === undefined
      ? {}
      : {
          compression: {
            ruleset: compression.ruleset,
            scenario:
              kit.compressionScenario?.(COMPRESSION_PLACEHOLDERS) ?? null,
          },
        }),
  };
  const json: JsonValue = JSON.parse(JSON.stringify(described));
  return `sha256:${await sha256Hex(canonicalJson(json))}`;
}

/**
 * The model pre-flight: before any test, whether the provider serves the model, asked
 * as a session of the run would spawn (the plain scenario's flags and env). Fails closed: a model
 * not served, or a provider that does not answer, refuses the run in seconds instead of failing
 * every test on the runner's own call. An adapter without the hook, or one that cannot check this
 * target, runs as before.
 */
async function preflight(
  subject: ConformanceSubject,
  budgets: ConformanceOptions["budgets"],
  clock: ConformancePorts["clock"],
): Promise<Result<void>> {
  const plain = subject.kit.scenario("plain", PLACEHOLDERS);
  const verdict = await preflightModel(
    subject.adapter,
    {
      model: subject.model,
      ...(subject.modelSettings === undefined
        ? {}
        : { modelSettings: subject.modelSettings }),
      flags: plain.flags,
      env: { ...subject.env, ...plain.env },
      executorKind: subject.executor.kind,
    },
    { timeoutMs: Math.min(PREFLIGHT_TIMEOUT_MS, budgets.callMs), clock },
  );
  switch (verdict.verdict) {
    case "served":
    case "unchecked":
      return ok(undefined);
    case "not_served":
      return err(frmError("runner_error", verdict.reason));
    case "unreachable":
      return err(
        frmError(
          "runner_error",
          `the model pre-flight could not confirm ${subject.model}: ${verdict.reason}`,
          { retryable: true },
        ),
      );
  }
}

interface Attempt {
  readonly checks: readonly Check[];
  readonly incomplete?: string;
}

const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

async function attempt(
  ctx: SuiteCtx,
  test: ConformanceTest,
  branch: Branch,
  n: number,
): Promise<Attempt> {
  let checks: readonly Check[] = [];
  let incomplete: string | undefined;
  try {
    checks = await test.run(ctx, branch, n);
  } catch (e) {
    if (e instanceof Incomplete) incomplete = e.reason;
    else if (e instanceof CallTimeout)
      checks = [check(`call_timeout:${e.method}`, false)];
    else if (e instanceof StepFailed)
      checks = [check(e.check, false, e.detail)];
    else checks = [check("threw", false, messageOf(e))];
  }
  const missed = await ctx.teardown();
  return {
    checks: [
      ...checks,
      ...missed.map((m) => check(`call_timeout:${m}`, false)),
    ],
    ...(incomplete === undefined ? {} : { incomplete }),
  };
}

/** One retry, for a model-dependent test whose only failures are preconditions. */
function retryable(
  test: ConformanceTest,
  a: Attempt,
  attempts: number,
): boolean {
  const failing = a.checks.filter((c) => !c.ok);
  return (
    attempts <= test.retries &&
    a.incomplete === undefined &&
    failing.length > 0 &&
    failing.every((c) => c.precondition === true)
  );
}

function stored(c: Check): ConformanceTestResult["checks"][number] {
  return { name: c.name, ok: c.ok, detail: c.detail };
}

/** Attempts until one is final: at most one retry, for a failed precondition only. */
async function attemptAll(
  ctx: SuiteCtx,
  test: ConformanceTest,
  branch: Branch,
): Promise<{ readonly last: Attempt; readonly attempts: number }> {
  for (let n = 1; ; n += 1) {
    const last = await attempt(ctx, test, branch, n - 1);
    if (!retryable(test, last, n)) return { last, attempts: n };
  }
}

async function runTest(
  ctx: SuiteCtx,
  test: ConformanceTest,
): Promise<ConformanceTestResult> {
  const cap = GATING_CAP[test.id];
  const declared = test.declaredFallback(
    ctx.subject.kit,
    ctx.subject.executor.kind,
  );
  const branch: Branch =
    (cap !== undefined && !ctx.caps[cap]) || declared ? "fallback" : "cap";
  const t0 = ctx.clock.now();
  const { last, attempts } = ctx.exhausted
    ? {
        last: { checks: [], incomplete: "budget spent before this test" },
        attempts: 0,
      }
    : await attemptAll(ctx, test, branch);
  const checks =
    last.checks.length === 0 && last.incomplete === undefined
      ? [check("no_checks", false)]
      : last.checks;
  const allOk = checks.every((c) => c.ok);
  const status =
    last.incomplete !== undefined
      ? "incomplete"
      : !allOk
        ? "fail"
        : branch === "cap"
          ? "pass"
          : "na";
  return {
    id: test.id,
    name: CONFORMANCE_TEST_NAMES[test.id],
    status,
    attempts,
    duration_ms: Math.max(0, Math.round(ctx.clock.now() - t0)),
    fallback:
      status === "na"
        ? (test.fallback(ctx.caps) ?? `${String(cap)}=false; its fallback held`)
        : null,
    checks: [
      ...checks.map(stored),
      ...(last.incomplete === undefined
        ? []
        : [{ name: "incomplete", ok: false, detail: clip(last.incomplete) }]),
    ],
  };
}

const unrun = (
  id: ConformanceTestId,
  c: ConformanceTestResult["checks"][number],
): ConformanceTestResult => ({
  id,
  name: CONFORMANCE_TEST_NAMES[id],
  status: "incomplete",
  attempts: 0,
  duration_ms: 0,
  fallback: null,
  checks: [c],
});

const notRun = (id: ConformanceTestId): ConformanceTestResult =>
  unrun(id, { name: "not_run", ok: false, detail: "not in options.only" });

/** A test the harness itself failed in, or never reached after that. */
const halted = (id: ConformanceTestId, reason: string): ConformanceTestResult =>
  unrun(id, { name: "incomplete", ok: false, detail: clip(reason) });

/**
 * Runs the suite. Every adapter and executor call is under `budgets.callMs`; a spent `maxUsd`
 * leaves the remaining tests `incomplete`, and so does a failure of the harness itself (a
 * teardown, a port), which keeps the results so far. Resolves with core `certify`'s
 * result.
 */
export async function runConformance(
  subject: ConformanceSubject,
  ports: ConformancePorts,
  options: ConformanceOptions,
): Promise<Result<ConformanceResult>> {
  const compression =
    options.compression === true ? { ruleset: CONTEXT_RULESET } : undefined;
  if (
    compression !== undefined &&
    subject.adapter.compressesContext?.(subject.executor) !== true
  ) {
    return err(
      frmError(
        "validation",
        `${subject.adapter.id} does not compress context on a ${subject.executor.kind} executor: nothing to certify with compression on`,
      ),
    );
  }
  const served = await preflight(subject, options.budgets, ports.clock);
  if (!served.ok) return served;
  const ctx = new SuiteCtx(subject, ports, options.budgets, compression);
  const startedAt = Math.round(ports.clock.now());
  const version = await ctx
    .call("version", subject.adapter.version())
    .catch(() => "");
  const tests: ConformanceTestResult[] = [];
  let stopped: string | undefined;
  for (const test of compression === undefined
    ? TESTS
    : [...TESTS, ...COMPRESSION_TESTS]) {
    if (options.only !== undefined && !options.only.includes(test.id)) {
      tests.push(notRun(test.id));
    } else if (stopped !== undefined) {
      tests.push(halted(test.id, `not run: ${stopped}`));
    } else {
      try {
        const result = await runTest(ctx, test);
        if (result.status === "fail") {
          const blocker = subject.kit.blocker?.(await ctx.errorMessages());
          if (blocker !== undefined && blocker !== null) {
            tests.push({
              ...result,
              checks: [
                ...result.checks,
                { name: "runner_version", ok: false, detail: clip(blocker) },
              ],
            });
            stopped = blocker;
            continue;
          }
        }
        tests.push(result);
      } catch (e) {
        stopped = `the harness failed in test ${test.id}: ${messageOf(e)}`;
        tests.push(halted(test.id, stopped));
        // What that test opened, stopped as far as the harness still can; its reason is the one
        // above. The caller's FaultExecutor.end() is the backstop for anything this misses.
        await ctx.teardown().catch(() => undefined);
      }
    }
  }
  return certify({
    schema: 1,
    suite_version: SUITE_VERSION,
    runner_id: subject.adapter.id,
    runner_version: version.trim() === "" ? "unknown" : version.trim(),
    model: subject.model,
    executor: {
      id: subject.executor.id,
      kind: subject.executor.kind,
      // What the runner was certified *inside*, where the executor has such a thing.
      // Read after the tests, so it is the image the suite actually ran on. A null here is no
      // longer a shrug: on a container it is the pair's only pin, so `certify` refuses the run
      // unattended and the report says so. Saying *which* failure produced the
      // null is the executor's job — ContainerExecutor.imageIdentity leaves a diagnostic on every
      // path to it — because the suite has nowhere to put one and a half-read id must never reach
      // a certification.
      image_id:
        (await subject.executor.imageIdentity?.().catch(() => null)) ?? null,
    },
    started_at: startedAt,
    finished_at: Math.max(startedAt, Math.round(ports.clock.now())),
    kit_hash: await kitHash(
      subject.kit,
      subject.model,
      subject.modelSettings,
      compression,
    ),
    ...(compression === undefined ? {} : { compression }),
    ports: {
      ingest: ports.ingest.source,
      watchdog: ports.watchdog.source,
      mcp: ports.mcp.source,
      workspace: ports.workspace.source,
    },
    caps: ctx.caps,
    spend: {
      tokens_in: Math.round(ctx.spent.tokens_in),
      tokens_out: Math.round(ctx.spent.tokens_out),
      cost_usd: ctx.spent.cost_usd,
    },
    tests,
  });
}
