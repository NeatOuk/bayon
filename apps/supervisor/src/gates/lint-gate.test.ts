// The `lint_check` gate through the engine, on real processes. The spike's test plan
// promised this file -- "the spawn takes a worktree and carries the repo env" -- and it was never
// written: `grep -l 'LINT_REPO_ENV\|jobOf\|spawnGate'` over the supervisor's tests came back empty,
// and `lint-pick.test.ts` covers only the pick's four answers. What was uncovered is a three-way
// ternary touched in two places (run-gate.ts `jobOf`, and the workspace/env spread in `spawnGate`),
// where landing in the wrong branch -- `workspace: "none"`, as the parity job takes -- would make
// every lint gate fail at runtime for want of the files it is there to lint, discoverable only by
// an operator turning the gate on.
//
// parity-gate.test.ts's harness, with the two differences that are the whole point: one repo, and a
// job that reports back the cwd and the two env names production handed it.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FakeClock,
  GateEvidence,
  TEMPLATES,
  newId,
  type Clock,
} from "@bayon/core";
import {
  getGate,
  getSession,
  listGateSessions,
  listSessionWorktrees,
  listSessionsInStates,
  listTicketWorktrees,
  type Db,
  type GateRow,
} from "@bayon/db";
import { seedRows, tempDb, ticketRow, unwrap } from "@bayon/db/testing";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import type { RunnerAdapter } from "@bayon/runners";
import { createFixtureAdapter } from "@bayon/runners/fixture";
import { createScriptAdapter } from "@bayon/runners/script";
import { pino } from "pino";
import { afterAll, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { upsertBootRows } from "../boot.js";
import { createIngest } from "../ingest/ingest.js";
import { createLifecycle, type Lifecycle } from "../lifecycle/index.js";
import { envSecrets } from "../lifecycle/secrets.js";
import { certifyPair } from "../lifecycle/testing/certify.js";
import {
  CMD,
  EXECUTOR_ID,
  lifecycleRows,
  spawnPayload,
  tempHome,
} from "../lifecycle/testing/fixtures.js";
import {
  LINT_AGENT_ID,
  LINT_LOG_ENV,
  LINT_REPO_ENV,
  LINT_ROLE,
  LINT_RUNNER_ID,
  LINT_RUN_CLASS,
} from "../jobs/lint-agent.js";
import { sessionDir } from "../paths.js";
import { createGateEngine, type GateEngine } from "./engine.js";
import { LINT_LOG } from "./run-gate.js";

const T0 = Date.UTC(2026, 8, 14, 12);
const WAIT = { timeout: 25_000, interval: 10 };
const TICKET = "ticket-1";
const REPO = "app";
const LIVE = [
  "pending",
  "preparing",
  "spawning",
  "running",
  "idle",
  "stopping",
] as const;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

/** One source repo with one commit, its bare mirror, and the single workspace over it. */
function repoRows(home: string) {
  const src = join(home, "src", REPO);
  mkdirSync(src, { recursive: true });
  git(src, "init", "-q", "-b", "main");
  writeFileSync(join(src, "README.md"), `${REPO}\n`);
  git(src, "add", ".");
  git(src, "commit", "-q", "-m", REPO);
  const mirror = join(home, `${REPO}.git`);
  git(home, "clone", "-q", "--mirror", src, mirror);
  return {
    repos: [
      {
        id: REPO,
        name: REPO,
        origin_url: src,
        mirror_path: mirror,
        // What the real job would read. The stand-in never reads it, but a repo with no command
        // opens no gate, so the row the gate's existence implies is here.
        lint_cmd: "true",
      },
    ],
    workspaces: [{ id: "ws", name: "ws", kind: "single" as const }],
    workspace_repos: [
      { workspace_id: "ws", repo_id: REPO, rel_path: REPO, role: "primary" },
    ],
  };
}

/** The file the job writes into the home it was handed. */
const MARKER = "PLANTED-BY-THE-JOB";

/**
 * A stand-in for `dist/jobs/lint-check.js`: the same stdin/stdout protocol, reporting back the
 * four things the gate engine is on the hook for handing it -- the cwd it was started in, the repo
 * the gate pinned, where the whole output is to go, and the `HOME` its repo-declared commands would
 * run under. The real job's own logic is lint-run.test.ts's and core's; what is under test here is
 * what production puts in front of it.
 */
function jobScript(home: string, events: readonly (object | string)[]): string {
  const path = join(home, "lint-job.js");
  writeFileSync(
    path,
    [
      `const EVENTS = ${JSON.stringify(events)};`,
      // the job does what repo-declared code would do -- write into the home it was
      // given -- and reports where that was. Deliberately no fallback to `os.homedir()`, which
      // reads the passwd entry when HOME is unset: a spawn that stopped setting HOME must fail
      // this gate, never quietly write into the operator's own directory.
      `const fs = require("node:fs"), p = require("node:path");`,
      `const plant = () => {`,
      `  const h = process.env.HOME;`,
      `  if (!h) throw new Error("the supervisor handed this job no HOME");`,
      `  fs.mkdirSync(h, { recursive: true });`,
      `  fs.writeFileSync(p.join(h, ${JSON.stringify(MARKER)}), "x");`,
      `  return h;`,
      `};`,
      `const envReport = () => ({`,
      `  kind: "assistant_text",`,
      `  runner_type: "lint.report",`,
      `  text: JSON.stringify({`,
      `    summary: [process.cwd(), String(process.env.${LINT_REPO_ENV}),`,
      `      String(process.env.${LINT_LOG_ENV}), plant()].join("|"),`,
      `    findings: [],`,
      `  }) + "\\n\\nFINDINGS: 0",`,
      `  payload: {},`,
      `});`,
      `let buf = "";`,
      `process.stdin.on("data", (d) => {`,
      `  buf += d.toString("utf8");`,
      `  const parts = buf.split("\\n");`,
      `  buf = parts.pop() ?? "";`,
      `  for (const line of parts) {`,
      `    let op; try { op = JSON.parse(line); } catch { continue; }`,
      `    if (op && op.op === "send") {`,
      `      for (const e of EVENTS) {`,
      `        const event = e === "ENV_REPORT" ? envReport() : e;`,
      `        process.stdout.write(JSON.stringify(event) + "\\n");`,
      `      }`,
      `    }`,
      `  }`,
      `});`,
      `process.stdin.on("end", () => { process.exitCode = 0; });`,
      "",
    ].join("\n"),
  );
  return path;
}

const INIT = {
  kind: "session_init",
  runner_type: "lint.init",
  payload: { runner_session_id: "lint-1", model: "script" },
};
const TERMINAL = {
  kind: "terminal",
  runner_type: "lint.terminal",
  payload: {
    outcome: "ok",
    usage: {
      tokens_in: 0,
      tokens_out: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
    },
    cost_usd: 0,
  },
};
const report = (text: string) => ({
  kind: "assistant_text",
  runner_type: "lint.report",
  text,
  payload: {},
});

/** core's lintReport shape for a failing command: one blocker, and the sentinel collect() holds it to. */
const BLOCKED = `${JSON.stringify({
  summary: "lint_check: repo app fails its lint command.",
  findings: [
    {
      severity: "blocker",
      summary: "`pnpm -w lint` exited 1 in repo app",
      file: null,
      line: null,
      category: "lint",
      detail_md: "Run `pnpm -w lint` in your worktree.",
    },
  ],
})}\n\nFINDINGS: 1`;

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of cleanups) await c();
});

