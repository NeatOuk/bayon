import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "@bayon/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { STOP_SIGNALS, runStartCommand, type StartDeps } from "./start.js";
import type { ChildName, ChildPlan, StartPlan } from "./start-plan.js";

// `frm start`'s lifecycle with tiny `node -e` children on a temp home: time is a
// FakeClock that the test moves, signals come from an emitter, and "healthy" means every child has
// written its ready file. Nothing sleeps: the driver yields to the event loop between steps.

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "frm-start-run-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const ready = (name: ChildName): string => join(home, `${name}.ready`);
const orderFile = (): string => join(home, "stop-order");

/** Writes its ready file, then idles; on SIGTERM records its name and exits, unless it ignores it. */
const script = (
  name: ChildName,
  o: { exitWith?: number; ignoreTerm?: boolean } = {},
): string => {
  const fs = `const fs = require("node:fs");`;
  if (o.exitWith !== undefined) {
    // It fails once the others are up, so they are ready to record their SIGTERM.
    const others = JSON.stringify(
      (["supervisor", "api", "web"] as const)
        .filter((n) => n !== name)
        .map(ready),
    );
    return `${fs} console.log("${name} failed here"); setInterval(() => { if (${others}.every((f) => fs.existsSync(f))) process.exit(${o.exitWith}); }, 5);`;
  }
  const term = o.ignoreTerm
    ? `process.on("SIGTERM", () => fs.appendFileSync(${JSON.stringify(orderFile())}, "${name} ignored\\n"));`
    : `process.on("SIGTERM", () => { fs.appendFileSync(${JSON.stringify(orderFile())}, "${name}\\n"); process.exit(0); });`;
  return `${fs} ${term} fs.writeFileSync(${JSON.stringify(ready(name))}, ""); setInterval(() => {}, 1e9);`;
};

type Scripts = Partial<Record<ChildName, string>>;

interface Harness {
  readonly clock: FakeClock;
  readonly signals: EventEmitter;
  readonly out: string[];
  readonly err: string[];
  readonly deps: StartDeps;
}

function harness(
  scripts: Scripts,
  timeouts: Partial<StartDeps["timeouts"]> = {},
): Harness {
  const clock = new FakeClock(0);
  const signals = new EventEmitter();
  const names: readonly ChildName[] = ["supervisor", "api", "web"];
  const children = (plan: StartPlan): readonly ChildPlan[] =>
    names.map((name) => ({
      name,
      args: ["-e", scripts[name] ?? script(name)],
      cwd: home,
      log: join(plan.logsDir, `${name}.log`),
    }));
  return {
    clock,
    signals,
    out: [],
    err: [],
    deps: {
      clock,
      signals,
      timeouts: {
        healthMs: 1e12,
        pollMs: 100,
        graceMs: 1e12,
        supervisorGraceMs: 1e12,
        ...timeouts,
      },
      healthy: async () => names.every((n) => existsSync(ready(n))),
      portFree: async () => true,
      repoRoot: "/nonexistent-repo",
      children,
      migrate: ["-e", ""],
    },
  };
}

/**
 * Runs frm start, yielding to real I/O until it ends; `onTick` may act, and fake time moves only
 * while `mayAdvance` says so (a grace must not run out on a child still starting or stopping).
 */
