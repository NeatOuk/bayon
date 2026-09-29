// The `parity_check` gate through the engine, on real processes: a multi-repo ticket,
// a repo-less gate whose subject is the workspace, and the parity job as a real `script` runner
// child. What it pins is the engine's side -- the fixed pick, the util role and parity run class,
// the heuristic collect held to its FINDINGS sentinel, and decideGate's verdict -- so the job's own
// argv is a stand-in script here (the job's logic is parity-facts.test.ts's and core's).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FakeClock,
  GateEvidence,
  newId,
  type Clock,
  type GateKind,
  type GateSubjectKind,
} from "@bayon/core";
import {
  getGate,
  getSession,
  listGateFindings,
  listGateSessions,
  listSessionWorktrees,
  listSessionsInStates,
  listTicketWorktrees,
  type Db,
  type GateRow,
} from "@bayon/db";
import { decideGate } from "@bayon/db/supervisor";
import {
  seedRows,
  tempDb,
  ticketRow,
  unwrap,
  updateRowForTest,
} from "@bayon/db/testing";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import type { RunnerAdapter } from "@bayon/runners";
import { createFixtureAdapter } from "@bayon/runners/fixture";
import { createScriptAdapter } from "@bayon/runners/script";
import { pino } from "pino";
import { afterAll, describe, expect, test, vi } from "vitest";
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
  PARITY_AGENT_ID,
  PARITY_RUNNER_ID,
  PARITY_RUN_CLASS,
} from "../jobs/parity-agent.js";
import { createGateEngine, type GateEngine } from "./engine.js";

const T0 = Date.UTC(2026, 8, 14, 12);
const WAIT = { timeout: 25_000, interval: 10 };
const TICKET = "ticket-1";
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

/** A source repo with one commit, and its bare mirror. */
function repo(home: string, name: string): { src: string; mirror: string } {
  const src = join(home, "src", name);
  mkdirSync(src, { recursive: true });
  git(src, "init", "-q", "-b", "main");
  writeFileSync(join(src, "README.md"), `${name}\n`);
  git(src, "add", ".");
  git(src, "commit", "-q", "-m", name);
  const mirror = join(home, `${name}.git`);
  git(home, "clone", "-q", "--mirror", src, mirror);
  return { src, mirror };
}

const repoRow = (name: string, r: { src: string; mirror: string }) => ({
  id: name,
  name,
  origin_url: r.src,
  mirror_path: r.mirror,
});

/**
 * The workspace the ticket is worked in: two sibling repos, or a superproject with one submodule.
 * The submodule shape is what `submodulesPublished` has a branch for and what a materialized
 * workspace resolves gitlinks for — the two things a `multi` workspace never exercises.
 */
function workspaceRows(home: string, layout: "multi" | "submodule") {
  if (layout === "multi") {
    const app = repo(home, "app");
    const lib = repo(home, "lib");
    return {
      repos: [repoRow("app", app), repoRow("lib", lib)],
      workspaces: [{ id: "ws", name: "ws", kind: "multi" as const }],
      workspace_repos: [
        {
          workspace_id: "ws",
          repo_id: "app",
          rel_path: "app",
          role: "primary",
        },
        { workspace_id: "ws", repo_id: "lib", rel_path: "lib", role: "dep" },
      ],
    };
  }
  const mid = repo(home, "mid");
  const sup = repo(home, "super");
  git(
    sup.src,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "-q",
    mid.src,
    "libs/mid",
  );
  git(sup.src, "commit", "-q", "-m", "mid");
  // Re-taken after the gitlink lands: the mirror is what every read below goes through.
  git(home, "clone", "-q", "--mirror", sup.src, `${sup.mirror}.2`);
  return {
    repos: [
      {
        ...repoRow("super", sup),
        mirror_path: `${sup.mirror}.2`,
        has_submodules: 1,
      },
      repoRow("mid", mid),
    ],
    workspaces: [{ id: "ws", name: "ws", kind: "submodule" as const }],
    workspace_repos: [
      {
        workspace_id: "ws",
        repo_id: "super",
        rel_path: "super",
        role: "primary",
      },
      {
        workspace_id: "ws",
        repo_id: "mid",
        rel_path: "super/libs/mid",
        role: "dep",
        submodule_path: "libs/mid",
      },
    ],
  };
}

