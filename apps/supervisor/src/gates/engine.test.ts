// The gate engine end to end on real processes: a git source and its mirror,
// the builder's worktree through the lifecycle, reviewers on the local executor — the fixture
// runner (heuristic, held to its FINDINGS sentinel) and the stand-in runner that declares
// outputSchema (schema mode, Q1; found by its caps, never by name: Invariant 1). A FakeClock
// drives time; cross-process waits are deadlines (vi.waitFor), never a sleep.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  FakeClock,
  GateEvidence,
  GateFailure,
  newId,
  type Clock,
  type GateKind,
} from "@bayon/core";
import {
  gateReason,
  gateRunKey,
  getGate,
  getSession,
  getTicket,
  listGateFindings,
  listGateSessions,
  listGates,
  listSessionWorktrees,
  listSessionsInStates,
  listTicketEvents,
  type Db,
  type GateRow,
} from "@bayon/db";
import { claimCommand, decideGate } from "@bayon/db/supervisor";
import {
  insertCommand,
  seedRows,
  tempDb,
  ticketRow,
  unwrap,
} from "@bayon/db/testing";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import type { RunnerAdapter } from "@bayon/runners";
import {
  createFixtureAdapter,
  FIXTURE_RUNNER_ID,
  FIXTURE_VERSION,
  type FixtureScriptInput,
} from "@bayon/runners/fixture";
import { loadStubAdapter, STUB_RUNNER_IDS } from "@bayon/runners/testing";
import { pino } from "pino";
import { afterAll, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { upsertBootRows } from "../boot.js";
import { createIngest } from "../ingest/ingest.js";
import { createLifecycle, type Lifecycle } from "../lifecycle/index.js";
import { envSecrets } from "../lifecycle/secrets.js";
import {
  CMD,
  EXECUTOR_ID,
  lifecycleRows,
  spawnPayload,
  tempHome,
} from "../lifecycle/testing/fixtures.js";
import { createGateEngine, type GateEngine } from "./engine.js";

const T0 = Date.UTC(2026, 8, 14, 12);
const WAIT = { timeout: 25_000, interval: 10 };
const WALL_CLOCK_MS = 900_000; // 007's gates.wall_clock_ms
const TURN = { kind: "turn_start", runner_type: "fixture.step", payload: {} };
const say = (text: string) => ({
  kind: "assistant_text",
  runner_type: "fixture.text",
  text,
  payload: {},
});
/** The stand-in's clean review (its prompt carries the ticket). */
const CLEAN = "frm-stub: clean review";
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

/** The stand-in runner that declares outputSchema. */
function schemaAdapter(): RunnerAdapter {
  for (const id of STUB_RUNNER_IDS) {
    const a = loadStubAdapter(id);
    if (a.ok && a.value.caps().outputSchema) return a.value;
  }
  throw new Error("no stand-in runner declares outputSchema");
}

const Defaults = z.looseObject({
  secretEnv: z.array(z.string()).optional(),
  secretEnvAnyOf: z.array(z.array(z.string()).min(1)).optional(),
});

/** A test value for each secret the runner's defaults ask for. */
function secretsFor(a: RunnerAdapter): Record<string, string> {
  const d = Defaults.parse(a.registration().runner.defaults);
  const names = [
    ...(d.secretEnv ?? []),
    ...(d.secretEnvAnyOf ?? []).flatMap((group) => group.slice(0, 1)),
  ];
  return Object.fromEntries(
    names.map((n) => [`FRM_SECRET_${n}`, "test-secret"]),
  );
}

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

interface Binding {
  readonly role: string;
  readonly runner_id: string;
  readonly fallback_runner_id?: string;
  readonly profile_id?: string;
}

interface Setup {
  /** The fixture reviewer's script (profile p-review). */
  readonly review?: FixtureScriptInput;
  /** Runners certified on `local`; default both. */
  readonly certify?: (schema: string) => readonly string[];
  readonly bindings?: (schema: string) => readonly Binding[];
  /** The runners that have a reviewer agent; default both. */
  readonly reviewers?: (schema: string) => readonly string[];
  /** Files the builder commits. */
  readonly files?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** A commit on main after the builder forked (drift). */
  readonly moveBase?: boolean;
  /** Gates seeded before the engine starts: the restart sweep's to find (M1). */
  readonly before?: readonly { readonly id: string; readonly kind: GateKind }[];
  /** The ticket's status: a retry opens only while it is in its gate's review status. */
  readonly status?: "code_review" | "plan_review";
  /** A trivial ticket: its code review round is code_review alone (default non-trivial). */
  readonly trivial?: boolean;
}

interface Engine {
  readonly lifecycle: Lifecycle;
  readonly engine: GateEngine;
  readonly executor: LocalExecutor;
}

/** A lifecycle and a gate engine over `db`: what one supervisor process holds. */
async function supervise(
  db: Db,
  clock: Clock,
  home: string,
  boot = true,
): Promise<Engine> {
  const fixture = createFixtureAdapter({ clock });
  const schema = schemaAdapter();
  const adapters = new Map<string, RunnerAdapter>([
    [fixture.id, fixture],
    [schema.id, schema],
  ]);
  const slots = new SlotCounter(6);
  const executor = new LocalExecutor({ id: EXECUTOR_ID, slots });
  const ingest = createIngest({
    db,
    clock,
    log: pino({ level: "silent" }),
    maxRows: 1,
  });
  const quiet = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const lifecycle = createLifecycle({
    db,
    clock,
    log: quiet,
    frmHome: home,
    executors: new Map([[EXECUTOR_ID, { executor, slots }]]),
    adapters,
    ingest,
    secrets: envSecrets(secretsFor(schema)),
    mcpReachable: async () => true,
  });
  if (boot) unwrap(await lifecycle.boot());
  const engine = createGateEngine({
    db,
    clock,
    log: quiet,
    frmHome: home,
    lifecycle,
    adapters,
    executors: new Map([[EXECUTOR_ID, executor]]),
    path: process.env["PATH"] ?? "",
  });
  cleanups.unshift(async () => {
    const live = await listSessionsInStates(db, [...LIVE]);
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
  return { lifecycle, engine, executor };
}

async function setup(o: Setup = {}) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const home = tempHome("frm-gate-");
  cleanups.push(async () => {
    t.cleanup();
    home.cleanup();
  });
  const src = join(home.path, "src");
  mkdirSync(src);
  git(src, "init", "-q", "-b", "main");
  writeFileSync(join(src, "README.md"), "hello\n");
  git(src, "add", ".");
  git(src, "commit", "-q", "-m", "one");
  const mirror = join(home.path, "mirror.git");
  git(home.path, "clone", "-q", "--mirror", src, mirror);
  const reg = schemaAdapter().registration();
  const schemaId = reg.runner.id;
  const base = lifecycleRows({
    script: { runs: [{ events: [TURN, say("built\nFINDINGS: 0")] }] },
    // Wide margins: the tests advance the fake clock by a gate's whole wall
    // clock, so no reconciler pass may start a real health-check process whose fake-clock
    // timeout would pass mid-check under load and mark the executor unhealthy.
    settings: {
      "reconciler.interval_ms": 86_400_000,
      "executor.health_timeout_ms": 86_400_000,
    },
  });
  unwrap(
    await seedRows(t.db, {
      ...base,
      repos: [
        { id: "repo", name: "repo", origin_url: src, mirror_path: mirror },
      ],
      workspaces: [{ id: "ws", name: "ws", kind: "single" }],
      workspace_repos: [
        {
          workspace_id: "ws",
          repo_id: "repo",
          rel_path: "repo",
          role: "primary",
        },
      ],
      tickets: [
        ticketRow(1, {
          status: o.status ?? "code_review",
          workspace_id: "ws",
          non_trivial: o.trivial === true ? 0 : 1,
          plan_path: "docs/plan.md",
          body_md: o.body ?? CLEAN,
        }),
      ],
    }),
  );
  unwrap(await upsertBootRows(t.db, { registrations: [reg] }));
  const profile = (id: string, runner_id: string, sandbox: object) => ({
    id,
    name: id,
    runner_id,
    model_tier:
      runner_id === schemaId ? (reg.models[0]?.tier ?? "standard") : "standard",
    sandbox_json: JSON.stringify(sandbox),
    // No MCP tools: a gate's reviewer answers in its output file, so no_tools lets it by.
    tool_allowlist_json: "[]",
    version: 1,
    hash: "0".repeat(64),
    created_at: 0,
  });
  const agent = (id: string, runner_id: string, profile_id: string) => ({
    id,
    name: id,
    kind: "reviewer" as const,
    runner_id,
    executor_id: EXECUTOR_ID,
    profile_id,
    created_at: 0,
  });
  const version = (id: string) =>
    id === schemaId ? reg.runner.versionDetected : FIXTURE_VERSION;
  unwrap(
    await seedRows(t.db, {
      profiles: [
        profile("p-review", FIXTURE_RUNNER_ID, {
          script: o.review ?? {
            runs: [{ events: [TURN, say("Sound.\nFINDINGS: 0")] }],
          },
        }),
        profile("p-hang", FIXTURE_RUNNER_ID, {
          script: { runs: [{ events: [TURN], then: "hang" }] },
        }),
        profile("p-schema", schemaId, { sandbox: "read-only" }),
      ],
      agents: [
        agent("rev-fixture", FIXTURE_RUNNER_ID, "p-review"),
        agent("rev-schema", schemaId, "p-schema"),
      ].filter((a) =>
        (o.reviewers?.(schemaId) ?? [FIXTURE_RUNNER_ID, schemaId]).includes(
          a.runner_id,
        ),
      ),
      runner_certifications: (
        o.certify?.(schemaId) ?? [FIXTURE_RUNNER_ID, schemaId]
      ).map((id) => ({
        runner_id: id,
        executor_id: EXECUTOR_ID,
        // The model each reviewer's profile runs (its tier above): certification is per model.
        model_id:
          id === schemaId
            ? (reg.models[0]?.id ?? `${schemaId}.standard`)
            : `${FIXTURE_RUNNER_ID}.standard`,
        model: "m",
        runner_version: version(id),
        suite_version: "test",
        kit_hash: "k",
        caps_hash: "c",
        result_json: "{}",
        gate_eligible: 1,
        passed_at: T0,
        certified_at: T0,
      })),
      role_bindings: (
        o.bindings?.(schemaId) ?? [
          { role: "code_reviewer", runner_id: schemaId },
          { role: "plan_reviewer", runner_id: FIXTURE_RUNNER_ID },
        ]
      ).map((b) => ({ ...b, updated_at: 0 })),
    }),
  );
  const first = await supervise(t.db, clock, home.path);
  // The builder: a worktree through the lifecycle, one commit on its branch.
  unwrap(
    await first.lifecycle.handlers.spawn.handle(
      spawnPayload("B1", { workspace_id: "ws", ticket_id: "ticket-1" }),
      CMD,
    ),
  );
  await vi.waitFor(async () => {
    await first.lifecycle.settled();
    expect(unwrap(await getSession(t.db, "B1")).state).toBe("idle");
  }, WAIT);
  const wt = join(home.path, "work", "B1", "repo");
  const fork = git(wt, "rev-parse", "HEAD");
  for (const [path, text] of Object.entries(
    o.files ?? { "src/a.js": "export const a = 1;\n" },
  )) {
    mkdirSync(dirname(join(wt, path)), { recursive: true });
    writeFileSync(join(wt, path), text);
  }
  git(wt, "add", ".");
  git(wt, "commit", "-q", "-m", "work");
  if (o.moveBase === true) {
    writeFileSync(join(src, "README.md"), "moved\n");
    git(src, "commit", "-q", "-am", "two");
  }
  for (const g of o.before ?? []) await openGate(t.db, clock, g.id, g.kind);
  await first.engine.start();
  return {
    ...first,
    db: t.db,
    clock,
    home: home.path,
    mirror,
    schemaId,
    /** The model the schema reviewer's profile runs: what its certification is checked on. */
    schemaModel: reg.models[0]?.model ?? null,
    base: fork,
    head: git(wt, "rev-parse", "HEAD"),
  };
}
type World = Awaited<ReturnType<typeof setup>>;

async function openGate(
  db: Db,
  clock: Clock,
  id: string,
  kind: GateKind,
  attempt = 1,
) {
  const plan = kind === "plan_review";
  unwrap(
    await seedRows(db, {
      gates: [
        {
          id,
          ticket_id: "ticket-1",
          kind,
          state: "running",
          attempt,
          subject_kind: plan ? "plan" : "diff",
          subject_ref: plan ? "docs/plan.md" : "unpinned",
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

/** The gate's evidence_json, parsed. */
const stored = (g: GateRow): unknown =>
  JSON.parse(String(g.evidence_json)) as unknown;

async function decided(w: World, id: string): Promise<GateRow> {
  return vi.waitFor(async () => {
    const g = unwrap(await getGate(w.db, id));
    expect(g.state).not.toBe("running");
    return g;
  }, WAIT);
}

/** The gate's reviewer session, once it is running. */
async function reviewing(w: World, gateId: string): Promise<string> {
  return vi.waitFor(async () => {
    const [s] = unwrap(await listGateSessions(w.db, [gateId]));
    expect(s).toBeDefined();
    const sid = s?.session_id ?? "";
    expect(unwrap(await getSession(w.db, sid)).state).toBe("running");
    return sid;
  }, WAIT);
}

const gatesOf = async (w: World, kind: string) =>
  unwrap(
    await listGates(w.db, { ticket_id: "ticket-1", latest: false, limit: 20 }),
  )
    .rows.filter((g) => g.kind === kind)
    .toSorted((a, b) => a.attempt - b.attempt);

/** ticket-1's status, and the transitions it took: who, from, to. */
async function moves(w: World) {
  const ticket = unwrap(await getTicket(w.db, "ticket-1"));
  const events = unwrap(
    await listTicketEvents(w.db, {
      ticket_id: "ticket-1",
      since: 0,
      limit: 100,
    }),
  );
  return {
    status: ticket.status,
    transitions: events.rows
      .filter((e) => e.kind === "transition")
      .map((e) => ({
        actor_kind: e.actor_kind,
        actor_id: e.actor_id,
        from: e.from_status,
        to: e.to_status,
      })),
  };
}

/** A passed gate's evidence parses GateEvidence, and every artifact exists (Invariant 10). */
function passedEvidence(g: GateRow): GateEvidence {
  expect(g.state, `gate ${g.id}: ${g.evidence_json ?? "no evidence"}`).toBe(
    "passed",
  );
  const e = GateEvidence.parse(JSON.parse(g.evidence_json ?? "null"));
  for (const path of e.artifact_paths) expect(existsSync(path)).toBe(true);
  return e;
}

describe("the gate engine on real processes", { timeout: 60_000 }, () => {
  test("code_review: a schema reviewer passes a clean change with full evidence; its worktree stays for the sweep", async () => {
    const w = await setup();
    await openGate(w.db, w.clock, "g-code", "code_review");
    expect(unwrap(await claim(w, "g-code"))).toMatchObject({
      gate_id: "g-code",
    });
    const g = await decided(w, "g-code");
    const e = passedEvidence(g);
    expect(e).toMatchObject({
      exit_code: 0,
      runner_id: w.schemaId,
      executor_id: EXECUTOR_ID,
      subject: { base_sha: w.base, head_sha: w.head, files: 1 },
      findings: { total: 0, parse: "schema" },
    });
    expect(g.subject_ref).toBe(`${w.base}..${w.head}`);
    const diff = e.artifact_paths.find((p) => p.endsWith("diff.patch")) ?? "";
    expect(readFileSync(diff, "utf8").trim()).toBe(
      git(w.mirror, "diff", "--no-color", w.base, w.head),
    );
    const [s] = unwrap(await listGateSessions(w.db, ["g-code"]));
    await vi.waitFor(async () => {
      await w.engine.settled();
      const [wt] = unwrap(
        await listSessionWorktrees(w.db, s?.session_id ?? ""),
      );
      // Design an earlier change N4: the end hook leaves it `active`; the sweep takes it after min_ended_ms.
      expect(wt).toMatchObject({
        state: "active",
        branch: `detached@${w.head.slice(0, 12)}`,
      });
    }, WAIT);
    expect(
      git(w.mirror, "for-each-ref", "--format=%(refname)", "refs/heads/frm/"),
    ).toBe("refs/heads/frm/B1");
  });

  test("code_review: a major finding fails the gate blocking_findings, stored open, no retry", async () => {
    const w = await setup({ body: "please review" });
    await openGate(w.db, w.clock, "g-code", "code_review");
    unwrap(await claim(w, "g-code"));
    const g = await decided(w, "g-code");
    expect([g.state, gateReason(g.evidence_json)]).toEqual([
      "failed",
      "blocking_findings",
    ]);
    expect(unwrap(await listGateFindings(w.db, "g-code"))).toMatchObject([
      { severity: "major", status: "open", file: "add.js" },
    ]);
    await w.engine.settled();
    expect((await gatesOf(w, "code_review")).map((x) => x.attempt)).toEqual([
      1,
    ]);
    // A code failure with its blocker open, and nothing else of the round running: the decision
    // took request_fix in its own transaction.
    expect(await moves(w)).toEqual({
      status: "review_fix",
      transitions: [
        {
          actor_kind: "supervisor",
          actor_id: "gate_engine",
          from: "code_review",
          to: "review_fix",
        },
      ],
    });
  });

  test("plan_review with one certified runner: runs anyway, flagged single_runner_review, heuristic", async () => {
    const w = await setup({
      files: { "docs/plan.md": "# plan\n" },
      certify: () => [FIXTURE_RUNNER_ID],
    });
    await openGate(w.db, w.clock, "g-plan", "plan_review");
    unwrap(await claim(w, "g-plan"));
    const e = passedEvidence(await decided(w, "g-plan"));
    expect(e).toMatchObject({
      runner_id: FIXTURE_RUNNER_ID,
      flags: { single_runner_review: true },
      findings: { total: 0, parse: "heuristic" },
      source_changes: { total: 0 },
    });
  });

  test("plan_review: a review whose FINDINGS line does not match fails reviewer_error (C2)", async () => {
    const w = await setup({
      files: { "docs/plan.md": "# plan\n" },
      review: {
        runs: [
          {
            events: [TURN, say("[major] docs/plan.md:1 — vague\nFINDINGS: 2")],
          },
        ],
      },
    });
    await openGate(w.db, w.clock, "g-plan", "plan_review");
    unwrap(await claim(w, "g-plan"));
    const g = await decided(w, "g-plan");
    expect([g.state, gateReason(g.evidence_json)]).toEqual([
      "failed",
      "reviewer_error",
    ]);
    expect(unwrap(await listGateFindings(w.db, "g-plan"))).toEqual([]);
  });

  test("plan_review: a source change fails source_changes with a blocker, and no reviewer starts", async () => {
    const w = await setup({
      files: { "docs/plan.md": "# plan\n", "src/a.js": "x\n" },
    });
    await openGate(w.db, w.clock, "g-plan", "plan_review");
    unwrap(await claim(w, "g-plan"));
    const g = await decided(w, "g-plan");
    expect([g.state, gateReason(g.evidence_json)]).toEqual([
      "failed",
      "source_changes",
    ]);
    expect(unwrap(await listGateFindings(w.db, "g-plan"))).toMatchObject([
      {
        severity: "blocker",
        category: "source_changes",
        file: "src/a.js",
        status: "open",
      },
    ]);
    expect(unwrap(await listGateSessions(w.db, ["g-plan"]))).toEqual([]);
    // The detail is in the row, not only the log.
    expect(stored(g)).toEqual({
      reason: "source_changes",
      detail: "1 source file(s) outside the plan paths: src/a.js",
    });
  });

  test("a base that moved before the pin fails base_drift, the base and tip stored, and no reviewer starts", async () => {
    const w = await setup({ moveBase: true });
    await openGate(w.db, w.clock, "g-code", "code_review");
    unwrap(await claim(w, "g-code"));
    const g = await decided(w, "g-code");
    expect([g.state, gateReason(g.evidence_json)]).toEqual([
      "failed",
      "base_drift",
    ]);
    expect(unwrap(await listGateSessions(w.db, ["g-code"]))).toEqual([]);
    const tip = git(join(w.home, "src"), "rev-parse", "HEAD");
    expect(tip).not.toBe(w.base);
    expect(stored(g)).toEqual({
      reason: "base_drift",
      detail: `the pinned base ${w.base} is not the tip ${tip}`,
      drift: { base_sha: w.base, tip_sha: tip },
    });
  });

  test("no certified reviewer with outputSchema for code_review: failed no_reviewer (Q1), the bound runner's reason stored", async () => {
    const w = await setup({ certify: () => [FIXTURE_RUNNER_ID] });
    await openGate(w.db, w.clock, "g-code", "code_review");
    unwrap(await claim(w, "g-code"));
    const g = await decided(w, "g-code");
    expect([g.state, gateReason(g.evidence_json)]).toEqual([
      "failed",
      "no_reviewer",
    ]);
    expect(stored(g)).toEqual({
      reason: "no_reviewer",
      detail: `code_reviewer on ${EXECUTOR_ID} (bound to ${w.schemaId}): ${w.schemaId} (model ${w.schemaModel}): not certified here`,
      considered: {
        role: "code_reviewer",
        executor_id: EXECUTOR_ID,
        bound: true,
        runners: [
          {
            runner_id: w.schemaId,
            model: w.schemaModel,
            why: ["not_certified"],
          },
        ],
      },
    });
  });

  test("unbound, nobody can review code: every runner's reasons are stored, structured output among them", async () => {
    const w = await setup({
      certify: () => [FIXTURE_RUNNER_ID],
      bindings: () => [],
    });
    await openGate(w.db, w.clock, "g-code", "code_review");
    unwrap(await claim(w, "g-code"));
    const g = GateFailure.parse(stored(await decided(w, "g-code")));
    expect(g).toMatchObject({
      reason: "no_reviewer",
      considered: {
        role: "code_reviewer",
        executor_id: EXECUTOR_ID,
        bound: false,
      },
    });
    const why = new Map(
      g.considered?.runners.map((r) => [r.runner_id, r.why]) ?? [],
    );
    expect(why.get(FIXTURE_RUNNER_ID)).toEqual(["needs_output_schema"]);
    expect(why.get(w.schemaId)).toEqual(["not_certified"]);
    expect(g.detail).toContain("(unbound: every runner)");
    expect(g.detail).toContain(
      `${FIXTURE_RUNNER_ID}: code_review needs structured output`,
    );
  });

  test("a bound runner without a reviewer agent fails no_reviewer and says so", async () => {
    const w = await setup({
      files: { "docs/plan.md": "# plan\n" },
      reviewers: (schema) => [schema],
    });
    await openGate(w.db, w.clock, "g-plan", "plan_review");
    unwrap(await claim(w, "g-plan"));
    const g = await decided(w, "g-plan");
    expect(stored(g)).toEqual({
      reason: "no_reviewer",
      detail: `plan_reviewer on ${EXECUTOR_ID} (bound to ${FIXTURE_RUNNER_ID}): ${FIXTURE_RUNNER_ID}: no reviewer agent`,
      considered: {
        role: "plan_reviewer",
        executor_id: EXECUTOR_ID,
        bound: true,
        runners: [{ runner_id: FIXTURE_RUNNER_ID, why: ["no_reviewer_agent"] }],
      },
    });
    expect(unwrap(await listGateSessions(w.db, ["g-plan"]))).toEqual([]);
  });

  test("a bound runner without a reviewer agent falls back to the fallback that has one", async () => {
    const w = await setup({
      files: { "docs/plan.md": "# plan\n" },
      reviewers: (schema) => [schema],
      bindings: (schema) => [
        {
          role: "plan_reviewer",
          runner_id: FIXTURE_RUNNER_ID,
          fallback_runner_id: schema,
        },
      ],
    });
    await openGate(w.db, w.clock, "g-plan", "plan_review");
    unwrap(await claim(w, "g-plan"));
    await decided(w, "g-plan");
    const [s] = unwrap(await listGateSessions(w.db, ["g-plan"]));
    expect(
      unwrap(await getSession(w.db, s?.session_id ?? "none")),
    ).toMatchObject({
      runner_id: w.schemaId,
      agent_id: "rev-schema",
      fallback_from_runner_id: FIXTURE_RUNNER_ID,
    });
  });

  test("a bound runner without outputSchema falls back to the schema runner, and both records say so", async () => {
    const w = await setup({
      bindings: (schema) => [
        {
          role: "code_reviewer",
          runner_id: FIXTURE_RUNNER_ID,
          fallback_runner_id: schema,
        },
      ],
    });
    await openGate(w.db, w.clock, "g-code", "code_review");
    unwrap(await claim(w, "g-code"));
    const e = passedEvidence(await decided(w, "g-code"));
    expect(e).toMatchObject({
      runner_id: w.schemaId,
      flags: { fallback_from: FIXTURE_RUNNER_ID },
    });
    expect(unwrap(await getSession(w.db, e.session_id))).toMatchObject({
      gate_id: "g-code",
      fallback_from_runner_id: FIXTURE_RUNNER_ID,
      role: "reviewer",
      run_class: "review",
    });
  });

  test("ce_review is the builder's runner and agent, not flagged single-runner", async () => {
    const w = await setup();
    await openGate(w.db, w.clock, "g-ce", "ce_review");
    unwrap(await claim(w, "g-ce"));
    const e = passedEvidence(await decided(w, "g-ce"));
    expect(e.runner_id).toBe(FIXTURE_RUNNER_ID);
    expect(e.flags).toEqual({});
    expect(unwrap(await getSession(w.db, e.session_id)).agent_id).toBe(
      unwrap(await getSession(w.db, "B1")).agent_id,
    );
  });

  test("gate.run for a gate no longer running spawns nothing; an unknown gate is not_found", async () => {
    const w = await setup();
    await openGate(w.db, w.clock, "g-code", "code_review");
    unwrap(
      await decideGate(w.db, {
        gate_id: "g-code",
        session_id: null,
        evidence: { reason: "superseded" },
        findings: [],
      }),
    );
    expect(unwrap(await claim(w, "g-code"))).toEqual({
      gate_id: "g-code",
      skipped: "failed",
    });
    expect(await claim(w, "nope")).toMatchObject({
      ok: false,
      error: { class: "not_found" },
    });
    expect(unwrap(await listGateSessions(w.db, ["g-code"]))).toEqual([]);
  });

  test("a gate that never started is started by the sweep, not decided (M1)", async () => {
    const w = await setup({ before: [{ id: "g-code", kind: "code_review" }] });
    passedEvidence(await decided(w, "g-code"));
    expect((await gatesOf(w, "code_review")).map((x) => x.attempt)).toEqual([
      1,
    ]);
  });
});

describe("the machine step a decision settles", { timeout: 60_000 }, () => {
  test("a plan_review the fixture reviewer passes takes the ticket to planned, as the supervisor", async () => {
    const w = await setup({
      status: "plan_review",
      files: { "docs/plan.md": "# plan\n" },
    });
    await openGate(w.db, w.clock, "g-plan", "plan_review");
    unwrap(await claim(w, "g-plan"));
    passedEvidence(await decided(w, "g-plan"));
    expect(await moves(w)).toEqual({
      status: "planned",
      transitions: [
        {
          actor_kind: "supervisor",
          actor_id: "gate_engine",
          from: "plan_review",
          to: "planned",
        },
      ],
    });
  });

  test("a trivial ticket's passing code_review takes it to qa_harness", async () => {
    const w = await setup({ trivial: true });
    await openGate(w.db, w.clock, "g-code", "code_review");
    unwrap(await claim(w, "g-code"));
    passedEvidence(await decided(w, "g-code"));
    expect(await moves(w)).toMatchObject({
      status: "qa_harness",
      transitions: [{ actor_kind: "supervisor", to: "qa_harness" }],
    });
  });

  test("no_reviewer moves nothing: the ticket stays in code_review", async () => {
    const w = await setup({
      trivial: true,
      certify: () => [FIXTURE_RUNNER_ID],
    });
    await openGate(w.db, w.clock, "g-code", "code_review");
    unwrap(await claim(w, "g-code"));
    const g = await decided(w, "g-code");
    expect(gateReason(g.evidence_json)).toBe("no_reviewer");
    await w.engine.settled();
    expect(await moves(w)).toEqual({
      status: "code_review",
      transitions: [],
    });
  });
});

describe("the gate engine's clocks and restarts", { timeout: 90_000 }, () => {
  const hang = (): Setup => ({
    status: "plan_review",
    files: { "docs/plan.md": "# plan\n" },
    bindings: () => [
      {
        role: "plan_reviewer",
        runner_id: FIXTURE_RUNNER_ID,
        profile_id: "p-hang",
      },
    ],
  });

  test("a hung reviewer times out at the wall clock; attempt 2 retries under a new session, then stops", async () => {
    const w = await setup(hang());
    await openGate(w.db, w.clock, "g-plan", "plan_review");
    unwrap(await claim(w, "g-plan"));
    const first = await reviewing(w, "g-plan");
    await w.clock.advance(WALL_CLOCK_MS);
    await vi.waitFor(async () => {
      await w.clock.advance(1_000);
      expect(
        gateReason(unwrap(await getGate(w.db, "g-plan")).evidence_json),
      ).toBe("timeout");
    }, WAIT);
    const retry = await vi.waitFor(async () => {
      const [, second] = await gatesOf(w, "plan_review");
      expect(second).toMatchObject({ attempt: 2, state: "running" });
      return second?.id ?? "";
    }, WAIT);
    const again = await reviewing(w, retry);
    expect(again).not.toBe(first);
    await w.clock.advance(WALL_CLOCK_MS);
    await vi.waitFor(async () => {
      await w.clock.advance(1_000);
      expect(gateReason(unwrap(await getGate(w.db, retry)).evidence_json)).toBe(
        "timeout",
      );
    }, WAIT);
    await w.engine.settled();
    expect(
      (await gatesOf(w, "plan_review")).map((g) => [g.attempt, g.state]),
    ).toEqual([
      [1, "failed"],
      [2, "failed"],
    ]);
  });

  test("a gate superseded under a live reviewer: the poll kills it, and nothing more is written", async () => {
    const w = await setup(hang());
    await openGate(w.db, w.clock, "g-plan", "plan_review");
    unwrap(await claim(w, "g-plan"));
    const sid = await reviewing(w, "g-plan");
    unwrap(
      await decideGate(w.db, {
        gate_id: "g-plan",
        session_id: null,
        evidence: { reason: "superseded" },
        findings: [],
      }),
    );
    await w.engine.tick();
    await vi.waitFor(async () => {
      await w.clock.advance(1_000);
      expect(unwrap(await getSession(w.db, sid)).state).toBe("exited");
    }, WAIT);
    await w.engine.settled();
    const g = unwrap(await getGate(w.db, "g-plan"));
    expect([g.state, g.evidence_json]).toEqual([
      "failed",
      '{"reason":"superseded"}',
    ]);
    expect(await gatesOf(w, "plan_review")).toHaveLength(1);
  });

  test("a restart mid-review: the orphan is killed, never adopted; the gate fails supervisor_restart; attempt 2 starts", async () => {
    const w = await setup(hang());
    await openGate(w.db, w.clock, "g-plan", "plan_review");
    unwrap(await claim(w, "g-plan"));
    const sid = await reviewing(w, "g-plan");
    // The supervisor goes down: nothing is killed, the reviewer keeps running.
    await w.engine.stop();
    await w.lifecycle.shutdown();
    const next = await supervise(w.db, w.clock, w.home, false);
    const booted = next.lifecycle.boot().then(() => true);
    await vi.waitFor(async () => {
      await w.clock.advance(100); // the reconciler's re-probe interval
      expect(await Promise.race([booted, Promise.resolve(false)])).toBe(true);
    }, WAIT);
    // Its process predates this supervisor: the restart's class.
    expect(unwrap(await getSession(w.db, sid))).toMatchObject({
      state: "exited",
      error_class: "supervisor_restart",
      error_message: "a reviewer session is never adopted",
    });
    await next.engine.start();
    const g = unwrap(await getGate(w.db, "g-plan"));
    expect([g.state, gateReason(g.evidence_json)]).toEqual([
      "failed",
      "supervisor_restart",
    ]);
    const second = await vi.waitFor(async () => {
      const [, s] = await gatesOf(w, "plan_review");
      expect(s).toMatchObject({ attempt: 2, state: "running" });
      return s?.id ?? "";
    }, WAIT);
    expect(await reviewing(w, second)).not.toBe(sid);
  });

  test("a gate.run a dead process left claimed: the boot sweep leaves it to the requeue, whose re-delivery starts the review (LOW-3)", async () => {
    const w = await setup(hang());
    await openGate(w.db, w.clock, "g-left", "plan_review");
    const payload = { gate_id: "g-left", session_id: newId(w.clock.now()) };
    unwrap(
      await insertCommand(w.db, {
        type: w.engine.handler.type,
        payload,
        idempotencyKey: gateRunKey("g-left"),
      }),
    );
    expect(unwrap(await claimCommand(w.db))?.idempotency_key).toBe(
      gateRunKey("g-left"),
    );
    // The supervisor restarts: its boot sweep runs before any claim.
    await w.engine.stop();
    await w.lifecycle.shutdown();
    const next = await supervise(w.db, w.clock, w.home, false);
    const booted = next.lifecycle.boot().then(() => true);
    await vi.waitFor(async () => {
      await w.clock.advance(100); // the reconciler's re-probe interval
      expect(await Promise.race([booted, Promise.resolve(false)])).toBe(true);
    }, WAIT);
    await next.engine.start();
    expect(unwrap(await listGateSessions(w.db, ["g-left"]))).toEqual([]);
    expect(unwrap(await getGate(w.db, "g-left")).state).toBe("running");
    // The boot requeue's re-delivery (attempt 2) starts the review under the payload's id.
    unwrap(await next.engine.handler.handle(payload, { ...CMD, attempts: 2 }));
    await vi.waitFor(async () => {
      const ids = unwrap(await listGateSessions(w.db, ["g-left"])).map(
        (s) => s.session_id,
      );
      expect(ids).toEqual([payload.session_id]);
    }, WAIT);
  });
});
