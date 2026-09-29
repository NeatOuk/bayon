import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import {
  runnerConformance,
  type ConformanceCliOptions,
} from "./runner-conformance.js";
import type { Fetch } from "./smoke/api-client.js";

// Every run names a temp FRM_HOME: frm's API URL and bearer come from the home, never ~/.foreman.
const HOME = mkdtempSync(join(tmpdir(), "frm-conformance-"));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

const OPTIONS: ConformanceCliOptions = {
  runnerId: "fixture",
  executorId: "local",
  modelId: "fixture.cheap",
  compression: false,
  outDir: "/repo/docs/conformance",
  timeoutMs: 5_000,
};
const SUMMARY = {
  passed: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 14],
  failed: [],
  na: [12, 13],
  incomplete: [],
  unverified_caps: [],
  certifiable: true,
  gate_eligible: true,
  unattended_allowed: true,
};
const RESULT = {
  runner_id: "fixture",
  executor_id: "local",
  model_id: "fixture.cheap",
  model: "fixture-model",
  runner_version: "1",
  report_path: "/repo/docs/conformance/fixture-1@local.md",
  stored: true,
  passed_at: 1_800_000_000_000,
  summary: SUMMARY,
};

const command = (state: string, extra: object = {}) => ({
  id: "C1",
  ts: 1,
  type: "runner.conformance",
  payload: {},
  state,
  idempotency_key: null,
  claimed_at: null,
  attempts: 1,
  result: null,
  error: null,
  now: 2,
  ahead: [],
  ...extra,
});

/** A fake API: the POST, then each GET answers the next of `states`. */
function api(
  states: readonly object[],
  post: { status: number; body: object } = {
    status: 202,
    body: { command_id: "C1", created: true },
  },
) {
  const calls: { url: string; init: RequestInit }[] = [];
  let next = 0;
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init });
    if (init.method === "POST")
      return Response.json(post.body, { status: post.status });
    const body = states[Math.min(next, states.length - 1)];
    next += 1;
    return Response.json(body);
  };
  return { fetch, calls };
}

function run(
  fetch: Fetch,
  env: Record<string, string> = {
    FRM_API_TOKEN: "t0ken",
    FRM_API_URL: "http://api.test/",
  },
) {
  const lines: string[] = [];
  return runnerConformance(OPTIONS, {
    env: { FRM_HOME: HOME, ...env },
    clock: systemClock,
    out: (l) => lines.push(l),
    fetch,
    pollMs: 1,
  }).then((code) => ({ code, lines }));
}