async function setup(
  o: { readonly events?: readonly (object | string)[] } = {},
) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const home = tempHome("frm-lint-gate-");
  cleanups.push(async () => {
    t.cleanup();
    home.cleanup();
  });
  const jobPath = jobScript(
    home.path,
    o.events ?? [INIT, "ENV_REPORT", TERMINAL],
  );
  const lint = createScriptAdapter({
    id: LINT_RUNNER_ID,
    argv: [process.execPath, jobPath],
    clock,
  });
  unwrap(
    await seedRows(t.db, {
      ...lifecycleRows({
        settings: {
          "reconciler.interval_ms": 86_400_000,
          "executor.health_timeout_ms": 86_400_000,
        },
      }),
      ...repoRows(home.path),
      tickets: [
        ticketRow(1, { status: "code_review", workspace_id: "ws", num: 1 }),
      ],
    }),
  );
  // The job's runner and model rows, exactly as main.ts's lint wiring puts them in.
  unwrap(await upsertBootRows(t.db, { registrations: [lint.registration()] }));
  // The fleet config `frm config apply` seeds (tools/frm/src/lint-config.ts).
  unwrap(
    await seedRows(t.db, {
      run_classes: [
        {
          name: LINT_RUN_CLASS,
          context_tokens_cap: 0,
          max_turns: 0,
          max_tool_calls: 0,
          wall_clock_ms: 900_000,
          cost_cap_usd: 0,
          handoff_at_turns: 0,
          default_tier: "cheap",
        },
      ],
      profiles: [
        {
          id: LINT_AGENT_ID,
          name: LINT_AGENT_ID,
          runner_id: LINT_RUNNER_ID,
          model_tier: "cheap",
          env_json: JSON.stringify({ FRM_HOME: home.path }),
          tool_allowlist_json: "[]",
          version: 1,
          hash: "0".repeat(64),
          created_at: 0,
        },
      ],
      agents: [
        {
          id: LINT_AGENT_ID,
          name: LINT_AGENT_ID,
          kind: "util" as const,
          runner_id: LINT_RUNNER_ID,
          executor_id: EXECUTOR_ID,
          profile_id: LINT_AGENT_ID,
          workspace_id: null,
          created_at: 0,
        },
      ],
    }),
  );

  const fixture = createFixtureAdapter({ clock });
  await certifyPair(t.db, {
    runnerId: fixture.id,
    runnerVersion: fixture.registration().runner.versionDetected ?? "rig",
    caps: fixture.caps(),
    executorId: EXECUTOR_ID,
    executorKind: "local",
    at: clock.now(),
  });
  const adapters = new Map<string, RunnerAdapter>([
    [fixture.id, fixture],
    [LINT_RUNNER_ID, lint],
  ]);
  const slots = new SlotCounter(6);
  const executor = new LocalExecutor({ id: EXECUTOR_ID, slots });
  const ingest = createIngest({
    db: t.db,
    clock,
    log: pino({ level: "silent" }),
    maxRows: 1,
  });
  const quiet = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const lifecycle: Lifecycle = createLifecycle({
    db: t.db,
    clock,
    log: quiet,
    frmHome: home.path,
    executors: new Map([[EXECUTOR_ID, { executor, slots }]]),
    adapters,
    ingest,
    secrets: envSecrets({}),
    mcpReachable: async () => true,
    // The daemon's own job runners are exempt from `uncertified` (), which is why this
    // one is deliberately never certified above.
    jobRunners: new Set([LINT_RUNNER_ID]),
  });
  unwrap(await lifecycle.boot());
  const engine: GateEngine = createGateEngine({
    db: t.db,
    clock,
    log: quiet,
    frmHome: home.path,
    lifecycle,
    adapters,
    executors: new Map([[EXECUTOR_ID, executor]]),
    path: process.env["PATH"] ?? "",
  });
  cleanups.unshift(async () => {
    const live = await listSessionsInStates(t.db, [...LIVE]);
    for (const s of live.ok ? live.value : []) {
      if (s.executor_ref !== null)
        await executor.cleanup(s.executor_ref, "hard");
    }
    await Promise.race([
      engine.stop(),
      new Promise((r) => setTimeout(r, 2_000)),
    ]);
    await lifecycle.shutdown();
    await ingest.shutdown();
  });
  // The builder, and its worktree of the repo: what the gate pins.
  unwrap(
    await lifecycle.handlers.spawn.handle(
      spawnPayload("B1", { workspace_id: "ws", ticket_id: TICKET }),
      CMD,
    ),
  );
  await vi.waitFor(async () => {
    await lifecycle.settled();
    expect(unwrap(await getSession(t.db, "B1")).state).toBe("idle");
  }, WAIT);
  await engine.start();
  return { db: t.db, clock, home: home.path, engine, lifecycle };
}
type World = Awaited<ReturnType<typeof setup>>;

