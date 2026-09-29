import { existsSync, readFileSync } from "node:fs";
import {
  CI_SUBJECT,
  CiGateEvidence,
  FakeClock,
  StoredGateEvidence,
  forgeTokenSecret,
  ok,
} from "@bayon/core";
import { getNextStepFacts } from "@bayon/db";
import {
  OPERATOR,
  dumpAllRows,
  seedRows,
  tempDb,
  transitionTicket,
  unwrap,
  updateRowForTest,
} from "@bayon/db/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  checkRun,
  commitStatus,
  fixtureRemote,
  startForgeFixture,
  type ForgeFixture,
} from "../forge/fixtures.js";
import { sweepMachineSteps } from "../lifecycle/machine-sweep.js";
import { CI_CHECKS_ARTIFACT, sweepCiGates } from "./ci-checks.js";
import {
  BRANCH,
  PROJECT,
  T0,
  TICKET,
  makeRepo,
  makeWorld,
  projectRows,
  secretsOf,
  type RepoOnDisk,
  type World,
} from "./testing/world.js";

// The CI sweep against the fixture forge and real mirrors: a CI gate decided from the
// checks on its pull request — a pass to qa_human, a failed check to rework through fail_harness —
// and every way it waits or fails as infra. No test reaches a real forge.

const TOKEN = "a-secret-forge-token";
const PR_URL = "https://forge.test/pull/1";
const MIN = 60_000;

let fixture: ForgeFixture;
let world: World | null = null;
let temp: { cleanup(): void } | null = null;

beforeEach(async () => {
  fixture = await startForgeFixture();
});

afterEach(async () => {
  world?.cleanup();
  world = null;
  temp?.cleanup();
  temp = null;
  await fixture.close();
});

interface Spec {
  /** The delivery row's head: the mirror's (the default), another commit, or none at all. */
  readonly delivered?: "head" | "stale" | "none";
  readonly required?: readonly string[];
  readonly token?: boolean;
  /** The project's repos, each delivered with its own pull request; one by default. */
  readonly repos?: readonly string[];
}

interface Ci {
  readonly w: World;
  readonly clock: FakeClock;
  /** The first repo. */
  readonly repo: RepoOnDisk;
  readonly repos: readonly RepoOnDisk[];
}

async function ciWorld(s: Spec = {}): Promise<Ci> {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  temp = t;
  const w = makeWorld(t.db, clock, {
    secrets: secretsOf(
      s.token === false ? {} : { [forgeTokenSecret("github")]: TOKEN },
    ),
    forgeFetch: fixture.fetchVia(),
    forgeRemoteOf: () => fixtureRemote(),
  });
  world = w;
  const repos = (s.repos ?? ["r1"]).map((id) => makeRepo(w.home.path, id));
  const [repo] = repos;
  if (repo === undefined) throw new Error("a CI world needs a repo");
  const rows = projectRows({
    repos,
    kind: repos.length > 1 ? "multi" : "single",
    status: "qa_harness",
  });
  const delivered = s.delivered ?? "head";
  unwrap(
    await seedRows(t.db, {
      ...rows,
      workspaces: rows.workspaces.map((ws) => ({
        ...ws,
        qa_mode: "ci" as const,
        qa_ci_checks_json:
          s.required === undefined ? null : JSON.stringify(s.required),
      })),
      gates: [
        {
          id: "G-ci",
          ticket_id: TICKET,
          kind: "qa_harness",
          state: "running",
          subject_kind: CI_SUBJECT,
          subject_ref: "unpinned",
          started_at: T0,
        },
      ],
      deliveries:
        delivered === "none"
          ? []
          : repos.map((r, i) => ({
              id: `D-${r.id}`,
              ticket_id: TICKET,
              repo_id: r.id,
              branch: BRANCH,
              head_sha: delivered === "head" ? r.head : "b".repeat(40),
              remote_host: "forge.test",
              remote_url: `https://forge.test/an-owner/${r.id}.git`,
              state: "pr_open" as const,
              pr_url:
                i === 0 ? PR_URL : `https://forge.test/pull/${String(i + 1)}`,
              pr_number: i + 1,
              started_at: T0,
            })),
    }),
  );
  return { w, clock, repo, repos };
}

const rowsOf = async (w: World) => unwrap(await dumpAllRows(w.db));