/**
 * A stand-in for `dist/jobs/parity-check.js`: the same tiny stdin/stdout protocol, emitting the
 * events the test wants and exiting with `exit` when stdin ends. Plain node with no imports — it
 * runs outside the workspace's module resolution, as the real job's compiled file does not.
 */
function jobScript(
  home: string,
  name: string,
  events: readonly (object | string)[],
  exit = 0,
): string {
  const path = join(home, `${name}.js`);
  writeFileSync(
    path,
    [
      `const EVENTS = ${JSON.stringify(events)};`,
      // ENV_REPORT: the report the real job would write, with the pin it was handed in its env as
      // its summary (H1). That is the whole subject the gate engine gives a script job,
      // so a test can read back exactly what production hands it.
      `const envReport = () => ({`,
      `  kind: "assistant_text",`,
      `  runner_type: "parity.report",`,
      `  text: JSON.stringify({`,
      `    summary: String(process.env.FRM_PARITY_REPO_ID) + "@" + String(process.env.FRM_PARITY_HEAD),`,
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
      `process.stdin.on("end", () => { process.exitCode = ${String(exit)}; });`,
      "",
    ].join("\n"),
  );
  return path;
}

const INIT = {
  kind: "session_init",
  runner_type: "parity.init",
  payload: { runner_session_id: "parity-1", model: "script" },
};
const TERMINAL = {
  kind: "terminal",
  runner_type: "parity.terminal",
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
  runner_type: "parity.report",
  text,
  payload: {},
});

/** core's parityReport shape: the findings JSON, then the sentinel collect() holds it to. */
const CLEAN = `{"summary":"clean","findings":[]}\n\nFINDINGS: 0`;
const BLOCKED = `${JSON.stringify({
  summary: "one problem",
  findings: [
    {
      severity: "blocker",
      summary:
        "repo lib of this workspace has no active worktree on the ticket",
      file: null,
      line: null,
      category: "parity",
      detail_md: null,
    },
  ],
})}\n\nFINDINGS: 1`;

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of cleanups) await c();
});

interface Setup {
  /** The stand-in job's events and exit code. */
  readonly events?: readonly (object | string)[];
  readonly exit?: number;
  /** Seed the kind='util' agent the pick needs; default true. */
  readonly agent?: boolean;
  /**
   * The workspace the ticket is worked in. `submodule` is the shape `submodulesPublished` has a
   * branch for at all — a `multi` one returns at its `kind !== "submodule"` guard — and the shape
   * whose gitlinks a materialized workspace would have to resolve (H2).
   */
  readonly layout?: "multi" | "submodule";
}

/** The primary repo of each layout: what a repo-less workspace subject pins. */
const PRIMARY = { multi: "app", submodule: "super" } as const;