/** One lint gate, as planRound opens it: per repo, subject_kind `diff` (core's subjectOf). */
async function openGate(db: Db, clock: Clock, id: string): Promise<void> {
  unwrap(
    await seedRows(db, {
      gates: [
        {
          id,
          ticket_id: TICKET,
          kind: "lint_check",
          state: "running",
          attempt: 1,
          repo_id: REPO,
          subject_kind: "diff",
          subject_ref: "unpinned",
          started_at: clock.now(),
        },
      ],
    }),
  );
}

const claim = (w: World, id: string) =>
  w.engine.handler.handle(
    { gate_id: id, session_id: newId(w.clock.now()) },
    CMD,
  );

const decided = (w: World, id: string): Promise<GateRow> =>
  vi.waitFor(async () => {
    const g = unwrap(await getGate(w.db, id));
    expect(g.state).not.toBe("running");
    return g;
  }, WAIT);

const stored = (g: GateRow): Record<string, unknown> =>
  JSON.parse(String(g.evidence_json)) as Record<string, unknown>;

/** What the job wrote, as `collect` stored it beside the evidence. */
const jobOutput = (g: GateRow): string => {
  const e = GateEvidence.parse(stored(g));
  const path = e.artifact_paths.find((p) => p.endsWith("output.txt")) ?? "";
  return readFileSync(path, "utf8");
};

