// `frm start`: the supervisor, the API and the GUI's dev server for one home, from one
// terminal. Each is an ordinary child with FRM_HOME set, so each reads this home's install.json and
// Keychain service exactly as it does when started by hand; nothing here decides a port or a token.
//
// It refuses a home something already runs on, then runs the migrations (the API refuses a
// database with some pending) and starts the three. Each child's output goes to a fresh
// $FRM_HOME/logs/<name>.log, the previous one kept as <name>.log.1 (the supervisor writes JSON,
// which the log_scan probe reads there). Each child leads its own process group, so the terminal's
// Ctrl-C or hang-up reaches frm alone; frm then stops them in order, awaiting each: the GUI, the
// API, then the supervisor, which gets a longer grace (it may be finishing a backup) before any
// SIGKILL. Agents are in sessions of their own (setsid), never a child's group, and are adopted on
// the next start. One child exiting stops the rest.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { err, ok, systemClock, type Clock, type Result } from "@bayon/core";
import { portFree, type ApiTokenOptions } from "@bayon/executors";
import { shownHome } from "./home.js";
import {
  checkNotRunning,
  checkToken,
  repoRootOf,
  startPlan,
  type ChildPlan,
  type StartPlan,
} from "./start-plan.js";

export const START_USAGE = [
  "       frm start",
  "             starts the supervisor, the API and the GUI for FRM_HOME (run pnpm frm init once",
  "             first), prints the GUI's address, and logs to $FRM_HOME/logs; Ctrl-C stops all three",
] as const;

type Env = Readonly<Record<string, string | undefined>>;

/** Ctrl-C, a plain kill, and the terminal closing. */
export const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
type StopSignal = (typeof STOP_SIGNALS)[number];

/** How much of a failed child's log is shown. */
const LOG_TAIL_LINES = 15;

export interface StartTimeouts {
  /** How long the API has to answer /health. */
  readonly healthMs: number;
  /** How often it is asked. */
  readonly pollMs: number;
  /** How long the GUI and the API have to stop after SIGTERM. */
  readonly graceMs: number;
  /** The supervisor's longer grace: it may be finishing a backup or a turn's ingest. */
  readonly supervisorGraceMs: number;
}

export const DEFAULT_TIMEOUTS: StartTimeouts = {
  healthMs: 60_000,
  pollMs: 500,
  graceMs: 10_000,
  supervisorGraceMs: 60_000,
};

/** Where stop signals arrive: the process, or a test's emitter. */
export interface SignalSource {
  on(signal: StopSignal, listener: () => void): unknown;
  removeListener(signal: StopSignal, listener: () => void): unknown;
}

export interface StartIo {
  readonly env: Env;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** Everything a test replaces; production takes the defaults. */
export interface StartDeps {
  readonly clock: Clock;
  readonly timeouts: StartTimeouts;
  readonly signals: SignalSource;
  readonly healthy: (url: string) => Promise<boolean>;
  readonly portFree: (port: number) => Promise<boolean>;
  readonly repoRoot: string;
  /** Replaces the plan's children (tests: tiny `node -e` scripts). */
  readonly children?: (plan: StartPlan) => readonly ChildPlan[];
  /** Replaces the migrations' argv. */
  readonly migrate?: readonly string[];
  readonly token?: ApiTokenOptions;
}

async function fetchHealthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

export const defaultStartDeps = (): StartDeps => ({
  clock: systemClock,
  timeouts: DEFAULT_TIMEOUTS,
  signals: process,
  healthy: fetchHealthy,
  portFree,
  repoRoot: repoRootOf(import.meta.url),
});

/** The last lines of a log, for the operator to see why a child stopped. */
export function logTail(text: string, lines: number = LOG_TAIL_LINES): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

function readTail(path: string): string {
  try {
    return logTail(readFileSync(path, "utf8"));
  } catch (e) {
    return `(cannot read ${path}: ${String(e)})`;
  }
}

const failure = (message: string): Result<never> =>
  err({ class: "internal", message, retryable: false });

/** A fresh log, the previous one kept as `.1`: 0600 in a 0700 folder. */
function openLog(path: string): number {
  if (existsSync(path)) renameSync(path, `${path}.1`);
  const fd = openSync(path, "w", 0o600);
  chmodSync(path, 0o600);
  return fd;
}

function prepareLogs(dir: string): Result<void> {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    return ok(undefined);
  } catch (e) {
    return failure(`cannot create ${dir}: ${String(e)}`);
  }
}

