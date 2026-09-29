// A gate whose *subject* was built on a container, through the loopback: the builder's
// worktree is a clone in its own container and its commit exists nowhere else, so the pin reads the
// head there, fetches it back into the supervisor's mirror under the gate's pin ref, and describes
// the change from that mirror exactly as it does for a local builder. The reviewer then goes where
// the subject was built — the binding names no executor here, and `local` is the one place this
// gate must not default to.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  FakeClock,
  GateEvidence,
  judgeExecutorHealth,
  newId,
  type HealthLimits,
} from "@bayon/core";
import {
  getGate,
  getSession,
  listGateSessions,
  listSessionsInStates,
  type GateRow,
} from "@bayon/db";
import { seedRows, tempDb, ticketRow, unwrap } from "@bayon/db/testing";
import {
  ContainerExecutor,
  LocalExecutor,
  SlotCounter,
  type Executor,
  type ExecutorHealthReport,
} from "@bayon/executors";
import { installFakeDocker, LoopbackTransport } from "@bayon/executors/testing";
import type { RunnerAdapter } from "@bayon/runners";
import { FIXTURE_COMMAND, createFixtureAdapter } from "@bayon/runners/fixture";
import { loadStubAdapter, STUB_RUNNER_IDS } from "@bayon/runners/testing";
import { pino } from "pino";
import { afterAll, expect, test, vi } from "vitest";
import { z } from "zod";
import { upsertBootRows } from "../boot.js";
import { createIngest } from "../ingest/ingest.js";
import { createLifecycle } from "../lifecycle/index.js";
import { envSecrets } from "../lifecycle/secrets.js";
import { certifyPair } from "../lifecycle/testing/certify.js";
import {
  CMD,
  EXECUTOR_ID,
  lifecycleRows,
  spawnPayload,
  tempHome,
} from "../lifecycle/testing/fixtures.js";
import { createGateEngine } from "./engine.js";

const T0 = Date.UTC(2026, 8, 18, 12);
const WAIT = { timeout: 30_000, interval: 10 };
const CTR = "ctr-loop";
const TURN = { kind: "turn_start", runner_type: "fixture.step", payload: {} };
const CLEAN = "frm-stub: clean review";