async function setup(o: Setup = {}) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const home = tempHome("frm-parity-gate-");
  cleanups.push(async () => {
    t.cleanup();
    home.cleanup();
  });
  const layout = o.layout ?? "multi";
  const jobPath = jobScript(
    home.path,
    "job",
    o.events ?? [INIT, report(CLEAN), TERMINAL],
    o.exit ?? 0,
  );
  const parity = createScriptAdapter({
    id: PARITY_RUNNER_ID,
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
      ...workspaceRows(home.path, layout),
      tickets: [
        ticketRow(1, { status: "code_review", workspace_id: "ws", num: 1 }),
      ],
    }),
  );
  // The job's runner and model rows, exactly as main.ts's registerParityRunner puts them in.
  unwrap(
    await upsertBootRows(t.db, { registrations: [parity.registration()] }),
  );
  unwrap(
    await seedRows(t.db, {
      run_classes: [
        {
          name: PARITY_RUN_CLASS,
          context_tokens_cap: 0,
          max_turns: 0,
          max_tool_calls: 0,
          wall_clock_ms: 60_000,
          cost_cap_usd: 0,
          handoff_at_turns: 0,
          default_tier: "cheap",
        },
      ],
      profiles: [
        {
          id: PARITY_AGENT_ID,
          name: PARITY_AGENT_ID,
          runner_id: PARITY_RUNNER_ID,
          model_tier: "cheap",
          env_json: JSON.stringify({ FRM_HOME: home.path }),
          tool_allowlist_json: "[]",
          version: 1,
          hash: "0".repeat(64),
          created_at: 0,
        },
      ],
      agents:
        (o.agent ?? true)
          ? [
              {
                id: PARITY_AGENT_ID,
                name: PARITY_AGENT_ID,
                kind: "util" as const,
                runner_id: PARITY_RUNNER_ID,
                executor_id: EXECUTOR_ID,
                profile_id: PARITY_AGENT_ID,
                workspace_id: null,
                created_at: 0,
              },
            ]
          : [],
    }),
  );

  const fixture = createFixtureAdapter({ clock });
  // The builder's runner needs a live certification (admission.require_certified); the parity job's
  // does not, and is deliberately never certified here — its exemption is JOB_RUNNERS ().
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
    [PARITY_RUNNER_ID, parity],
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
    // As main.ts does: the daemon's own job runners are exempt from `uncertified` (),
    // which is the whole reason the parity job needs no conformance certification.
    jobRunners: new Set([PARITY_RUNNER_ID]),
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
  // The builder: worktrees of both repos through the lifecycle.
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
  return {
    db: t.db,
    clock,
    home: home.path,
    engine,
    lifecycle,
    layout,
    primary: PRIMARY[layout],
  };
}
type World = Awaited<ReturnType<typeof setup>>;