async function drive(
  h: Harness,
  onTick: () => void = () => {},
  mayAdvance: () => boolean = () => true,
): Promise<number> {
  const run = runStartCommand(
    {
      env: { FRM_HOME: home, FRM_API_TOKEN: "t".repeat(32) },
      out: (line) => h.out.push(line),
      err: (line) => h.err.push(line),
    },
    h.deps,
  );
  let done = false;
  void run.finally(() => {
    done = true;
  });
  while (!done) {
    onTick();
    if (mayAdvance()) await h.clock.advance(100);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return run;
}

const stopOrder = (): string[] =>
  existsSync(orderFile())
    ? readFileSync(orderFile(), "utf8").trimEnd().split("\n")
    : [];

const allReady = (): boolean =>
  (["supervisor", "api", "web"] as const).every((n) => existsSync(ready(n)));

const listeners = (e: EventEmitter): number =>
  STOP_SIGNALS.reduce((n, s) => n + e.listenerCount(s), 0);

describe("runStartCommand", () => {
  test("a signal stops the GUI, the API, then the supervisor, and exits 0", async () => {
    const h = harness({});
    let sent = false;
    const code = await drive(h, () => {
      if (!sent && h.out.includes("Ctrl-C stops all three")) {
        sent = true;
        h.signals.emit("SIGHUP");
      }
    });
    expect(code).toBe(0);
    expect(h.out).toContain("GUI     http://localhost:5173");
    expect(h.out).toContain("stopping the GUI, the API and the supervisor");
    expect(h.out.at(-1)).toBe("stopped");
    expect(stopOrder()).toEqual(["web", "api", "supervisor"]);
    expect(h.err).toEqual([]);
    expect(listeners(h.signals)).toBe(0);
  });

  test("one child exiting stops the others, prints its log's end, and exits 1", async () => {
    mkdirSync(join(home, "logs"));
    writeFileSync(join(home, "logs", "api.log"), "the last run\n");
    const h = harness({ api: script("api", { exitWith: 3 }) });
    const code = await drive(h);
    expect(code).toBe(1);
    expect(h.err[0]).toBe(
      `frm start: api exited (code 3); the end of ${join(home, "logs", "api.log")}:`,
    );
    expect(h.err[1]).toContain("api failed here");
    expect(h.err[1]).not.toContain("the last run");
    expect(stopOrder()).toEqual(["web", "supervisor"]);
    expect(listeners(h.signals)).toBe(0);
    // The previous log is kept once; the new one and its folder are private.
    expect(readFileSync(join(home, "logs", "api.log.1"), "utf8")).toBe(
      "the last run\n",
    );
    expect(statSync(join(home, "logs", "api.log")).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "logs")).mode & 0o777).toBe(0o700);
  });

  test("an API that never answers: stops everything after the health timeout, exit 1", async () => {
    const h = harness({}, { healthMs: 5_000 });
    const code = await drive(
      { ...h, deps: { ...h.deps, healthy: async () => false } },
      () => {},
      allReady,
    );
    expect(code).toBe(1);
    expect(h.err).toEqual([
      "frm start: the API did not answer http://127.0.0.1:3010/api/v1/health within 5 s; see " +
        join(home, "logs"),
    ]);
    expect(stopOrder()).toEqual(["web", "api", "supervisor"]);
    expect(listeners(h.signals)).toBe(0);
  });

  test("a child that ignores SIGTERM gets SIGKILL after its grace; the supervisor's is longer and said", async () => {
    const h = harness(
      {
        web: script("web", { ignoreTerm: true }),
        supervisor: script("supervisor", { ignoreTerm: true }),
      },
      { graceMs: 1_000, supervisorGraceMs: 5_000 },
    );
    let sent = false;
    // After the signal, time moves only while an ignoring child waits out its grace.
    const waiting = (): boolean =>
      stopOrder().filter((l) => l.endsWith("ignored")).length >
      h.err.filter((l) => l.endsWith("killing it")).length;
    const code = await drive(
      h,
      () => {
        if (!sent && h.out.includes("Ctrl-C stops all three")) {
          sent = true;
          h.signals.emit("SIGINT");
        }
      },
      () => !sent || waiting(),
    );
    expect(code).toBe(0);
    expect(h.err).toEqual([
      "frm start: web did not stop; killing it",
      "frm start: supervisor did not stop; killing it",
    ]);
    expect(h.out).toContain(
      "waiting up to 5 s for the supervisor to stop (it may be finishing a backup)",
    );
    expect(stopOrder()).toEqual(["web ignored", "api", "supervisor ignored"]);
    expect(listeners(h.signals)).toBe(0);
  });
});
