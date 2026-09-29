// The `qa_harness` gate through the engine, on real processes: lint-gate.test.ts's
// harness, one ticket status later. What is under test is what production puts in front of the QA
// job and what it does with the answer -- the pinned worktree as cwd, the three env names, the
// harness's own command in §10.3's `command`, the reports as artifacts, the `qa_runs` row the
// decision writes, and the machine step that row unlocks.
//
// The job here is a stand-in: the real one's logic is qa-run.test.ts's and core's.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FakeClock,
  GateEvidence,
  SessionState,
  TEMPLATES,
  newId,
  ok,
  type Clock,
} from "@bayon/core";
import {
  getGate,
  getSession,
  getTicket,
  latestQaRun,
  listGateSessions,
  listSessionWorktrees,
  listSessionsInStates,
  listTicketWorktrees,
  type Db,
  type GateRow,
} from "@bayon/db";
import {
  OPERATOR,
  dumpAllRows,
  seedRows,
  tempDb,
  ticketRow,
  transitionTicket,
  unwrap,
} from "@bayon/db/testing";
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
import { sweepMachineSteps } from "../lifecycle/machine-sweep.js";
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
  QA_AGENT_ID,
  QA_ARTIFACTS_ENV,
  QA_RUNNER_ID,
  QA_RUN_CLASS,
  QA_RUN_FILE,
  QA_ROLE,
  QA_TICKET_ENV,
  QA_WORKSPACE_ENV,
} from "../jobs/qa-agent.js";
import { createGateEngine, type GateEngine } from "./engine.js";

const T0 = Date.UTC(2026, 8, 14, 12);
/** The project's own harness command. A path, not a tool: Bayon never names one (Invariant 1). */
const HARNESS = "./scripts/check";
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
    workspaces: [
      {
        id: "ws",
        name: "ws",
        kind: "single" as const,
        // The project's own harness: what `when: "qa_configured"` reads, and what the real job
        // would run. The stand-in never runs it, but a project with no command opens no gate.
        qa_mode: "command" as const,
        qa_cmd: HARNESS,
      },
    ],
    workspace_repos: [
      { workspace_id: "ws", repo_id: REPO, rel_path: REPO, role: "primary" },
    ],
  };
}

/**
 * A stand-in for `dist/jobs/qa-check.js`: the same stdin/stdout protocol. It reports back the four
 * things the gate engine is on the hook for handing it -- the cwd it was started in, the project
 * whose harness it is to run, the ticket whose row the placeholders come from, and where its
 * artifacts go -- and it writes the `qa-run.json` a real run leaves, so `collect` has a run to read.
 */
function jobScript(home: string, o: { readonly exit: number }): string {
  const path = join(home, "qa-job.js");
  writeFileSync(
    path,
    [
      `const fs = require("node:fs"), p = require("node:path");`,
      `const emit = (e) => process.stdout.write(JSON.stringify(e) + "\\n");`,
      `const run = () => {`,
      `  const dir = process.env.${QA_ARTIFACTS_ENV};`,
      `  if (!dir) throw new Error("the supervisor handed this job no artifacts directory");`,
      `  fs.mkdirSync(p.join(dir, "qa-reports"), { recursive: true });`,
      `  const report = p.join(dir, "qa-reports", "out.xml");`,
      `  fs.writeFileSync(report, "<testsuite/>");`,
      `  fs.writeFileSync(p.join(dir, ${JSON.stringify(QA_RUN_FILE)}), JSON.stringify({`,
      `    command: ${JSON.stringify(HARNESS)},`,
      `    exit_code: ${String(o.exit)},`,
      `    started_at: 1, ended_at: 2, reports: [report],`,
      `  }));`,
      `  const failed = ${String(o.exit)} !== 0;`,
      `  emit({ kind: "session_init", runner_type: "qa.init",`,
      `    payload: { runner_session_id: "qa-1", model: "script" } });`,
      `  emit({ kind: "assistant_text", runner_type: "qa.report",`,
      `    text: JSON.stringify({`,
      `      summary: [process.cwd(), String(process.env.${QA_WORKSPACE_ENV}),`,
      `        String(process.env.${QA_TICKET_ENV}), dir].join("|"),`,
      `      findings: failed ? [{ severity: "blocker", summary: "the harness failed",`,
      `        file: null, line: null, category: "qa", detail_md: "x" }] : [],`,
      `    }) + "\\n\\nFINDINGS: " + (failed ? "1" : "0"), payload: {} });`,
      `  emit({ kind: "terminal", runner_type: "qa.terminal", payload: { outcome: "ok",`,
      `    usage: { tokens_in: 0, tokens_out: 0, tokens_cache_read: 0, tokens_cache_write: 0 },`,
      `    cost_usd: 0 } });`,
      `};`,
      `let buf = "";`,
      `process.stdin.on("data", (d) => {`,
      `  buf += d.toString("utf8");`,
      `  const parts = buf.split("\\n");`,
      `  buf = parts.pop() ?? "";`,
      `  for (const line of parts) {`,
      `    let op; try { op = JSON.parse(line); } catch { continue; }`,
      `    if (op && op.op === "send") run();`,
      `  }`,
      `});`,
      `process.stdin.on("end", () => { process.exitCode = 0; });`,
      "",
    ].join("\n"),
  );
  return path;
}

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of cleanups) await c();
});