/** One gate, as planRound would open it: repo-less, subject_kind from subjectOf. */
async function openGate(
  db: Db,
  clock: Clock,
  id: string,
  kind: GateKind,
  subjectKind: GateSubjectKind,
): Promise<void> {
  unwrap(
    await seedRows(db, {
      gates: [
        {
          id,
          ticket_id: TICKET,
          kind,
          state: "running",
          attempt: 1,
          repo_id: null,
          subject_kind: subjectKind,
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

/** The gate's one session, and the worktrees it was given (H2: none). */
async function gateSession(w: World, gateId: string) {
  const [row] = unwrap(await listGateSessions(w.db, [gateId]));
  const id = row?.session_id ?? "";
  return {
    session: unwrap(await getSession(w.db, id)),
    worktrees: unwrap(await listSessionWorktrees(w.db, id)),
  };
}

/** The builder's commit on the primary repo: the ticket's work, which the gate pins. */
async function workOnPrimary(w: World): Promise<string> {
  const rows = unwrap(await listTicketWorktrees(w.db, TICKET));
  const path = rows.find((x) => x.repo_id === w.primary)?.path ?? "";
  git(path, "commit", "-q", "--allow-empty", "-m", "the ticket's work");
  return git(path, "rev-parse", "HEAD");
}

/** What the job wrote, as `collect` stored it beside the evidence. */
const jobOutput = (g: GateRow): string => {
  const e = GateEvidence.parse(stored(g));
  const path = e.artifact_paths.find((p) => p.endsWith("output.txt")) ?? "";
  return readFileSync(path, "utf8");
};

describe("the parity_check gate", { timeout: 60_000 }, () => {
  test("a clean run passes with schema-valid evidence, as a util job on local", async () => {
    const w = await setup();
    await openGate(w.db, w.clock, "g-parity", "parity_check", "workspace");
    expect(unwrap(await claim(w, "g-parity"))).toMatchObject({
      gate_id: "g-parity",
    });
    const g = await decided(w, "g-parity");
    expect(g.state, String(g.evidence_json)).toBe("passed");
    const e = GateEvidence.parse(stored(g));
    expect(e).toMatchObject({
      exit_code: 0,
      runner_id: PARITY_RUNNER_ID,
      executor_id: EXECUTOR_ID,
      // A repo-less workspace subject pins the primary repo, never H3-refused (H3).
      subject: { repo_id: "app" },
      findings: { total: 0, parse: "heuristic" },
      flags: {},
    });
    expect(e.command).toContain("parity_check");
    // Invariant 10: every artifact the evidence names exists on disk.
    for (const path of e.artifact_paths) expect(existsSync(path)).toBe(true);
    const [row] = unwrap(await listGateSessions(w.db, ["g-parity"]));
    const session = unwrap(await getSession(w.db, row?.session_id ?? ""));
    expect(session).toMatchObject({
      role: "util",
      run_class: PARITY_RUN_CLASS,
      runner_id: PARITY_RUNNER_ID,
      executor_id: EXECUTOR_ID,
      agent_id: PARITY_AGENT_ID,
    });
  });

  test("a blocker finding fails the gate and is stored as a finding row", async () => {
    const w = await setup({ events: [INIT, report(BLOCKED), TERMINAL] });
    await openGate(w.db, w.clock, "g-parity", "parity_check", "workspace");
    unwrap(await claim(w, "g-parity"));
    const g = await decided(w, "g-parity");
    expect(g.state).toBe("failed");
    expect(stored(g)).toMatchObject({ reason: "blocking_findings" });
    const findings = unwrap(await listGateFindings(w.db, "g-parity"));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: "blocker",
      category: "parity",
      status: "open",
    });
  });

  test("a job that exits non-zero fails the gate, whatever it reported", async () => {
    const w = await setup({ events: [INIT, report(CLEAN), TERMINAL], exit: 3 });
    await openGate(w.db, w.clock, "g-parity", "parity_check", "workspace");
    unwrap(await claim(w, "g-parity"));
    const g = await decided(w, "g-parity");
    expect(g.state).toBe("failed");
    expect(stored(g)).toMatchObject({ reason: "reviewer_error", exit_code: 3 });
  });

  test("a report whose sentinel disagrees with its findings is not a review at all", async () => {
    const w = await setup({
      events: [
        INIT,
        report(`{"summary":"x","findings":[]}\n\nFINDINGS: 2`),
        TERMINAL,
      ],
    });
    await openGate(w.db, w.clock, "g-parity", "parity_check", "workspace");
    unwrap(await claim(w, "g-parity"));
    const g = await decided(w, "g-parity");
    expect(g.state).toBe("failed");
    expect(stored(g)).toMatchObject({ reason: "reviewer_error" });
  });

  test("no util agent: the gate fails no_reviewer saying exactly what is missing", async () => {
    const w = await setup({ agent: false });
    await openGate(w.db, w.clock, "g-parity", "parity_check", "workspace");
    unwrap(await claim(w, "g-parity"));
    const g = await decided(w, "g-parity");
    expect(g.state).toBe("failed");
    expect(stored(g)).toMatchObject({ reason: "no_reviewer" });
    expect(String(stored(g)["detail"])).toContain("none is enabled");
    expect(unwrap(await listGateSessions(w.db, ["g-parity"]))).toEqual([]);
  });

  test("a repo-less diff gate on the same ticket is still refused (H3)", async () => {
    const w = await setup();
    await openGate(w.db, w.clock, "g-diff", "code_review", "diff");
    unwrap(await claim(w, "g-diff"));
    const g = await decided(w, "g-diff");
    expect(g.state).toBe("failed");
    expect(String(stored(g)["detail"])).toContain("no ticket_repos");
  });

  test("the job is handed the pinned head in its env, never left to read the base (H1)", async () => {
    const w = await setup({ events: [INIT, "ENV_REPORT", TERMINAL] });
    // The ticket's work, on top of the base its worktree was placed at. Nothing writes
    // `worktrees.head_sha`, so this commit exists for the job only in the gate's pin.
    const worked = await workOnPrimary(w);
    await openGate(w.db, w.clock, "g-parity", "parity_check", "workspace");
    unwrap(await claim(w, "g-parity"));
    const g = await decided(w, "g-parity");
    expect(g.state, String(g.evidence_json)).toBe("passed");
    expect(jobOutput(g)).toContain(`${w.primary}@${worked}`);
    // And the evidence names the same commit, so the subject_ref it is stored under is the range
    // the job actually looked at (Invariant 10).
    expect(GateEvidence.parse(stored(g)).subject.head_sha).toBe(worked);
  });

  test("the gate's session is given no workspace and no worktree (H2)", async () => {
    const w = await setup();
    await openGate(w.db, w.clock, "g-parity", "parity_check", "workspace");
    unwrap(await claim(w, "g-parity"));
    expect((await decided(w, "g-parity")).state).toBe("passed");
    const { session, worktrees } = await gateSession(w, "g-parity");
    // The job reads the database and this host's mirrors, and nothing else. A materialized
    // workspace would add a way for the gate to die (planChild's ensureCommit) without adding a
    // way for it to answer.
    expect(session.workspace_id).toBeNull();
    expect(worktrees).toEqual([]);
  });

  test("a paused project holds its parity job: queued project_paused, not run, until the resume", async () => {
    const w = await setup();
    const setPaused = (paused: number) =>
      updateRowForTest(w.db, "workspaces", "ws", { paused });
    unwrap(await setPaused(1));
    await openGate(w.db, w.clock, "g-parity", "parity_check", "workspace");
    unwrap(await claim(w, "g-parity"));
    // The job runs with no workspace (H2) and on an agent with no project, yet its work is the
    // ticket's project's: it waits like every other gate session on the ticket would.
    await vi.waitFor(async () => {
      await w.lifecycle.settled();
      const { session } = await gateSession(w, "g-parity");
      expect(session).toMatchObject({
        state: "pending",
        queued_reason: "project_paused",
        workspace_id: null,
        executor_ref: null,
      });
    }, WAIT);
    expect(unwrap(await getGate(w.db, "g-parity")).state).toBe("running");

    unwrap(await setPaused(0));
    await w.clock.advance(5_000); // 012's admission.recheck_ms
    const g = await decided(w, "g-parity");
    expect(g.state, String(g.evidence_json)).toBe("passed");
  });

  test("a submodule workspace: no worktree either, and the report still decides it", async () => {
    const w = await setup({
      layout: "submodule",
      events: [INIT, "ENV_REPORT", TERMINAL],
    });
    const worked = await workOnPrimary(w);
    await openGate(w.db, w.clock, "g-parity", "parity_check", "workspace");
    unwrap(await claim(w, "g-parity"));
    const g = await decided(w, "g-parity");
    expect(g.state, String(g.evidence_json)).toBe("passed");
    // The pin took submodulesPublished's submodule branch (kind === "submodule", primary repo) and
    // was not refused there: a workspace subject reports an unpublished gitlink as a finding.
    expect(GateEvidence.parse(stored(g)).subject.repo_id).toBe("super");
    expect(jobOutput(g)).toContain(`super@${worked}`);
    const { session, worktrees } = await gateSession(w, "g-parity");
    expect(session.workspace_id).toBeNull();
    expect(worktrees).toEqual([]);
  });

  test("a pass without evidence is refused by decideGate (Invariant 10)", async () => {
    const w = await setup();
    await openGate(w.db, w.clock, "g-bare", "parity_check", "workspace");
    // Everything a passing gate needs except `command`: decideGate runs verdict() itself, so the
    // supervisor cannot store this as passed however it was assembled.
    const d = unwrap(
      await decideGate(w.db, {
        gate_id: "g-bare",
        session_id: null,
        evidence: {
          exit_code: 0,
          duration_ms: 1,
          cost_usd: 0,
          artifact_paths: ["/tmp/x"],
          run_id: "r",
          session_id: "s",
          runner_id: PARITY_RUNNER_ID,
          runner_version: "1",
          executor_id: EXECUTOR_ID,
          model: "script",
          subject: {
            repo_id: "app",
            base_sha: "a".repeat(40),
            head_sha: "b".repeat(40),
            files: 0,
          },
          findings: {
            total: 0,
            by_severity: { blocker: 0, major: 0, minor: 0, nit: 0 },
            parse: "heuristic",
          },
          flags: {},
        },
        findings: [],
      }),
    );
    expect(d.gate.state).toBe("failed");
    expect(stored(d.gate)).toEqual({ reason: "missing_evidence" });
  });
});
