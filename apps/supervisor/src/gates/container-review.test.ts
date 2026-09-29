// A gate's reviewer placed on a container executor (over): the real
// ContainerExecutor over the loopback with a stand-in docker, and the schema stand-in runner (found
// by its caps: Invariant 1). The reviewer gets a clone detached at the pinned head, kept alive in
// the executor's mirror as refs/frm/gate/<id>; its output file lives under the container's root and
// is read back after the process exits, as a local reviewer's is; then the reaper removes the
// container and the root. The builder stays on local, where M3 pins its subject.
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
  listSessionWorktrees,
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

const T0 = Date.UTC(2026, 8, 14, 12);
const WAIT = { timeout: 30_000, interval: 10 };
const CTR = "ctr-loop";
const TURN = { kind: "turn_start", runner_type: "fixture.step", payload: {} };
const say = (text: string) => ({
  kind: "assistant_text",
  runner_type: "fixture.text",
  text,
  payload: {},
});
/** The stand-in's clean review (its prompt carries the ticket). */
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

test("code_review on a container: a detached clone at the pinned head, the output read back, then reaped", async () => {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const home = tempHome("frm-gctr-");
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
    script: { runs: [{ events: [TURN, say("built\nFINDINGS: 0")] }] },
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
          slots: 2,
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
          // No MCP tools: a gate's reviewer answers in its output file (no_tools).
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
      // Certified on the container; the binding places code review there.
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
      role_bindings: [
        {
          role: "code_reviewer",
          runner_id: schemaId,
          executor_id: CTR,
          updated_at: 0,
        },
      ],
    }),
  );
  const remote = join(home.path, "remote");
  mkdirSync(remote);
  const docker = installFakeDocker(join(home.path, "fake"), CTR);
  const ctrSlots = new SlotCounter(2);
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
  // The loopback's "image" is this host: its program, not the image's.
  const fixture = createFixtureAdapter({ clock, command: FIXTURE_COMMAND });
  // The builder's pair, certified through certify() as the rigs do (require_certified=1).
  await certifyPair(t.db, {
    runnerId: fixture.id,
    runnerVersion: fixture.registration().runner.versionDetected ?? "rig",
    caps: fixture.caps(),
    executorId: EXECUTOR_ID,
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

  // The builder, on local: a worktree through the lifecycle, one commit on its branch.
  unwrap(
    await lifecycle.handlers.spawn.handle(
      spawnPayload("B1", { workspace_id: "ws", ticket_id: "ticket-1" }),
      CMD,
    ),
  );
  await vi.waitFor(async () => {
    await lifecycle.settled();
    expect(unwrap(await getSession(t.db, "B1")).state).toBe("idle");
  }, WAIT);
  const wt = join(home.path, "work", "B1", "repo");
  mkdirSync(join(wt, "src"), { recursive: true });
  writeFileSync(join(wt, "src", "a.js"), "export const a = 1;\n");
  git(wt, "add", ".");
  git(wt, "commit", "-q", "-m", "work");
  const head = git(wt, "rev-parse", "HEAD");
  await engine.start();

  unwrap(
    await seedRows(t.db, {
      gates: [
        {
          id: "g-ctr",
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
      { gate_id: "g-ctr", session_id: newId(clock.now()) },
      CMD,
    ),
  );
  const g: GateRow = await vi.waitFor(async () => {
    const row = unwrap(await getGate(t.db, "g-ctr"));
    expect(row.state).not.toBe("running");
    return row;
  }, WAIT);
  expect(g.state, g.evidence_json ?? "no evidence").toBe("passed");
  const e = GateEvidence.parse(JSON.parse(g.evidence_json ?? "null"));
  expect(e).toMatchObject({
    exit_code: 0,
    runner_id: schemaId,
    executor_id: CTR,
    subject: { head_sha: head, files: 1 },
    findings: { total: 0, parse: "schema" },
  });
  // The output was read back (through the container) into the gate's artifacts.
  expect(e.artifact_paths.some((p) => p.endsWith("output.json"))).toBe(true);
  for (const path of e.artifact_paths) expect(existsSync(path)).toBe(true);

  const [gs] = unwrap(await listGateSessions(t.db, ["g-ctr"]));
  const sid = gs?.session_id ?? "";
  const reviewer = unwrap(await getSession(t.db, sid));
  expect(reviewer).toMatchObject({
    executor_id: CTR,
    session_root: join(remote, "work", sid),
  });
  expect(reviewer.executor_ref).toMatch(/^ctr:ctr-loop:/);
  // The pinned head was pushed into the executor's mirror (as refs/frm/gate/g-ctr, which the
  // session's end may already have dropped: its objects stay until gc); no branch was made there.
  const remoteMirror = join(remote, "mirror", "repo.git");
  expect(git(remoteMirror, "cat-file", "-t", head)).toBe("commit");
  expect(
    git(remoteMirror, "for-each-ref", "--format=%(refname)", "refs/heads/frm/"),
  ).toBe("");
  // After the read-back, its end released the container and the root, by label.
  await vi.waitFor(async () => {
    await lifecycle.settled();
    expect((await ctr.listOwned()).map((o) => o.sessionId)).not.toContain(sid);
    expect(existsSync(join(remote, "work", sid))).toBe(false);
    const [w] = unwrap(await listSessionWorktrees(t.db, sid));
    expect(w).toMatchObject({
      path: join(remote, "work", sid, "repo"),
      branch: `detached@${head.slice(0, 12)}`,
      state: "removed",
    });
    // Done when: the gate is decided and its reviewer ended, so its pinned ref is gone
    // from the executor's mirror, dropped at the session's end (the reconciler's sweep does not run
    // in this test); the base stays.
    expect(
      git(remoteMirror, "for-each-ref", "--format=%(refname)", "refs/frm/"),
    ).toBe("");
  }, WAIT);
  expect(git(remoteMirror, "rev-parse", "refs/heads/main")).toMatch(
    /^[0-9a-f]{40}$/,
  );
}, 60_000);