async function gateOf(w: World) {
  const rows = (await rowsOf(w)).gates as {
    id: string;
    state: string;
    evidence_json: string | null;
  }[];
  const gate = rows.find((g) => g.id === "G-ci");
  const evidence =
    gate?.evidence_json === null || gate === undefined
      ? null
      : StoredGateEvidence.parse(JSON.parse(gate.evidence_json));
  return { state: gate?.state, evidence };
}

const statusOf = async (w: World): Promise<unknown> =>
  ((await rowsOf(w)).tickets as { status: string }[])[0]?.status;

const qaRunsOf = async (w: World) =>
  (
    (await rowsOf(w)).qa_runs as {
      state: string;
      source: string;
      command: string | null;
      exit_code: number | null;
    }[]
  ).map((r) => ({
    state: r.state,
    source: r.source,
    command: r.command,
    exit_code: r.exit_code,
  }));

describe("a decision", () => {
  test("every check green: the gate passes with CI evidence, and the ticket reaches qa_human", async () => {
    const { w, repo } = await ciWorld();
    fixture.checkRuns.set(repo.head, [
      checkRun("build", "completed", "success"),
      checkRun("docs", "completed", "skipped"),
    ]);
    fixture.statuses.set(repo.head, [commitStatus("legacy", "success")]);
    expect(await sweepCiGates(w.ctx)).toEqual({
      looked: 1,
      decided: 1,
      failed: 0,
      budgetSpent: false,
    });
    const { state, evidence } = await gateOf(w);
    expect(state).toBe("passed");
    const ci = CiGateEvidence.parse(evidence);
    expect(ci).toMatchObject({
      command: "ci checks (every check reported)",
      exit_code: 0,
      cost_usd: 0,
      ci: {
        repos: [{ repo_id: "r1", sha: repo.head, pr_url: PR_URL, total: 3 }],
      },
    });
    // The artifact is the whole list, where the evidence says it is.
    const [artifact = ""] = ci.artifact_paths;
    expect(artifact.endsWith(CI_CHECKS_ARTIFACT)).toBe(true);
    expect(existsSync(artifact)).toBe(true);
    const onDisk = JSON.parse(readFileSync(artifact, "utf8")) as {
      repos: { repo_id: string; checks: unknown[] }[];
    };
    expect(onDisk.repos.map((r) => [r.repo_id, r.checks.length])).toEqual([
      ["r1", 3],
    ]);
    expect(await qaRunsOf(w)).toEqual([
      {
        state: "passed",
        source: "ci",
        command: "ci checks (every check reported)",
        exit_code: 0,
      },
    ]);
    expect(await statusOf(w)).toBe("qa_human");
    // Decided: not a candidate again, so a second pass asks the forge nothing.
    const asked = fixture.requests.length;
    await sweepCiGates(w.ctx);
    expect(fixture.requests).toHaveLength(asked);
  });

  test("a failed check is a blocking finding, and fail_harness takes the ticket to rework", async () => {
    const { w, repo } = await ciWorld();
    fixture.checkRuns.set(repo.head, [
      checkRun("build", "completed", "success"),
      checkRun("test", "completed", "timed_out"),
      checkRun("e2e", "in_progress", null),
    ]);
    await sweepCiGates(w.ctx);
    const { state, evidence } = await gateOf(w);
    expect(state).toBe("failed");
    expect(evidence).toMatchObject({
      reason: "blocking_findings",
      exit_code: 1,
    });
    const findings = (await rowsOf(w)).findings as {
      summary: string;
      severity: string;
      detail_md: string;
    }[];
    expect(findings.map((f) => [f.severity, f.summary])).toEqual([
      ["blocker", "CI check failed in r1: test"],
    ]);
    expect(findings[0]?.detail_md).toContain("https://forge.test/runs/test");
    expect(await qaRunsOf(w)).toMatchObject([
      { state: "failed", source: "ci" },
    ]);
    expect(await statusOf(w)).toBe("rework");
  });

  test("a failing check the project does not require changes nothing: it passes", async () => {
    const { w, repo } = await ciWorld({ required: ["build"] });
    fixture.checkRuns.set(repo.head, [
      checkRun("build", "completed", "success"),
      checkRun("flaky", "completed", "failure"),
    ]);
    await sweepCiGates(w.ctx);
    expect((await gateOf(w)).state).toBe("passed");
    expect((await gateOf(w)).evidence).toMatchObject({
      command: "ci checks build",
    });
    expect(await statusOf(w)).toBe("qa_human");
  });
});

