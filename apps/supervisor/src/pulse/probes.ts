// The probe runner (§10.2): runs probes and returns their results; it writes no row. The pulse
// scheduler and the probe.run handler record them with insertPulseChecks (§9.5).
//   sql    names a query in @bayon/db (runProbeQuery); a row never carries SQL (Invariant 6).
//   shell  argv through the executor in each mirror or in $FRM_HOME/logs, under timeout_ms. Its
//          lines become findings; past the cap (8 KB / 200 lines) the whole output goes to
//          result_path (Invariant 9).
//   http, script_runner: refused (validation) until a later milestone.
// Every result_json says whether its content is untrusted (probes.untrusted_output), so the context
// pack fences it; a shell probe's stderr stays inside result_json for the same reason.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  err,
  newId,
  ok,
  type Clock,
  type JsonValue,
  type Result,
} from "@bayon/core";
import {
  getProbe,
  listProbes,
  listRepos,
  runProbeQuery,
  type Db,
  type ProbeRow,
  type PulseCheckRow,
  type PulseCheckState,
} from "@bayon/db";
import {
  tryAcquireAll,
  type Executor,
  type SlotCounter,
} from "@bayon/executors";
import { z } from "zod";
import { logsDir, probeOutputDir } from "../paths.js";
import {
  clip,
  fingerprintOf,
  fitResult,
  lineFindings,
  overCap,
} from "./probe-findings.js";
import {
  STDOUT_MAX_BYTES,
  describeThrown,
  runArgv,
  type ArgvRun,
} from "./probe-shell.js";

/** One probe's result: a pulse_checks row without its id and pulse. */
export type ProbeResult = Omit<PulseCheckRow, "id" | "pulse_id">;

/**
 * an earlier change design §9. `names` absent = the enabled every_pulse probes; each under its timeout_ms;
 * never throws. The same call serves probe.run with names=[probe]; the caller inserts the results
 * via insertPulseChecks. A named probe that is missing (`not_found`) or disabled (`validation`)
 * fails the call; a probe that fails is an `error`/`timeout` result, never a failed call.
 */
export interface ProbeRunner {
  run(a: {
    pulseId: string;
    names?: readonly string[];
    signal: AbortSignal;
  }): Promise<Result<readonly ProbeResult[]>>;
}

export interface ProbeRunnerDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly executor: Executor;
  /**
   * `executor`'s slots. A shell probe runs a real program on the executor without going through
   * admission, so it takes a slot for its duration and is refused when there is none:
   * on a shared host a probe must not push the executor past the cap admission believes in.
   * Required, not optional — a probe runner that could be built without it would silently be the
   * one that oversubscribes.
   */
  readonly slots: SlotCounter;
  readonly home: string;
  /** PATH for shell probes, whose entire env is PATH and LC_ALL=C: no secret reaches one (§14). */
  readonly path: string;
}

/** Stderr a shell check keeps in its result_json. */
const STDERR_CHARS = 500;
/** A pulse id names a directory under runtime/pulses/. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const SqlSpec = z.strictObject({ query: z.string().min(1).max(64) });
const ShellSpec = z.strictObject({
  argv: z.tuple([z.string().min(1)], z.string()),
  cwd: z.enum(["mirrors", "logs"]),
});

interface Outcome {
  readonly state: PulseCheckState;
  readonly result_json: string | null;
  readonly result_path: string | null;
  readonly error: string | null;
}

interface RunCtx {
  readonly d: ProbeRunnerDeps;
  readonly pulseId: string;
  readonly signal: AbortSignal;
  /**
   * Whether this pass holds its executor slot. One slot covers the whole pass, not each
   * probe: probes run concurrently, so a slot each would have them starve one another on any
   * executor with fewer slots than probes. False means the executor was already full and every
   * shell probe in the pass is refused; sql probes never look at it.
   */
  readonly shellAllowed: boolean;
}

const failed = (error: string): Outcome => ({
  state: "error",
  result_json: null,
  result_path: null,
  error,
});

const INTERRUPTED = "interrupted: the run was cancelled";

/** A shell probe the pass could not take a slot for: the executor is at the cap admission keeps. */
const SHELL_REFUSED = (d: ProbeRunnerDeps): string => {
  const { slots, used } = d.executor.capacity();
  return `admission_refused: executor ${d.executor.id} is full (${used} of ${slots} slots used): the shell probe did not run`;
};

function parseSpec<T>(schema: z.ZodType<T>, probe: ProbeRow): Result<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(probe.spec_json);
  } catch {
    raw = undefined;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success
    ? ok(parsed.data)
    : err({
        class: "validation",
        message: `bad ${probe.kind} spec_json: ${z.prettifyError(parsed.error)}`,
        retryable: false,
      });
}