function migrate(argv: readonly string[], env: Env): Result<void> {
  const run = spawnSync(process.execPath, argv, { env, encoding: "utf8" });
  return run.status === 0
    ? ok(undefined)
    : failure(
        `the database upgrade failed:\n${logTail(`${run.stdout ?? ""}${run.stderr ?? ""}`)}`,
      );
}

/** The plan, checked: a home, a token, nothing running on it, its logs folder, its migrations. */
async function prepare(env: Env, deps: StartDeps): Promise<Result<StartPlan>> {
  const plan = startPlan(env, deps.repoRoot);
  if (!plan.ok) return plan;
  const token = await checkToken(plan.value, deps.token);
  if (!token.ok) return token;
  const free = await checkNotRunning(plan.value, deps);
  if (!free.ok) return free;
  const logs = prepareLogs(plan.value.logsDir);
  if (!logs.ok) return logs;
  const migrated = migrate(deps.migrate ?? plan.value.migrate, plan.value.env);
  if (!migrated.ok) return migrated;
  const children = deps.children?.(plan.value) ?? plan.value.children;
  return ok({ ...plan.value, children });
}

interface Running {
  readonly plan: ChildPlan;
  readonly process: ChildProcess;
  readonly exited: Promise<number>;
}

function launch(plan: ChildPlan, env: Env): Result<Running> {
  let fd: number;
  try {
    fd = openLog(plan.log);
  } catch (e) {
    return failure(`cannot open ${plan.log}: ${String(e)}`);
  }
  const child = spawn(process.execPath, plan.args, {
    cwd: plan.cwd,
    env,
    stdio: ["ignore", fd, fd],
    // Its own process group: the terminal's signals reach frm alone, which stops them in order.
    detached: true,
  });
  closeSync(fd);
  const exited = new Promise<number>((done) => {
    child.once("error", () => done(1));
    child.once("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
  return ok({ plan, process: child, exited });
}

const alive = (r: Running): boolean =>
  r.process.exitCode === null && r.process.signalCode === null;

/** Signals the child's whole group; a group already gone is fine. */
function signalGroup(r: Running, signal: NodeJS.Signals): void {
  const pid = r.process.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: the group has exited already.
  }
}

/** True when it exited within `ms`. */
async function exitsWithin(
  r: Running,
  ms: number,
  clock: Clock,
): Promise<boolean> {
  const timeout = new AbortController();
  const late = clock
    .after(ms, timeout.signal)
    .then(() => false)
    .catch(() => true);
  const won = await Promise.race([r.exited.then(() => true), late]);
  timeout.abort();
  return won;
}

/** SIGTERM, a grace, then SIGKILL; one child at a time, the GUI first and the supervisor last. */
async function stopInOrder(
  running: readonly Running[],
  deps: StartDeps,
  io: StartIo,
): Promise<void> {
  const { graceMs, supervisorGraceMs } = deps.timeouts;
  for (const r of [...running].reverse()) {
    if (!alive(r)) continue;
    signalGroup(r, "SIGTERM");
    let stopped = await exitsWithin(r, graceMs, deps.clock);
    if (
      !stopped &&
      r.plan.name === "supervisor" &&
      supervisorGraceMs > graceMs
    ) {
      io.out(
        `waiting up to ${Math.round(supervisorGraceMs / 1000)} s for the supervisor to stop (it may be finishing a backup)`,
      );
      stopped = await exitsWithin(r, supervisorGraceMs - graceMs, deps.clock);
    }
    if (!stopped) {
      io.err(`frm start: ${r.plan.name} did not stop; killing it`);
      signalGroup(r, "SIGKILL");
      await r.exited;
    }
  }
}

interface Exit {
  readonly r: Running;
  readonly code: number;
}

/** True once the API answers /health; false when `stop` settles first or the time runs out. */
async function waitHealthy(
  url: string,
  deps: StartDeps,
  stop: Promise<void>,
): Promise<boolean> {
  const deadline = deps.clock.now() + deps.timeouts.healthMs;
  let stopped = false;
  void stop.then(() => {
    stopped = true;
  });
  while (!stopped && deps.clock.now() < deadline) {
    if (await deps.healthy(url)) return true;
    const tick = new AbortController();
    await Promise.race([
      deps.clock.after(deps.timeouts.pollMs, tick.signal).catch(() => {}),
      stop,
    ]);
    tick.abort();
  }
  return false;
}

/** Starts every child, or none: one that cannot open its log stops those already started. */
function launchAll(p: StartPlan): Result<readonly Running[]> {
  const running: Running[] = [];
  for (const child of p.children) {
    const r = launch(child, p.env);
    if (!r.ok) {
      for (const started of running) signalGroup(started, "SIGKILL");
      return r;
    }
    running.push(r.value);
  }
  return ok(running);
}

export async function runStartCommand(
  io: StartIo,
  deps: StartDeps = defaultStartDeps(),
): Promise<number> {
  const plan = await prepare(io.env, deps);
  if (!plan.ok) {
    io.err(`frm start: ${plan.error.message}`);
    return 1;
  }
  const p = plan.value;
  io.out(`home    ${shownHome(p.home)}`);
  let requested = false;
  let request = (): void => {};
  const stop = new Promise<void>((done) => {
    request = done;
  });
  const onSignal = (): void => {
    if (!requested) io.out("stopping the GUI, the API and the supervisor");
    requested = true;
    request();
  };
  for (const signal of STOP_SIGNALS) deps.signals.on(signal, onSignal);
  try {
    const launched = launchAll(p);
    if (!launched.ok) {
      io.err(`frm start: ${launched.error.message}`);
      return 1;
    }
    return await supervise(p, launched.value, stop, () => requested, deps, io);
  } finally {
    for (const signal of STOP_SIGNALS)
      deps.signals.removeListener(signal, onSignal);
  }
}

/** Waits for a stop request or a child's exit, reports which, and stops the rest in order. */
async function supervise(
  p: StartPlan,
  running: readonly Running[],
  stop: Promise<void>,
  requested: () => boolean,
  deps: StartDeps,
  io: StartIo,
): Promise<number> {
  const firstExit: Promise<Exit> = Promise.race(
    running.map((r) => r.exited.then((code) => ({ r, code }))),
  );
  const up = await Promise.race([
    waitHealthy(p.healthUrl, deps, stop),
    firstExit.then(() => false),
  ]);
  if (up) {
    io.out(`GUI     ${p.guiUrl}`);
    io.out(`logs    ${shownHome(p.logsDir)}/{supervisor,api,web}.log`);
    io.out("Ctrl-C stops all three");
  }
  // Up: until a stop request, or one child stopping on its own. Not up: a child that already did.
  const exit = up
    ? await Promise.race([firstExit, stop.then(() => null)])
    : await Promise.race([firstExit, Promise.resolve(null)]);
  const failed = !requested();
  if (exit !== null && failed) {
    io.err(
      `frm start: ${exit.r.plan.name} exited (code ${exit.code}); the end of ${exit.r.plan.log}:`,
    );
    io.err(readTail(exit.r.plan.log));
  } else if (!up && failed) {
    io.err(
      `frm start: the API did not answer ${p.healthUrl} within ${Math.round(deps.timeouts.healthMs / 1000)} s; see ${p.logsDir}`,
    );
  }
  await stopInOrder(running, deps, io);
  io.out("stopped");
  return failed ? 1 : 0;
}