/**
 * The four things the gate engine handed the job, read back out of the report it wrote: its cwd,
 * `FRM_LINT_REPO_ID`, `FRM_LINT_LOG` and its `HOME`. This is the whole subject a script job is
 * given, so it is exactly what production put in front of it and nothing reconstructed here.
 */
const handedTo = (g: GateRow): string[] => {
  const text = jobOutput(g);
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const report = z.object({ summary: z.string() }).parse(JSON.parse(json));
  return report.summary.split("|");
};

/** The builder's commit: the ticket's work, which the gate pins and the job must be able to see. */
async function workOnRepo(w: World): Promise<string> {
  const rows = unwrap(await listTicketWorktrees(w.db, TICKET));
  const path = rows.find((x) => x.repo_id === REPO)?.path ?? "";
  writeFileSync(join(path, "LINTED.md"), "the file the lint command reads\n");
  git(path, "add", ".");
  git(path, "commit", "-q", "-m", "the ticket's work");
  return git(path, "rev-parse", "HEAD");
}

describe("the lint_check gate", { timeout: 60_000 }, () => {
  // The finding this file exists for. A lint command has to have the files, so unlike the parity
  // job this gate's session takes the reviewer branch of the spread -- the subject checked out
  // detached at the pinned head -- and then some: its own two env names on top. `workspace: "none"`
  // here would leave the job in a directory with no repo in it, and every lint gate would fail at
  // runtime for want of the thing it is there to read.
  test("the job is given the pinned worktree as its cwd, and the repo and log names in its env", async () => {
    const w = await setup();
    const worked = await workOnRepo(w);
    await openGate(w.db, w.clock, "g-lint");
    unwrap(await claim(w, "g-lint"));
    const g = await decided(w, "g-lint");
    expect(g.state, String(g.evidence_json)).toBe("passed");

    const [cwd = "", repoId = "", logPath = ""] = handedTo(g);

    // A real worktree, at the commit the gate pinned -- not the builder's own, and not nothing.
    expect(cwd).not.toBe("");
    expect(existsSync(join(cwd, "LINTED.md"))).toBe(true);
    expect(git(cwd, "rev-parse", "HEAD")).toBe(worked);
    // The pinned repo, by name: a job that guessed would lint one repo and report it as another's.
    expect(repoId).toBe(REPO);
    // Under this gate's own artifacts directory, on this host (Invariant 9).
    expect(logPath.endsWith(join("g-lint", LINT_LOG))).toBe(true);
    expect(logPath.startsWith(w.home)).toBe(true);

    // And the session the worktree belongs to is the gate's, not the builder's.
    const [row] = unwrap(await listGateSessions(w.db, ["g-lint"]));
    const worktrees = unwrap(
      await listSessionWorktrees(w.db, row?.session_id ?? ""),
    );
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]?.path).toBe(cwd);
  });

  // This gate runs the *repository's* declared commands as the supervisor's own uid, so
  // the one thing the environment can still decide is which home they run under. The ticket's
  // premise was that it is the supervisor's; it is not -- `buildEnv` gives every session its own
  // (§11.3) -- but nothing asserted that, and the guarantee was one line of a function written for
  // runner sessions. This is the assertion: a job that really writes into the home it was handed,
  // and a supervisor home that stays empty.
  test("the job's HOME is this session's own directory, not the supervisor's", async () => {
    const w = await setup();
    await workOnRepo(w);
    await openGate(w.db, w.clock, "g-lint");
    unwrap(await claim(w, "g-lint"));
    const g = await decided(w, "g-lint");
    expect(g.state, String(g.evidence_json)).toBe("passed");

    const [, , , home = ""] = handedTo(g);
    const [row] = unwrap(await listGateSessions(w.db, ["g-lint"]));
    // Exactly this session's private home, recomputed from the layout rather than read back out of
    // the job's own report.
    expect(home).toBe(join(sessionDir(w.home, row?.session_id ?? ""), "home"));
    // The write happened, and it happened there: an absence on its own would pass just as well
    // against a job that never ran at all.
    expect(existsSync(join(home, MARKER))).toBe(true);
    // And nowhere near the supervisor's own home -- which, for this test, is this process's.
    const supervisorHome = process.env["HOME"] ?? "";
    expect(supervisorHome).not.toBe("");
    expect(existsSync(join(supervisorHome, MARKER))).toBe(false);
    expect(home.startsWith(w.home)).toBe(true);
  });

  // `jobOf`'s lint branch: the §9.8 role, the lint run class, and the lint template. The middle arm
  // of a three-way ternary, so falling through to either neighbour is a silent misconfiguration --
  // the reviewer's `review` class has a cost cap and turn ceiling this job would then be held to.
  test("the session is a util job on the lint run class, not a reviewer", async () => {
    const w = await setup();
    await workOnRepo(w);
    await openGate(w.db, w.clock, "g-lint");
    unwrap(await claim(w, "g-lint"));
    const g = await decided(w, "g-lint");
    expect(g.state, String(g.evidence_json)).toBe("passed");
    const [row] = unwrap(await listGateSessions(w.db, ["g-lint"]));
    expect(unwrap(await getSession(w.db, row?.session_id ?? ""))).toMatchObject(
      {
        role: LINT_ROLE,
        run_class: LINT_RUN_CLASS,
        runner_id: LINT_RUNNER_ID,
        executor_id: EXECUTOR_ID,
        agent_id: LINT_AGENT_ID,
      },
    );
    // The gate's evidence is §10.3's, and names the kind it decided.
    const e = GateEvidence.parse(stored(g));
    expect(e).toMatchObject({
      exit_code: 0,
      runner_id: LINT_RUNNER_ID,
      executor_id: EXECUTOR_ID,
      subject: { repo_id: REPO },
      findings: { total: 0, parse: "heuristic" },
    });
    expect(e.command).toContain("lint_check");
    for (const path of e.artifact_paths) expect(existsSync(path)).toBe(true);
    // The template this job's run compiled from -- never a string built at the call site
    // (Invariant 8). It is a script job, so no model reads it; the run exists to record the hashes.
    expect(TEMPLATES.lint.name).toBe("lint");
  });

  test("a blocker finding fails the gate and is stored as a lint finding", async () => {
    const w = await setup({ events: [INIT, report(BLOCKED), TERMINAL] });
    await workOnRepo(w);
    await openGate(w.db, w.clock, "g-lint");
    unwrap(await claim(w, "g-lint"));
    const g = await decided(w, "g-lint");
    expect(g.state).toBe("failed");
    expect(stored(g)).toMatchObject({ reason: "blocking_findings" });
  });
});