/** Writes `text` whole under the pulse's probe directory, operator-only; returns its path. */
function keep(ctx: RunCtx, text: string): Result<string> {
  const dir = probeOutputDir(ctx.d.home, ctx.pulseId);
  const path = join(dir, `${newId(ctx.d.clock.now())}.txt`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, text, { mode: 0o600 });
    return ok(path);
  } catch (thrown) {
    return err({
      class: "internal",
      message: `cannot keep a probe's full output: ${describeThrown(thrown)}`,
      retryable: false,
    });
  }
}

/** The check's row fields: findings within the cap, and the whole `full` text (or every finding)
 * on disk when something did not fit. */
function record(
  ctx: RunCtx,
  probe: ProbeRow,
  o: {
    readonly findings: readonly JsonValue[];
    readonly full: string | null;
    readonly extra: { readonly [key: string]: JsonValue };
    readonly state: PulseCheckState;
    readonly error: string | null;
  },
): Outcome {
  const fitted = fitResult(
    { untrusted: probe.untrusted_output === 1, ...o.extra },
    o.findings,
  );
  const spill =
    fitted.omitted > 0 || (o.full !== null && overCap(o.full))
      ? (o.full ?? JSON.stringify(o.findings))
      : null;
  const kept = spill === null ? null : keep(ctx, spill);
  if (kept !== null && !kept.ok) {
    return {
      state: "error",
      result_json: fitted.json,
      result_path: null,
      error: kept.error.message,
    };
  }
  return {
    state: o.state,
    result_json: fitted.json,
    result_path: kept?.value ?? null,
    error: o.error,
  };
}

async function runSql(ctx: RunCtx, probe: ProbeRow): Promise<Outcome> {
  const spec = parseSpec(SqlSpec, probe);
  if (!spec.ok) return failed(`validation: ${spec.error.message}`);
  if (ctx.signal.aborted) return failed(INTERRUPTED);
  const found = await runProbeQuery(ctx.d.db, spec.value.query);
  if (!found.ok) return failed(`${found.error.class}: ${found.error.message}`);
  const findings = found.value.map((f) => ({
    fingerprint: fingerprintOf(probe.name, f.subject),
    subject: f.subject,
    facts: f.facts,
  }));
  return record(ctx, probe, {
    findings,
    full: null,
    extra: {},
    state: "ok",
    error: null,
  });
}

interface ShellDir {
  /** The repo a mirrors probe ran in, prefixed to its lines; null for logs. */
  readonly label: string | null;
  readonly dir: string;
}

async function shellDirs(
  d: ProbeRunnerDeps,
  cwd: "mirrors" | "logs",
): Promise<Result<readonly ShellDir[]>> {
  if (cwd === "logs") {
    const dir = logsDir(d.home);
    return ok(existsSync(dir) ? [{ label: null, dir }] : []);
  }
  const repos = await listRepos(d.db);
  return repos.ok
    ? ok(repos.value.map((r) => ({ label: r.name, dir: r.mirror_path })))
    : repos;
}

/** Why one run is not clean, if it is not. Exit 1 with no stderr is grep's "no match". */
function problemOf(run: ArgvRun): string | null {
  if (run.spawnError !== null) return `cannot start: ${run.spawnError}`;
  if (run.overflow) return `stdout passed ${STDOUT_MAX_BYTES} bytes: killed`;
  const { code, signal } = run.status ?? { code: null, signal: null };
  if (signal !== null) return `killed by ${signal}`;
  if (code === 0 || (code === 1 && run.stderr.trim() === "")) return null;
  return `exit ${String(code)}`;
}

const prefixLines = (label: string, text: string): string =>
  text
    .split("\n")
    .map((line) => (line === "" ? line : `${label}: ${line}`))
    .join("\n");

/** Runs the argv in each directory in turn, all under one timeout_ms deadline. */
async function runInDirs(
  ctx: RunCtx,
  probe: ProbeRow,
  argv: readonly [string, ...string[]],
  dirs: readonly ShellDir[],
): Promise<{
  readonly runs: readonly (ShellDir & { readonly run: ArgvRun })[];
  readonly timedOut: boolean;
}> {
  const deadline = new AbortController();
  const timer = new AbortController();
  let timedOut = false;
  ctx.d.clock.after(probe.timeout_ms, timer.signal).then(
    () => {
      timedOut = true;
      deadline.abort();
    },
    () => undefined, // the probe ended first
  );
  const signal = AbortSignal.any([ctx.signal, deadline.signal]);
  const env = { PATH: ctx.d.path, LC_ALL: "C" };
  let runs: readonly (ShellDir & { readonly run: ArgvRun })[] = [];
  try {
    for (const dir of dirs) {
      const run = existsSync(dir.dir)
        ? await runArgv({
            executor: ctx.d.executor,
            argv,
            cwd: dir.dir,
            env,
            signal,
          })
        : {
            stdout: "",
            stderr: "",
            status: null,
            overflow: false,
            spawnError: `no directory ${dir.dir}`,
          };
      runs = [...runs, { ...dir, run }];
    }
  } finally {
    timer.abort();
  }
  return { runs, timedOut };
}