async function setup(o: { readonly exit?: number } = {}) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const home = tempHome("frm-qa-gate-");
  cleanups.push(async () => {
    t.cleanup();
    home.cleanup();
  });
  const jobPath = jobScript(home.path, { exit: o.exit ?? 0 });
  const qa = createScriptAdapter({
    id: QA_RUNNER_ID,
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
        // Seeded before QA, then moved to qa_harness after the boot pass (below): at qa_harness
        // with no gate, the boot's machine sweep would open the gate it is owed, and
        // these tests open their own.
        ticketRow(1, { status: "code_review", workspace_id: "ws", num: 1 }),
      ],
    }),
  );
  // The job's runner and model rows, exactly as main.ts's QA wiring puts them in.
  unwrap(await upsertBootRows(t.db, { registrations: [qa.registration()] }));
  // The fleet config `frm config apply` seeds (tools/frm/src/qa-config.ts).
  unwrap(
    await seedRows(t.db, {
      // No run class: 002_seed already ships `qa` (§4), which is this job's, and a second row of
      // that name is a UNIQUE conflict — the same one `qaRows` deliberately does not cause.
      profiles: [
        {
          id: QA_AGENT_ID,
          name: QA_AGENT_ID,
          runner_id: QA_RUNNER_ID,
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
          id: QA_AGENT_ID,
          name: QA_AGENT_ID,
          kind: "util" as const,
          runner_id: QA_RUNNER_ID,
          executor_id: EXECUTOR_ID,
          profile_id: QA_AGENT_ID,
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
    [QA_RUNNER_ID, qa],
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
    jobRunners: new Set([QA_RUNNER_ID]),
  });
  unwrap(await lifecycle.boot());
  // The operator's move, as the API makes it, with no gate effects: the ticket reaches qa_harness
  // with no QA gate, as one that crossed pass_review before its project ran QA did.
  unwrap(
    await transitionTicket(
      t.db,
      { id: TICKET, version: 1, to: "qa_harness", by: OPERATOR, patch: {} },
      () => ok(undefined),
    ),
  );
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

/** One QA gate, as planRound opens it: repo-less, subject_kind `workspace` (core's subjectOf). */
async function openGate(db: Db, clock: Clock, id: string): Promise<void> {
  unwrap(
    await seedRows(db, {
      gates: [
        {
          id,
          ticket_id: TICKET,
          kind: "qa_harness",
          state: "running",
          attempt: 1,
          repo_id: null,
          subject_kind: "workspace",
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
 * the project, the ticket and its artifacts directory. This is the whole subject a script job is
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

describe("the qa_harness gate", { timeout: 60_000 }, () => {
  // A harness has to have the files, so this gate's session takes the reviewer branch of the
  // workspace spread -- the subject checked out detached at the pinned head -- plus its own three
  // env names. `workspace: "none"`, the parity job's branch, would leave the job in a directory
  // with no repo in it and every QA gate would fail for want of the thing it is there to run.
  test("the job is given the pinned worktree as its cwd, and the project, ticket and artifacts in its env", async () => {
    const w = await setup();
    const worked = await workOnRepo(w);
    await openGate(w.db, w.clock, "g-qa");
    unwrap(await claim(w, "g-qa"));
    const g = await decided(w, "g-qa");
    expect(g.state, String(g.evidence_json)).toBe("passed");

    const [cwd = "", workspaceId = "", ticketId = "", artifacts = ""] =
      handedTo(g);
    expect(cwd).not.toBe("");
    expect(existsSync(join(cwd, "LINTED.md"))).toBe(true);
    expect(git(cwd, "rev-parse", "HEAD")).toBe(worked);
    expect(workspaceId).toBe("ws");
    expect(ticketId).toBe(TICKET);
    expect(artifacts.endsWith(join("gates", "g-qa"))).toBe(true);
    expect(artifacts.startsWith(w.home)).toBe(true);

    const [row] = unwrap(await listGateSessions(w.db, ["g-qa"]));
    const worktrees = unwrap(
      await listSessionWorktrees(w.db, row?.session_id ?? ""),
    );
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]?.path).toBe(cwd);
  });

  // `jobOf`'s QA branch, and §10.3's evidence with the harness's own command in it.
  test("the session is a util job on the QA run class, and the evidence names the harness", async () => {
    const w = await setup();
    await workOnRepo(w);
    await openGate(w.db, w.clock, "g-qa");
    unwrap(await claim(w, "g-qa"));
    const g = await decided(w, "g-qa");
    expect(g.state, String(g.evidence_json)).toBe("passed");
    const [row] = unwrap(await listGateSessions(w.db, ["g-qa"]));
    expect(unwrap(await getSession(w.db, row?.session_id ?? ""))).toMatchObject(
      {
        role: QA_ROLE,
        run_class: QA_RUN_CLASS,
        runner_id: QA_RUNNER_ID,
        executor_id: EXECUTOR_ID,
        agent_id: QA_AGENT_ID,
      },
    );
    const e = GateEvidence.parse(stored(g));
    // §10.3's five, with the project's command rather than the generic gate line.
    expect(e.command).toBe(HARNESS);
    expect(e).toMatchObject({
      exit_code: 0,
      cost_usd: 0,
      runner_id: QA_RUNNER_ID,
      qa: { command: HARNESS, exit_code: 0 },
      findings: { total: 0, parse: "heuristic" },
    });
    expect(e.duration_ms).toBeGreaterThanOrEqual(0);
    // The report the run left is evidence, and it is still there after the worktree goes.
    const report = e.artifact_paths.find((p) => p.endsWith("out.xml")) ?? "";
    expect(readFileSync(report, "utf8")).toBe("<testsuite/>");
    for (const path of e.artifact_paths) expect(existsSync(path)).toBe(true);
    // Compiled from the versioned template, never built at the call site (Invariant 8).
    expect(TEMPLATES.qa.name).toBe("qa");
  });

  // The whole point of the ticket: the decision writes the QA fact, and the fact moves the ticket.
  test("a passed gate writes a passed qa_run and takes the ticket to qa_human", async () => {
    const w = await setup();
    await workOnRepo(w);
    await openGate(w.db, w.clock, "g-qa");
    unwrap(await claim(w, "g-qa"));
    await decided(w, "g-qa");
    const run = unwrap(await latestQaRun(w.db, TICKET));
    expect(run).toMatchObject({
      gate_id: "g-qa",
      state: "passed",
      command: HARNESS,
      exit_code: 0,
    });
    await vi.waitFor(async () => {
      expect(unwrap(await getTicket(w.db, TICKET)).status).toBe("qa_human");
    }, WAIT);
  });

  test("a failing harness writes a failed qa_run and takes the ticket to rework", async () => {
    const w = await setup({ exit: 1 });
    await workOnRepo(w);
    await openGate(w.db, w.clock, "g-qa");
    unwrap(await claim(w, "g-qa"));
    const g = await decided(w, "g-qa");
    expect(g.state).toBe("failed");
    expect(stored(g)).toMatchObject({ reason: "blocking_findings" });
    expect(unwrap(await latestQaRun(w.db, TICKET))).toMatchObject({
      state: "failed",
      exit_code: 1,
    });
    await vi.waitFor(async () => {
      expect(unwrap(await getTicket(w.db, TICKET)).status).toBe("rework");
    }, WAIT);
  });

  // a ticket that crossed pass_review while its project ran no QA sits at qa_harness
  // with no gate. The machine sweep opens the one it is owed, the engine's poll starts it — no
  // gate.run, no builder, no reviewer — and the rest is the path above.
  test("a ticket at qa_harness with no gate: the sweep opens one, the poll runs the harness, and it reaches qa_human", async () => {
    const w = await setup();
    await workOnRepo(w);
    const sessionsBefore = unwrap(
      await listSessionsInStates(w.db, SessionState.options),
    ).map((s) => s.id);
    const quiet = () => undefined;
    const swept = await sweepMachineSteps({
      db: w.db,
      log: { info: quiet, warn: quiet, error: quiet },
    });
    expect(swept).toMatchObject({ advanced: 0, opened: 1 });
    const all = unwrap(await dumpAllRows(w.db));
    const qa = (all["gates"] ?? []).filter(
      (g) => (g as { kind: string }).kind === "qa_harness",
    ) as { id: string }[];
    expect(qa).toHaveLength(1);
    const id = qa[0]?.id ?? "";
    expect(
      (all["commands"] ?? []).filter(
        (c) => (c as { type: string }).type === "gate.run",
      ),
    ).toEqual([]);

    await w.engine.tick();
    const g = await decided(w, id);
    expect(g.state, String(g.evidence_json)).toBe("passed");
    const e = GateEvidence.parse(stored(g));
    expect(e.command).toBe(HARNESS);
    expect(e.exit_code).toBe(0);
    expect(e.duration_ms).toBeGreaterThanOrEqual(0);
    expect(e.artifact_paths.some((p) => p.endsWith("out.xml"))).toBe(true);
    expect(unwrap(await latestQaRun(w.db, TICKET))).toMatchObject({
      gate_id: id,
      state: "passed",
      command: HARNESS,
      exit_code: 0,
    });
    await vi.waitFor(async () => {
      expect(unwrap(await getTicket(w.db, TICKET)).status).toBe("qa_human");
    }, WAIT);

    // The one session this spawned is the QA job: no builder, no reviewer.
    const spawned = unwrap(
      await listSessionsInStates(w.db, SessionState.options),
    ).filter((s) => !sessionsBefore.includes(s.id));
    expect(spawned.map((s) => [s.role, s.run_class])).toEqual([
      [QA_ROLE, QA_RUN_CLASS],
    ]);
    // Moved on: another pass opens nothing.
    expect(
      await sweepMachineSteps({
        db: w.db,
        log: { info: quiet, warn: quiet, error: quiet },
      }),
    ).toMatchObject({ opened: 0 });
  });
});