describe("waiting", () => {
  test("checks still running decide nothing; the progress is recorded once, for the next step", async () => {
    const { w, repo } = await ciWorld({ required: ["build", "test", "e2e"] });
    fixture.checkRuns.set(repo.head, [
      checkRun("build", "completed", "success"),
      checkRun("test", "queued", null),
    ]);
    expect(await sweepCiGates(w.ctx)).toMatchObject({ decided: 0, failed: 0 });
    expect((await gateOf(w)).state).toBe("running");
    expect(await qaRunsOf(w)).toEqual([]);
    expect((await rowsOf(w)).deliveries).toMatchObject([
      { ci_gate_id: "G-ci", ci_sha: repo.head, ci_done: 1, ci_total: 3 },
    ]);
    expect(unwrap(await getNextStepFacts(w.db, TICKET)).ci).toEqual({
      pulls: 1,
      done: 1,
      total: 3,
    });
    expect(await statusOf(w)).toBe("qa_harness");
  });

  test("no pull request yet: nothing is asked of the forge, then the deadline decides timeout", async () => {
    const { w, clock } = await ciWorld({ delivered: "none" });
    await sweepCiGates(w.ctx);
    expect((await gateOf(w)).state).toBe("running");
    expect(fixture.requests).toEqual([]);
    expect(unwrap(await getNextStepFacts(w.db, TICKET)).ci).toEqual({
      pulls: 0,
      done: 0,
      total: 0,
    });

    await clock.advance(60 * MIN);
    await sweepCiGates(w.ctx);
    const { state, evidence } = await gateOf(w);
    expect(state).toBe("failed");
    expect(evidence).toMatchObject({
      reason: "timeout",
      detail: "no pull request at the reviewed commit within 60 min",
    });
    // Infra: the ticket waits for the owner, never a fix round.
    expect(await statusOf(w)).toBe("qa_harness");
    expect(await qaRunsOf(w)).toEqual([
      { state: "error", source: "ci", command: null, exit_code: null },
    ]);
  });

  test("a delivery at an older commit is not judged: its red checks never fail the new round", async () => {
    const { w, repo } = await ciWorld({ delivered: "stale" });
    fixture.checkRuns.set("b".repeat(40), [
      checkRun("test", "completed", "failure"),
    ]);
    await sweepCiGates(w.ctx);
    expect((await gateOf(w)).state).toBe("running");
    expect(fixture.requests).toEqual([]);
    // Pushed at last: the new head is read, and it is green.
    unwrap(
      await updateRowForTest(w.db, "deliveries", "D-r1", {
        head_sha: repo.head,
      }),
    );
    fixture.checkRuns.set(repo.head, [
      checkRun("test", "completed", "success"),
    ]);
    await sweepCiGates(w.ctx);
    expect((await gateOf(w)).state).toBe("passed");
  });

  test("a forge that cannot answer this pass decides nothing; the next pass asks again", async () => {
    const { w, repo } = await ciWorld();
    fixture.overrides.push({ status: 502, body: "{}" });
    await sweepCiGates(w.ctx);
    expect((await gateOf(w)).state).toBe("running");
    fixture.checkRuns.set(repo.head, [
      checkRun("build", "completed", "success"),
    ]);
    await sweepCiGates(w.ctx);
    expect((await gateOf(w)).state).toBe("passed");
  });
});

describe("infra", () => {
  test("nothing reported at all waits through the grace, then is reviewer_error", async () => {
    const { w, clock } = await ciWorld();
    await sweepCiGates(w.ctx);
    expect((await gateOf(w)).state).toBe("running");
    await clock.advance(10 * MIN);
    await sweepCiGates(w.ctx);
    expect((await gateOf(w)).evidence).toMatchObject({
      reason: "reviewer_error",
    });
    expect(await statusOf(w)).toBe("qa_harness");
  });

  test("a required check that never finishes times out at the project's wait, naming it", async () => {
    const { w, clock, repo } = await ciWorld({ required: ["build"] });
    unwrap(
      await updateRowForTest(w.db, "workspaces", PROJECT, {
        qa_ci_timeout_ms: 20 * MIN,
      }),
    );
    fixture.checkRuns.set(repo.head, [checkRun("build", "in_progress", null)]);
    await clock.advance(20 * MIN);
    await sweepCiGates(w.ctx);
    expect((await gateOf(w)).evidence).toMatchObject({
      reason: "timeout",
      detail: "CI did not finish within 20 min: still waiting for build",
    });
  });

  test("no forge token: reviewer_error naming the secret, never a value", async () => {
    const { w } = await ciWorld({ token: false });
    await sweepCiGates(w.ctx);
    const { evidence } = await gateOf(w);
    expect(evidence).toMatchObject({ reason: "reviewer_error" });
    expect(JSON.stringify(evidence)).toContain(forgeTokenSecret("github"));
    expect(fixture.requests).toEqual([]);
  });

  test("a forge that refuses: reviewer_error, the token nowhere in what is kept", async () => {
    const { w } = await ciWorld();
    fixture.overrides.push({
      status: 401,
      body: `{"message":"bad credentials ${TOKEN}"}`,
    });
    await sweepCiGates(w.ctx);
    const { evidence } = await gateOf(w);
    expect(evidence).toMatchObject({ reason: "reviewer_error" });
    expect(JSON.stringify(await rowsOf(w))).not.toContain(TOKEN);
  });
});