test("no FRM_API_URL: the API is this home's own, at its install.json port", async () => {
  const home = mkdtempSync(join(tmpdir(), "frm-conformance-port-"));
  try {
    writeFileSync(
      join(home, "install.json"),
      JSON.stringify({
        version: 1,
        api: { host: "127.0.0.1", port: 3011 },
        web: { port: 5174 },
      }),
    );
    const fake = api([command("done", { result: RESULT })]);
    const { code } = await run(fake.fetch, {
      FRM_HOME: home,
      FRM_API_TOKEN: "t0ken",
    });
    expect(code).toBe(0);
    expect(fake.calls[0]?.url).toBe(
      "http://127.0.0.1:3011/api/v1/runners/fixture/conformance",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("posts the command, waits while it is claimed, then prints the report path and verdict", async () => {
  const fake = api([command("claimed"), command("done", { result: RESULT })]);
  const { code, lines } = await run(fake.fetch);
  expect(code).toBe(0);
  const [post] = fake.calls;
  expect(post?.url).toBe("http://api.test/api/v1/runners/fixture/conformance");
  expect(JSON.parse(String(post?.init.body))).toEqual({
    executor_id: "local",
    model_id: "fixture.cheap",
    report_dir: "/repo/docs/conformance",
  });
  expect(new Headers(post?.init.headers).get("authorization")).toBe(
    "Bearer t0ken",
  );
  expect(fake.calls.slice(1).map((c) => c.url)).toEqual([
    "http://api.test/api/v1/commands/C1",
    "http://api.test/api/v1/commands/C1",
  ]);
  expect(lines).toEqual([
    "frm runner conformance · fixture · fixture.cheap on local · command C1",
    "report   /repo/docs/conformance/fixture-1@local.md",
    "verdict  certifiable yes · gate_eligible yes · unattended yes",
    "tests    12 pass · 0 fail · 2 N/A · 0 incomplete",
    "stored   (fixture, local, fixture.cheap) is certified as of runner 1",
  ]);
});

test("--compression asks for a compression run and says what it stored", async () => {
  const fake = api([
    command("done", {
      result: {
        ...RESULT,
        compression: true,
        summary: { ...SUMMARY, passed: [...SUMMARY.passed, 17] },
      },
    }),
  ]);
  const lines: string[] = [];
  const code = await runnerConformance(
    { ...OPTIONS, compression: true },
    {
      env: {
        FRM_HOME: HOME,
        FRM_API_TOKEN: "t0ken",
        FRM_API_URL: "http://api.test/",
      },
      clock: systemClock,
      out: (l) => lines.push(l),
      fetch: fake.fetch,
      pollMs: 1,
    },
  );
  expect(code).toBe(0);
  expect(JSON.parse(String(fake.calls[0]?.init.body))).toEqual({
    executor_id: "local",
    model_id: "fixture.cheap",
    report_dir: "/repo/docs/conformance",
    compression: true,
  });
  expect(lines[0]).toBe(
    "frm runner conformance · fixture · fixture.cheap on local · context compression · command C1",
  );
  expect(lines.at(-1)).toBe(
    "stored   (fixture, local, fixture.cheap, compression) is certified as of runner 1",
  );
});

test("a run that stores nothing, or fails a test, exits 1", async () => {
  const incomplete = {
    ...RESULT,
    stored: false,
    summary: {
      ...SUMMARY,
      certifiable: false,
      gate_eligible: false,
      incomplete: [11],
      passed: SUMMARY.passed.filter((id) => id !== 11),
    },
  };
  const a = await run(api([command("done", { result: incomplete })]).fetch);
  expect(a.code).toBe(1);
  expect(a.lines.at(-2)).toBe(
    "tests    11 pass · 0 fail · 2 N/A · 1 incomplete (incomplete: 11)",
  );
  expect(a.lines.at(-1)).toMatch(/^stored {3}nothing/);
  const failing = {
    ...RESULT,
    summary: {
      ...SUMMARY,
      gate_eligible: false,
      failed: [9],
      passed: SUMMARY.passed.filter((id) => id !== 9),
    },
  };
  expect(
    (await run(api([command("done", { result: failing })]).fetch)).code,
  ).toBe(1);
});

test("a run that did not end cleanly prints what its end left undone, that it stored nothing, and exits 1", async () => {
  const leaky = {
    ...RESULT,
    stored: false,
    passed_at: null,
    teardown: [
      "1 process group(s) the suite started were still alive at its end and were killed",
    ],
  };
  const r = await run(api([command("done", { result: leaky })]).fetch);
  expect(r.code).toBe(1);
  expect(r.lines.slice(-2)).toEqual([
    "teardown 1 process group(s) the suite started were still alive at its end and were killed",
    "stored   nothing: the run did not end cleanly, so no certification was written or cleared",
  ]);
});

test("stored but not certified (passed_at null) says so with its failures, never 'certified', and exits 1", async () => {
  const failing = {
    ...RESULT,
    executor_id: "ctr-lab",
    passed_at: null,
    summary: {
      ...SUMMARY,
      passed: [1],
      failed: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
      na: [],
      gate_eligible: false,
      unattended_allowed: false,
    },
  };
  const a = await run(api([command("done", { result: failing })]).fetch);
  expect(a.code).toBe(1);
  expect(a.lines.at(-1)).toBe(
    "stored   (fixture, ctr-lab, fixture.cheap) as of runner 1: stored, not certified (13 failed)",
  );
  expect(a.lines.join("\n")).not.toMatch(/is certified/);
  // A result from before passed_at was reported reads as not certified, never as certified.
  const older = Object.fromEntries(
    Object.entries(RESULT).filter(([key]) => key !== "passed_at"),
  );
  const b = await run(api([command("done", { result: older })]).fetch);
  expect(b.code).toBe(1);
  expect(b.lines.at(-1)).toBe(
    "stored   (fixture, local, fixture.cheap) as of runner 1: stored, not certified (0 failed)",
  );
});

test("a failed command, a refused POST, no token and the deadline each fail loudly", async () => {
  const failed = await run(
    api([
      command("failed", {
        error: {
          class: "not_found",
          message: "no runner adapter x is loaded",
          retryable: false,
        },
      }),
    ]).fetch,
  );
  expect(failed).toMatchObject({
    code: 1,
    lines: expect.arrayContaining([
      "FAIL  not_found: no runner adapter x is loaded",
    ]),
  });
  const refused = await run(
    api([], {
      status: 404,
      body: {
        error: { class: "not_found", message: "runner nope", retryable: false },
      },
    }).fetch,
  );
  expect(refused.code).toBe(1);
  expect(refused.lines[0]).toBe(
    "FAIL  POST /runners/fixture/conformance: runner nope",
  );
  expect((await run(api([]).fetch, {})).code).toBe(2);
  const lines: string[] = [];
  const late = await runnerConformance(
    { ...OPTIONS, timeoutMs: 1 },
    {
      env: { FRM_HOME: HOME, FRM_API_TOKEN: "t" },
      clock: systemClock,
      out: (l) => lines.push(l),
      fetch: api([command("claimed")]).fetch,
      pollMs: 5,
    },
  );
  expect(late).toBe(2);
  expect(lines.at(-1)).toMatch(/may still be running$/);
});

/** The runner as GET /runners lists it: its active models and the roles bound to each. */
/** The columns GET /runners shows beside each model. */
const STORED = {
  source: "adapter",
  active: true,
  effort: null,
  price_in_per_mtok: 0,
  price_out_per_mtok: 0,
  price_cache_read_per_mtok: 0,
  price_cache_write_per_mtok: 0,
  context_tokens: null,
  settings: {},
};

const RUNNERS = {
  runners: [
    {
      id: "fixture",
      kind: "script",
      adapter: "fixture",
      version_detected: "1",
      enabled: true,
      caps: null,
      gate_eligible: false,
      conformance_passed_at: null,
      certifications: [],
      models: [
        {
          id: "fixture.complex",
          tier: "complex",
          model: "big",
          bound_roles: ["code_reviewer"],
          ...STORED,
        },
        {
          id: "fixture.standard",
          tier: "standard",
          model: "mid",
          bound_roles: [],
          ...STORED,
        },
        {
          id: "fixture.cheap",
          tier: "cheap",
          model: "small",
          bound_roles: ["builder"],
          ...STORED,
        },
      ],
      inactive_models: [],
      update: null,
    },
  ],
};

/** A fake API by route: GET /runners, then each POST's command done at once with its model. */
function routed(
  runners: object = RUNNERS,
  resultFor: (modelId: string) => object = (modelId) => ({
    ...RESULT,
    model_id: modelId,
  }),
) {
  const posts: unknown[] = [];
  const fetch: Fetch = async (url, init) => {
    if (url.endsWith("/runners")) return Response.json(runners);
    if (init.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return Response.json(
        { command_id: `C${posts.length}`, created: true },
        { status: 202 },
      );
    }
    const n = Number(url.split("/C").at(-1));
    const body = posts[n - 1] as { model_id: string };
    return Response.json(command("done", { result: resultFor(body.model_id) }));
  };
  return { fetch, posts };
}

/** `frm runner conformance fixture` with no --model against `runners`: its exit, POSTs and lines. */
async function noModel(
  runners: object = RUNNERS,
  runnerId = "fixture",
  resultFor?: (modelId: string) => object,
) {
  const fake = routed(runners, resultFor);
  const lines: string[] = [];
  const code = await runnerConformance(
    { runnerId, executorId: "local", compression: false, timeoutMs: 5_000 },
    {
      env: { FRM_HOME: HOME, FRM_API_TOKEN: "t" },
      clock: systemClock,
      out: (l) => lines.push(l),
      fetch: fake.fetch,
      pollMs: 1,
    },
  );
  return { code, posts: fake.posts, lines };
}

/** RUNNERS with each model's bound_roles as `uses` says (none when absent). */
const usedAs = (
  uses: Readonly<Record<string, readonly string[]>>,
  kind = "script",
) => ({
  runners: RUNNERS.runners.map((r) => ({
    ...r,
    kind,
    models: r.models.map((m) => ({ ...m, bound_roles: uses[m.id] ?? [] })),
  })),
});

test("no --model: every model in use is certified, one after another, each named with its uses", async () => {
  const { code, posts, lines } = await noModel();
  expect(code).toBe(0);
  expect(posts).toEqual([
    { executor_id: "local", model_id: "fixture.complex" },
    { executor_id: "local", model_id: "fixture.cheap" },
  ]);
  expect(lines[0]).toBe(
    "models   fixture.complex (used by code_reviewer) · fixture.cheap (used by builder)",
  );
  expect(lines.filter((l) => l.startsWith("stored"))).toEqual([
    "stored   (fixture, local, fixture.complex) is certified as of runner 1",
    "stored   (fixture, local, fixture.cheap) is certified as of runner 1",
  ]);
});

test("no --model, two models in use: the first fails, the second still runs and is certified, and the exit is 1", async () => {
  const { code, posts, lines } = await noModel(RUNNERS, "fixture", (modelId) =>
    modelId === "fixture.complex"
      ? {
          ...RESULT,
          model_id: modelId,
          passed_at: null,
          summary: { ...SUMMARY, failed: [9] },
        }
      : { ...RESULT, model_id: modelId },
  );
  expect(code).toBe(1);
  expect(posts).toEqual([
    { executor_id: "local", model_id: "fixture.complex" },
    { executor_id: "local", model_id: "fixture.cheap" },
  ]);
  expect(lines.filter((l) => l.startsWith("stored"))).toEqual([
    "stored   (fixture, local, fixture.complex) as of runner 1: stored, not certified (1 failed)",
    "stored   (fixture, local, fixture.cheap) is certified as of runner 1",
  ]);
});

test("no --model on a new project's runner: its agents' model is the one certified", async () => {
  const { code, posts, lines } = await noModel(
    usedAs({
      "fixture.standard": [
        "demo · demo-builder-1 agent",
        "demo · demo-reviewer-1 agent",
      ],
    }),
  );
  expect(code).toBe(0);
  expect(posts).toEqual([
    { executor_id: "local", model_id: "fixture.standard" },
  ]);
  expect(lines[0]).toBe(
    "models   fixture.standard (used by demo · demo-builder-1 agent, demo · demo-reviewer-1 agent)",
  );
});

test("no --model and nothing uses a model of the runner: its default model is certified, and it says so", async () => {
  const { code, posts, lines } = await noModel(usedAs({}));
  expect(code).toBe(0);
  expect(posts).toEqual([
    { executor_id: "local", model_id: "fixture.standard" },
  ]);
  expect(lines[0]).toBe(
    "models   fixture.standard: no project, agent or role uses a model of fixture yet, so its default (the standard tier)",
  );
});

test("no --model, nothing in use and no standard tier: the first active model is the default", async () => {
  const noStandard = {
    runners: usedAs({}).runners.map((r) => ({
      ...r,
      models: r.models.filter((m) => m.tier !== "standard"),
    })),
  };
  const { code, posts, lines } = await noModel(noStandard);
  expect(code).toBe(0);
  expect(posts).toEqual([
    { executor_id: "local", model_id: "fixture.complex" },
  ]);
  expect(lines[0]).toBe(
    "models   fixture.complex: no project, agent or role uses a model of fixture yet, so its default (its first active model)",
  );
});

test("no --model on a runner with no active model: nothing to certify, and nothing runs", async () => {
  const none = {
    runners: RUNNERS.runners.map((r) => ({ ...r, models: [] })),
  };
  const { code, posts, lines } = await noModel(none);
  expect(code).toBe(1);
  expect(posts).toEqual([]);
  expect(lines).toEqual([
    "FAIL  runner fixture has no active model, so there is nothing to certify",
  ]);
});

test("a job runner is never certified: the supervisor's own job is not an agent", async () => {
  const { code, posts, lines } = await noModel(usedAs({}, "job"));
  expect(code).toBe(1);
  expect(posts).toEqual([]);
  expect(lines).toEqual([
    "FAIL  runner fixture is one of the supervisor's own jobs, not an agent runner: there is nothing to certify",
  ]);
});

test("an unknown runner is named", async () => {
  const { code, lines } = await noModel(RUNNERS, "nope");
  expect(code).toBe(1);
  expect(lines).toEqual([
    "FAIL  no runner nope: the Runners page lists the ones there are",
  ]);
});

test("no --model: a model only a project's step tier runs is certified too", async () => {
  const { code, posts } = await noModel(
    usedAs({ "fixture.standard": ["P · build step"] }),
  );
  expect(code).toBe(0);
  expect(posts).toEqual([
    { executor_id: "local", model_id: "fixture.standard" },
  ]);
});