/** Health is and needs a real docker; this one is always healthy. */
class LoopbackContainer extends ContainerExecutor {
  override health(limits: HealthLimits): Promise<ExecutorHealthReport> {
    return Promise.resolve(
      judgeExecutorHealth({ checkedAt: T0, disk: [], clockSkewMs: 0, limits }),
    );
  }
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

/** The stand-in runner that declares outputSchema (found by its caps: Invariant 1). */
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

test("code_review of a container builder: the head fetched back, then a reviewer on the same executor", async () => {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const home = tempHome("frm-gsub-");
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
  const schema = schemaAdapter();
  const reg = schema.registration();
  const schemaId = reg.runner.id;
  const rows = lifecycleRows({
    script: { runs: [{ events: [TURN] }] },
    settings: {
      "reconciler.interval_ms": 86_400_000,
      "executor.health_timeout_ms": 86_400_000,
    },
  });
  unwrap(
    await seedRows(t.db, {
      ...rows,
      executors: [
        ...rows.executors,
        {
          id: CTR,
          kind: "container",
          config_json: "{}",
          slots: 4,
          trust: "untrusted",
          egress_policy: "allowlist",
        },
      ],
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
          status: "code_review",
          workspace_id: "ws",
          non_trivial: 1,
          plan_path: "docs/plan.md",
          body_md: CLEAN,
        }),
      ],
    }),
  );
  unwrap(await upsertBootRows(t.db, { registrations: [reg] }));
  unwrap(
    await seedRows(t.db, {
      profiles: [
        {
          id: "p-schema",
          name: "p-schema",
          runner_id: schemaId,
          model_tier: reg.models[0]?.tier ?? "standard",
          sandbox_json: JSON.stringify({ sandbox: "read-only" }),
          tool_allowlist_json: "[]",
          version: 1,
          hash: "0".repeat(64),
          created_at: 0,
        },
      ],
      agents: [
        {
          id: "rev-schema",
          name: "rev-schema",
          kind: "reviewer" as const,
          runner_id: schemaId,
          executor_id: CTR,
          profile_id: "p-schema",
          created_at: 0,
        },
      ],
      runner_certifications: [
        {
          runner_id: schemaId,
          executor_id: CTR,
          // The profile's tier's model (above): certification is per model.
          model_id: reg.models[0]?.id ?? `${schemaId}.standard`,
          model: "m",
          runner_version: reg.runner.versionDetected,
          suite_version: "test",
          kit_hash: "k",
          caps_hash: "c",
          result_json: "{}",
          gate_eligible: 1,
          passed_at: T0,
          certified_at: T0,
        },
      ],
      // The binding names the runner and no executor: the gate must place it where the subject
      // was built, and never fall back to local.
      role_bindings: [
        { role: "code_reviewer", runner_id: schemaId, updated_at: 0 },
      ],
    }),
  );
  const remote = join(home.path, "remote");
  mkdirSync(remote);
  const docker = installFakeDocker(join(home.path, "fake"), CTR);
  const ctrSlots = new SlotCounter(4);
  const ctr = new LoopbackContainer({
    id: CTR,
    slots: ctrSlots,
    frmHome: home.path,
    config: {
      ssh: { host: "loopback", user: "frm", identity_ref: "file:/dev/null" },
      remote_root: remote,
      image: "frm/test",
      min_free_pct: 0,
      heartbeat_ms: 200,
      kill_grace_ms: 1_000,
      env_path: `${dirname(process.execPath)}:/usr/bin:/bin`,
    },
    transport: new LoopbackTransport({ ...docker.env, HOME: home.path }),
    paths: {
      sessions: join(remote, "work"),
      run: join(remote, "run"),
      shim: "/opt/frm/exec-shim.mjs",
    },
  });
  const slots = new SlotCounter(4);
  const local = new LocalExecutor({ id: EXECUTOR_ID, slots });
  const fixture = createFixtureAdapter({ clock, command: FIXTURE_COMMAND });
  // The builder's pair, certified on the container it runs on (require_certified=1).
  await certifyPair(t.db, {
    runnerId: fixture.id,
    runnerVersion: fixture.registration().runner.versionDetected ?? "rig",
    caps: fixture.caps(),
    executorId: CTR,
    at: T0,
  });
  const adapters = new Map<string, RunnerAdapter>([
    [fixture.id, fixture],
    [schema.id, schema],
  ]);
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
  const lifecycle = createLifecycle({
    db: t.db,
    clock,
    log: quiet,
    frmHome: home.path,
    executors: new Map([
      [EXECUTOR_ID, { executor: local, slots }],
      [CTR, { executor: ctr, slots: ctrSlots }],
    ]),
    adapters,
    ingest,
    secrets: envSecrets(secretsFor(schema)),
    mcpReachable: async () => true,
  });
  unwrap(await lifecycle.boot());
  const engine = createGateEngine({
    db: t.db,
    clock,
    log: quiet,
    frmHome: home.path,
    lifecycle,
    adapters,
    executors: new Map<string, Executor>([
      [EXECUTOR_ID, local],
      [CTR, ctr],
    ]),
    path: process.env["PATH"] ?? "",
  });
  cleanups.unshift(async () => {
    const live = await listSessionsInStates(t.db, ["idle", "running"]);
    for (const s of live.ok ? live.value : []) {
      if (s.executor_ref === null) continue;
      const owner = s.executor_id === CTR ? ctr : local;
      await owner.cleanup(s.executor_ref, "hard").catch(() => undefined);
    }
    await engine.stop();
    await lifecycle.shutdown();
    await ingest.shutdown();
    await ctr.close();
  });

  // The builder, on the container: its workspace is a clone of the executor's own mirror.
  unwrap(
    await lifecycle.handlers.spawn.handle(
      spawnPayload("B1", {
        workspace_id: "ws",
        ticket_id: "ticket-1",
        executor_id: CTR,
      }),
      CMD,
    ),
  );
  await vi.waitFor(async () => {
    await lifecycle.settled();
    expect(unwrap(await getSession(t.db, "B1")).state).toBe("idle");
  }, WAIT);
  const wt = join(remote, "work", "B1", "repo");
  mkdirSync(join(wt, "src"), { recursive: true });
  writeFileSync(join(wt, "src", "a.js"), "export const a = 1;\n");
  git(wt, "add", ".");
  git(wt, "commit", "-q", "-m", "work");
  const head = git(wt, "rev-parse", "HEAD");
  // The commit is the container's alone: the supervisor's mirror has never seen it.
  expect(() => git(mirror, "cat-file", "-t", head)).toThrow();
  await engine.start();

  unwrap(
    await seedRows(t.db, {
      gates: [
        {
          id: "g-sub",
          ticket_id: "ticket-1",
          kind: "code_review",
          state: "running",
          attempt: 1,
          subject_kind: "diff",
          subject_ref: "unpinned",
          started_at: clock.now(),
        },
      ],
    }),
  );
  unwrap(
    await engine.handler.handle(
      { gate_id: "g-sub", session_id: newId(clock.now()) },
      CMD,
    ),
  );
  const g: GateRow = await vi.waitFor(async () => {
    const row = unwrap(await getGate(t.db, "g-sub"));
    expect(row.state).not.toBe("running");
    return row;
  }, WAIT);
  expect(g.state, g.evidence_json ?? "no evidence").toBe("passed");
  const e = GateEvidence.parse(JSON.parse(g.evidence_json ?? "null"));
  // The same evidence a local subject's gate leaves: the pinned range, and one file in it.
  expect(e).toMatchObject({
    exit_code: 0,
    runner_id: schemaId,
    executor_id: CTR,
    subject: { head_sha: head, files: 1 },
    findings: { total: 0, parse: "schema" },
  });
  for (const path of e.artifact_paths) expect(existsSync(path)).toBe(true);
  expect(e.artifact_paths.find((p) => p.endsWith("diff.patch"))).toBeDefined();

  // The head was fetched back out of the container, under the gate's own pin ref, and the diff
  // was taken in the supervisor's mirror.
  expect(git(mirror, "cat-file", "-t", head)).toBe("commit");
  expect(git(mirror, "rev-parse", "refs/frm/gate/g-sub")).toBe(head);
  expect(
    git(mirror, "diff", "--name-only", `${e.subject.base_sha}..${head}`),
  ).toBe("src/a.js");

  // The reviewer went to the builder's executor, with no binding naming one.
  const [gs] = unwrap(await listGateSessions(t.db, ["g-sub"]));
  const reviewer = unwrap(await getSession(t.db, gs?.session_id ?? ""));
  expect(reviewer).toMatchObject({
    executor_id: CTR,
    session_root: join(remote, "work", gs?.session_id ?? ""),
  });
  // Its clone came off the executor's mirror at the pinned head, pushed there from ours.
  expect(git(join(remote, "mirror", "repo.git"), "cat-file", "-t", head)).toBe(
    "commit",
  );
}, 120_000);