test("a remote that is no forge Bayon can read: reviewer_error naming its host", async () => {
  const { w } = await ciWorld();
  const ctx = { ...w.ctx, forgeRemoteOf: () => null };
  await sweepCiGates(ctx);
  const { evidence } = await gateOf(w);
  expect(evidence).toMatchObject({
    reason: "reviewer_error",
    detail: "forge.test is not a forge Bayon can read CI checks on",
  });
});

test("out of budget, a pass looks at nothing and says so; the next carries on", async () => {
  const { w, repo } = await ciWorld();
  fixture.checkRuns.set(repo.head, [checkRun("build", "completed", "success")]);
  expect(await sweepCiGates(w.ctx, { budgetMs: 0 })).toEqual({
    looked: 0,
    decided: 0,
    failed: 0,
    budgetSpent: true,
  });
  expect(await sweepCiGates(w.ctx)).toMatchObject({ looked: 1, decided: 1 });
});

test("a gate running a command is not the CI sweep's: it is never listed or read", async () => {
  const { w } = await ciWorld();
  unwrap(
    await seedRows(w.db, {
      gates: [
        {
          id: "G-cmd",
          ticket_id: TICKET,
          kind: "qa_harness",
          state: "running",
          subject_kind: "workspace",
          subject_ref: "unpinned",
          started_at: T0 - 1,
          attempt: 2,
        },
      ],
    }),
  );
  expect(await sweepCiGates(w.ctx)).toMatchObject({ looked: 1 });
});

// Review CRITICAL 1: each repo is judged on its own checks, and the gate passes only when every
// repo does.
describe("two repos", () => {
  test("B reported nothing: the gate waits, then is reviewer_error naming B — never a pass", async () => {
    const { w, clock, repos } = await ciWorld({ repos: ["r1", "r2"] });
    const [a, b] = repos;
    if (a === undefined || b === undefined) throw new Error("two repos");
    fixture.checkRuns.set(a.head, [checkRun("build", "completed", "success")]);
    await sweepCiGates(w.ctx);
    expect((await gateOf(w)).state).toBe("running");
    await clock.advance(10 * MIN);
    await sweepCiGates(w.ctx);
    const { state, evidence } = await gateOf(w);
    expect(state).toBe("failed");
    expect(evidence).toMatchObject({
      reason: "reviewer_error",
      detail: `r2 reported no CI checks for ${b.head.slice(0, 12)} within 10 min: is CI set up for it?`,
    });
    expect(await statusOf(w)).toBe("qa_harness");
  });

  test("the same check green in one repo and red in the other fails the gate, naming the repo", async () => {
    const { w, repos } = await ciWorld({
      repos: ["r1", "r2"],
      required: ["build"],
    });
    const [a, b] = repos;
    if (a === undefined || b === undefined) throw new Error("two repos");
    fixture.checkRuns.set(a.head, [checkRun("build", "completed", "success")]);
    fixture.checkRuns.set(b.head, [checkRun("build", "completed", "failure")]);
    await sweepCiGates(w.ctx);
    expect((await gateOf(w)).evidence).toMatchObject({
      reason: "blocking_findings",
    });
    const findings = (await rowsOf(w)).findings as { summary: string }[];
    expect(findings.map((f) => f.summary)).toEqual([
      "CI check failed in r2: build",
    ]);
    expect(await statusOf(w)).toBe("rework");
    // The artifact and the evidence keep each repo's checks in its own group.
    const ci = CiGateEvidence.parse((await gateOf(w)).evidence);
    expect(
      ci.ci.repos.map((r) => [r.repo_id, r.checks.map((c) => c.state)]),
    ).toEqual([
      ["r1", ["success"]],
      ["r2", ["failure"]],
    ]);
  });

  test("green in both, each on its own checks: the gate passes, and progress counted across them", async () => {
    const { w, repos } = await ciWorld({
      repos: ["r1", "r2"],
      required: ["build", "r2:e2e"],
    });
    const [a, b] = repos;
    if (a === undefined || b === undefined) throw new Error("two repos");
    fixture.checkRuns.set(a.head, [checkRun("build", "completed", "success")]);
    fixture.checkRuns.set(b.head, [
      checkRun("build", "completed", "success"),
      checkRun("e2e", "queued", null),
    ]);
    await sweepCiGates(w.ctx);
    expect(unwrap(await getNextStepFacts(w.db, TICKET)).ci).toEqual({
      pulls: 2,
      done: 2,
      total: 3,
    });
    fixture.checkRuns.set(b.head, [
      checkRun("build", "completed", "success"),
      checkRun("e2e", "completed", "success"),
    ]);
    await sweepCiGates(w.ctx);
    expect((await gateOf(w)).state).toBe("passed");
  });
});