async function runShell(ctx: RunCtx, probe: ProbeRow): Promise<Outcome> {
  const spec = parseSpec(ShellSpec, probe);
  if (!spec.ok) return failed(`validation: ${spec.error.message}`);
  const dirs = await shellDirs(ctx.d, spec.value.cwd);
  if (!dirs.ok) return failed(`${dirs.error.class}: ${dirs.error.message}`);
  const { runs, timedOut } = await runInDirs(
    ctx,
    probe,
    spec.value.argv,
    dirs.value,
  );
  const stdout = runs
    .map(({ label, run }) =>
      label === null ? run.stdout : prefixLines(label, run.stdout),
    )
    .join("\n");
  const problems = runs.flatMap(({ label, run }) => {
    const problem = problemOf(run);
    return problem === null
      ? []
      : [label === null ? problem : `${label}: ${problem}`];
  });
  const stderr = clip(
    runs
      .map(({ run }) => run.stderr.trim())
      .filter((s) => s !== "")
      .join("\n"),
    STDERR_CHARS,
  );
  const [state, error]: readonly [PulseCheckState, string | null] = timedOut
    ? ["timeout", `timeout: over ${probe.timeout_ms} ms`]
    : ctx.signal.aborted
      ? ["error", INTERRUPTED]
      : problems.length > 0
        ? ["error", problems.join("; ")]
        : ["ok", null];
  return record(ctx, probe, {
    findings: lineFindings(probe.name, stdout),
    full: stdout,
    extra: stderr === "" ? {} : { stderr },
    state,
    error,
  });
}

async function runOne(ctx: RunCtx, probe: ProbeRow): Promise<ProbeResult> {
  const started = ctx.d.clock.now();
  let outcome: Outcome;
  try {
    outcome =
      probe.kind === "sql"
        ? await runSql(ctx, probe)
        : probe.kind === "shell"
          ? ctx.shellAllowed
            ? await runShell(ctx, probe)
            : failed(SHELL_REFUSED(ctx.d))
          : failed(
              `validation: a ${probe.kind} probe is not run yet; M2 runs sql and shell probes`,
            );
  } catch (thrown) {
    outcome = failed(`internal: ${describeThrown(thrown)}`);
  }
  return {
    name: probe.name,
    duration_ms: Math.max(0, ctx.d.clock.now() - started),
    ...outcome,
  };
}

async function selectProbes(
  db: Db,
  names: readonly string[] | undefined,
): Promise<Result<readonly ProbeRow[]>> {
  if (names === undefined) {
    const enabled = await listProbes(db, { enabledOnly: true });
    return enabled.ok
      ? ok(enabled.value.filter((p) => p.every_pulse === 1))
      : enabled;
  }
  let rows: readonly ProbeRow[] = [];
  for (const name of names) {
    const row = await getProbe(db, name);
    if (!row.ok) return row;
    if (row.value.enabled !== 1) {
      return err({
        class: "validation",
        message: `probe ${name} is disabled`,
        retryable: false,
      });
    }
    rows = [...rows, row.value];
  }
  return ok(rows);
}

export function createProbeRunner(d: ProbeRunnerDeps): ProbeRunner {
  return {
    async run(a) {
      if (!SAFE_ID.test(a.pulseId)) {
        return err({
          class: "validation",
          message: `not a pulse id: ${JSON.stringify(a.pulseId.slice(0, 80))}`,
          retryable: false,
        });
      }
      const probes = await selectProbes(d.db, a.names);
      if (!probes.ok) return probes;
      // One slot for the whole pass, taken only when a shell probe is actually in it, and held
      // until every probe has finished: probes run concurrently, so claiming per probe would make
      // them refuse each other on an executor with fewer slots than probes.
      const needsExecutor = probes.value.some((p) => p.kind === "shell");
      const slot = needsExecutor ? tryAcquireAll(d.slots, 1) : null;
      const ctx: RunCtx = {
        d,
        pulseId: a.pulseId,
        signal: a.signal,
        shellAllowed: !needsExecutor || slot !== null,
      };
      try {
        return ok(await Promise.all(probes.value.map((p) => runOne(ctx, p))));
      } finally {
        slot?.release();
      }
    },
  };
}