// Review MEDIUM 2: a CI gate is judged whatever its ticket's status, as the gate poll judges every
// running gate; the machine step waits for the ticket to be back in qa_harness.
describe("a ticket blocked mid-gate", () => {
  const move = async (w: World, version: number, to: string) =>
    unwrap(
      await transitionTicket(
        w.db,
        { id: TICKET, version, to, by: OPERATOR, patch: {} },
        () => ok(undefined),
      ),
    );

  test("checks go green while it is blocked: the gate passes; unblocked, the machine sweep takes pass_harness", async () => {
    const { w, repo } = await ciWorld();
    await move(w, 1, "blocked");
    fixture.checkRuns.set(repo.head, [
      checkRun("build", "completed", "success"),
    ]);
    await sweepCiGates(w.ctx);
    expect((await gateOf(w)).state).toBe("passed");
    expect(await statusOf(w)).toBe("blocked");
    await move(w, 2, "qa_harness");
    await sweepMachineSteps(w.ctx);
    expect(await statusOf(w)).toBe("qa_human");
  });

  test("its deadline still comes while it is blocked: timeout, and the ticket stays blocked", async () => {
    const { w, clock } = await ciWorld({ delivered: "none" });
    await move(w, 1, "blocked");
    await clock.advance(60 * MIN);
    await sweepCiGates(w.ctx);
    expect((await gateOf(w)).evidence).toMatchObject({ reason: "timeout" });
    expect(await statusOf(w)).toBe("blocked");
  });
});

// Review MEDIUM 3: a rerun on the same commit is a second run under the same name; only the latest
// of each counts, for the verdict and for "n of m".
describe("a check re-run on the same commit", () => {
  const at = (min: number) =>
    `2026-09-01T10:${String(min).padStart(2, "0")}:00Z`;

  test("a failure re-run green passes the gate", async () => {
    const { w, repo } = await ciWorld();
    fixture.checkRuns.set(repo.head, [
      checkRun("build", "completed", "failure", null, {
        id: 1,
        started_at: at(0),
      }),
      checkRun("build", "completed", "success", null, {
        id: 2,
        started_at: at(8),
      }),
    ]);
    await sweepCiGates(w.ctx);
    expect((await gateOf(w)).state).toBe("passed");
    expect(await statusOf(w)).toBe("qa_human");
  });

  test("a rerun still running waits, and counts once toward n of m", async () => {
    const { w, repo } = await ciWorld();
    fixture.checkRuns.set(repo.head, [
      checkRun("build", "completed", "failure", null, {
        id: 1,
        started_at: at(0),
      }),
      checkRun("build", "in_progress", null, null, {
        id: 2,
        started_at: at(8),
      }),
      checkRun("lint", "completed", "success", null, {
        id: 3,
        started_at: at(1),
      }),
    ]);
    await sweepCiGates(w.ctx);
    expect((await gateOf(w)).state).toBe("running");
    expect(unwrap(await getNextStepFacts(w.db, TICKET)).ci).toEqual({
      pulls: 1,
      done: 1,
      total: 2,
    });
  });
});
