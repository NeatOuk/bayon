// GET /runners and POST /runners/:id/conformance over HTTP: the certification per
// (executor, model) as the supervisor stored it, the runner's active models with their
// bound roles, and one runner.conformance command per request, for an active model of that runner.
import { FakeClock, systemClock } from "@bayon/core";
import {
  SPINE_SEED,
  listCommands,
  modelRow,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import { recordRunnerUpdate } from "@bayon/db/testing";
import {
  ApiErrorBody,
  Fleet,
  IDEMPOTENCY_HEADER,
  RunnerConformanceAccepted,
  RunnerUpdateDismissed,
  RunnersView,
} from "@bayon/proto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { dbStore } from "./db-store.js";
import { startApi, type RunningApi } from "./server.js";

const TOKEN = "e2e-runners-bearer-0123456789abcdef";
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

let t: TempDb;
let api: RunningApi;
const CHEAP = `${SPINE_SEED.runnerId}.cheap`;
const COMPLEX = `${SPINE_SEED.runnerId}.complex`;

beforeAll(async () => {
  t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  unwrap(await seedSpine(t.db, 8));
  unwrap(
    await seedRows(t.db, {
      executors: [{ id: "ctr", kind: "container", config_json: "{}" }],
      runners: [
        { id: "other", kind: "script", adapter: "other", caps_json: "{}" },
      ],
      models: [
        modelRow(SPINE_SEED.runnerId, "cheap"),
        modelRow(SPINE_SEED.runnerId, "complex"),
        modelRow(SPINE_SEED.runnerId, "standard", { active: 0 }),
        modelRow("other", "cheap"),
      ],
      profiles: [
        {
          id: "P-BUILD",
          name: "P-BUILD",
          runner_id: SPINE_SEED.runnerId,
          model_tier: "cheap",
          version: 1,
          hash: "h",
          created_at: 0,
        },
      ],
      role_bindings: [
        // The binding's tier wins over its profile's: code review runs complex.
        {
          role: "code_reviewer",
          runner_id: SPINE_SEED.runnerId,
          model_tier: "complex",
          profile_id: "P-BUILD",
          updated_at: 0,
        },
        // No tier: the profile's (cheap).
        {
          role: "builder",
          runner_id: SPINE_SEED.runnerId,
          profile_id: "P-BUILD",
          updated_at: 0,
        },
      ],
      runner_certifications: [
        {
          runner_id: SPINE_SEED.runnerId,
          executor_id: SPINE_SEED.executorId,
          model_id: CHEAP,
          model: "fixture-cheap-model",
          runner_version: "1",
          suite_version: "1",
          kit_hash: "sha256:kit",
          caps_hash: "sha256:caps",
          result_json: JSON.stringify({ summary: SUMMARY }),
          report_path: "/docs/conformance/fixture-1@local.md",
          gate_eligible: 1,
          passed_at: 5,
          certified_at: 5,
        },
        {
          runner_id: SPINE_SEED.runnerId,
          executor_id: "ctr",
          model_id: CHEAP,
          model: "fixture-cheap-model",
          runner_version: "0",
          suite_version: "1",
          kit_hash: "sha256:kit",
          caps_hash: "sha256:caps",
          result_json: "not json",
          report_path: null,
          gate_eligible: 0,
          passed_at: null,
          certified_at: 4,
          decertified_at: 6,
          decertified_reason: "runner_version 0 → 1",
        },
        // The same model's compression-on certificate: a row of its own.
        {
          runner_id: SPINE_SEED.runnerId,
          executor_id: SPINE_SEED.executorId,
          model_id: CHEAP,
          compression: 1,
          model: "fixture-cheap-model",
          runner_version: "1",
          suite_version: "1",
          kit_hash: "sha256:kit+ctx1",
          caps_hash: "sha256:caps",
          result_json: JSON.stringify({ summary: SUMMARY }),
          report_path: "/docs/conformance/fixture-1@local+ctx1.md",
          gate_eligible: 1,
          passed_at: 7,
          certified_at: 7,
        },
      ],
    }),
  );
  api = await startApi({
    config: { token: TOKEN, host: "127.0.0.1", port: 0 },
    store: dbStore(t.db),
    clock: systemClock,
    logger: false,
  });
});

afterAll(async () => {
  await api.close();
  t.cleanup();
});

const call = (path: string, init: RequestInit = {}) =>
  fetch(`${api.url}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });

const post = (runner: string, body: unknown, key?: string) =>
  call(`/runners/${runner}/conformance`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: key === undefined ? {} : { [IDEMPOTENCY_HEADER]: key },
  });

test("GET /runners: each runner with its certification per (executor, model), decertified ones included, and its active models' bound roles", async () => {
  const res = await call("/runners");
  expect(res.status).toBe(200);
  const { runners } = RunnersView.parse(await res.json());
  expect(runners.map((r) => r.id)).toEqual([SPINE_SEED.runnerId, "other"]);
  const [runner] = runners;
  // Active models only; each with the roles whose binding runs it.
  const stored = {
    source: "adapter",
    active: true,
    effort: null,
    price_out_per_mtok: null,
    price_cache_read_per_mtok: null,
    price_cache_write_per_mtok: null,
    context_tokens: null,
    settings: {},
  };
  expect(runner?.models).toEqual([
    {
      id: CHEAP,
      tier: "cheap",
      model: `${SPINE_SEED.runnerId}-cheap-model`,
      bound_roles: ["builder"],
      ...stored,
      price_in_per_mtok: 1,
    },
    {
      id: COMPLEX,
      tier: "complex",
      model: `${SPINE_SEED.runnerId}-complex-model`,
      bound_roles: ["code_reviewer"],
      ...stored,
      price_in_per_mtok: 15,
    },
  ]);
  // Turned off, not retired: listed apart, so the operator can turn it on again.
  expect(runner?.inactive_models.map((m) => m.id)).toEqual([
    `${SPINE_SEED.runnerId}.standard`,
  ]);
  expect(runner).toMatchObject({
    kind: "script",
    enabled: true,
    caps: null, // the seed's caps_json is {}: not a capability matrix
    gate_eligible: false,
  });
  expect(runner?.certifications).toEqual([
    {
      executor_id: "ctr",
      model_id: CHEAP,
      compression: false,
      model: "fixture-cheap-model",
      runner_version: "0",
      suite_version: "1",
      kit_hash: "sha256:kit",
      caps_hash: "sha256:caps",
      report_path: null,
      gate_eligible: false,
      passed_at: null,
      certified_at: 4,
      decertified_at: 6,
      decertified_reason: "runner_version 0 → 1",
      summary: null,
    },
    {
      executor_id: "local",
      model_id: CHEAP,
      compression: false,
      model: "fixture-cheap-model",
      runner_version: "1",
      suite_version: "1",
      kit_hash: "sha256:kit",
      caps_hash: "sha256:caps",
      report_path: "/docs/conformance/fixture-1@local.md",
      gate_eligible: true,
      passed_at: 5,
      certified_at: 5,
      decertified_at: null,
      decertified_reason: null,
      summary: SUMMARY,
    },
    {
      executor_id: "local",
      model_id: CHEAP,
      compression: true,
      model: "fixture-cheap-model",
      runner_version: "1",
      suite_version: "1",
      kit_hash: "sha256:kit+ctx1",
      caps_hash: "sha256:caps",
      report_path: "/docs/conformance/fixture-1@local+ctx1.md",
      gate_eligible: true,
      passed_at: 7,
      certified_at: 7,
      decertified_at: null,
      decertified_reason: null,
      summary: SUMMARY,
    },
  ]);
});

test("POST /runners/:id/conformance inserts one runner.conformance; a repeated key answers the first", async () => {
  const body = {
    executor_id: "local",
    model_id: COMPLEX,
    report_dir: "/abs/docs/conformance",
  };
  const res = await post(SPINE_SEED.runnerId, body, "conf-1");
  expect(res.status).toBe(202);
  const accepted = RunnerConformanceAccepted.parse(await res.json());
  expect(accepted.created).toBe(true);
  const again = RunnerConformanceAccepted.parse(
    await (await post(SPINE_SEED.runnerId, body, "conf-1")).json(),
  );
  expect(again).toEqual({ command_id: accepted.command_id, created: false });
  const commands = unwrap(await listCommands(t.db)).filter(
    (c) => c.type === "runner.conformance",
  );
  expect(commands).toHaveLength(1);
  expect(JSON.parse(commands[0]?.payload_json ?? "null")).toEqual({
    runner_id: SPINE_SEED.runnerId,
    executor_id: "local",
    model_id: COMPLEX,
    report_dir: "/abs/docs/conformance",
  });
});

test("a model that is not an active model of the runner is refused with the reason, and inserts nothing", async () => {
  const before = unwrap(await listCommands(t.db)).length;
  for (const [model, why] of [
    ["no-such-model", "does not exist"],
    ["other.cheap", `is runner other's, not ${SPINE_SEED.runnerId}'s`],
    [`${SPINE_SEED.runnerId}.standard`, "is retired"],
  ] as const) {
    const res = await post(SPINE_SEED.runnerId, {
      executor_id: "local",
      model_id: model,
    });
    expect(res.status, model).toBe(400);
    expect(ApiErrorBody.parse(await res.json()).error).toMatchObject({
      class: "validation",
      message: expect.stringContaining(`model ${model} ${why}`),
    });
  }
  // No model at all is the request's own shape error.
  expect(
    (await post(SPINE_SEED.runnerId, { executor_id: "local" })).status,
  ).toBe(400);
  expect(unwrap(await listCommands(t.db))).toHaveLength(before);
});

test("an unknown runner or executor is 404 and inserts nothing; a relative report_dir or no executor is 400", async () => {
  const before = unwrap(await listCommands(t.db)).length;
  for (const [runner, body, status] of [
    ["no-such-runner", { executor_id: "local", model_id: CHEAP }, 404],
    [
      SPINE_SEED.runnerId,
      { executor_id: "no-such-executor", model_id: CHEAP },
      404,
    ],
    [
      SPINE_SEED.runnerId,
      { executor_id: "local", model_id: CHEAP, report_dir: "docs" },
      400,
    ],
    [SPINE_SEED.runnerId, {}, 400],
  ] as const) {
    const res = await post(runner, body);
    expect(res.status, JSON.stringify(body)).toBe(status);
    ApiErrorBody.parse(await res.json());
  }
  expect(unwrap(await listCommands(t.db))).toHaveLength(before);
});

test("a runner that cannot run in a container is refused on one at once, naming the reason, and inserts nothing; a ready one, or any on a local executor, is accepted", async () => {
  // Container readiness as adapters declare it in their defaults.
  unwrap(
    await seedRows(t.db, {
      runners: [
        {
          id: "ctr-ready",
          kind: "script",
          adapter: "ctr-ready",
          caps_json: "{}",
          defaults_json: JSON.stringify({ containerInstall: ["npm i -g r@1"] }),
        },
        {
          id: "ctr-unready",
          kind: "script",
          adapter: "ctr-unready",
          caps_json: "{}",
          defaults_json: JSON.stringify({
            containerInstall: ["npm i -g u@1"],
            containerUnready: "it starts this host's node",
          }),
        },
      ],
      models: [
        modelRow("ctr-ready", "cheap"),
        modelRow("ctr-unready", "cheap"),
      ],
    }),
  );
  const body = (runner: string, executor: string) => ({
    executor_id: executor,
    model_id: `${runner}.cheap`,
  });
  const before = unwrap(await listCommands(t.db)).length;
  const began = performance.now();
  const refused = await post("ctr-unready", body("ctr-unready", "ctr"));
  expect(performance.now() - began).toBeLessThan(1_000);
  expect(refused.status).toBe(400);
  expect(ApiErrorBody.parse(await refused.json()).error).toMatchObject({
    class: "validation",
    retryable: false,
    message:
      "runner ctr-unready cannot run on container executor ctr: it starts this host's node",
  });
  // The spine's runner declares no install line: no image holds it either.
  const bare = await post(
    SPINE_SEED.runnerId,
    body(SPINE_SEED.runnerId, "ctr"),
  );
  expect(bare.status).toBe(400);
  expect(ApiErrorBody.parse(await bare.json()).error.message).toContain(
    "no containerInstall line",
  );
  expect(unwrap(await listCommands(t.db))).toHaveLength(before);
  for (const [runner, executor] of [
    ["ctr-ready", "ctr"],
    ["ctr-unready", SPINE_SEED.executorId],
  ] as const) {
    const res = await post(runner, body(runner, executor));
    expect(res.status, `${runner} on ${executor}`).toBe(202);
  }
  expect(unwrap(await listCommands(t.db))).toHaveLength(before + 2);
});

test("a conformance run on a disabled executor is refused, naming it, and inserts nothing; the same run on an enabled one is accepted", async () => {
  // `frm executor disable` takes a box out of service. Admission already refuses a spawn on one;
  // the suite is minutes of real work on the same box, so it is refused here too.
  unwrap(
    await seedRows(t.db, {
      executors: [{ id: "off", kind: "local", config_json: "{}", enabled: 0 }],
    }),
  );
  const before = unwrap(await listCommands(t.db)).length;
  const refused = await post(SPINE_SEED.runnerId, {
    executor_id: "off",
    model_id: CHEAP,
  });
  expect(refused.status).toBe(429);
  expect(ApiErrorBody.parse(await refused.json()).error).toMatchObject({
    class: "admission_refused",
    retryable: false,
    gate: "disabled",
    message: expect.stringContaining("executor off is disabled"),
  });
  expect(unwrap(await listCommands(t.db))).toHaveLength(before);
  // Not a blanket refusal: the same runner on an enabled executor is still accepted.
  const accepted = await post(SPINE_SEED.runnerId, {
    executor_id: SPINE_SEED.executorId,
    model_id: CHEAP,
  });
  expect(accepted.status).toBe(202);
  expect(unwrap(await listCommands(t.db))).toHaveLength(before + 1);
});

test("the runner routes need the operator's bearer", async () => {
  const res = await fetch(`${api.url}/runners`);
  expect(res.status).toBe(401);
});

// Last: it adds a project whose step tier binds a model. GET /runners counts it bound,
// labelled with the project and step, so `frm runner conformance` certifies it by default; the role
// bindings' own models are unchanged.
test("a project's step tier makes its model bound on the runner of the agents that run the step", async () => {
  unwrap(
    await seedRows(t.db, {
      workspaces: [
        { id: "P", name: "P", kind: "single", build_tier: "complex" },
      ],
    }),
  );
  const res = await call("/runners");
  expect(res.status).toBe(200);
  const runner = RunnersView.parse(await res.json()).runners.find(
    (r) => r.id === SPINE_SEED.runnerId,
  );
  // P has no builder of its own: the fleet's (the spine's agent) runs its build step.
  expect(
    Object.fromEntries(
      (runner?.models ?? []).map((m) => [m.id, m.bound_roles]),
    ),
  ).toEqual({
    [CHEAP]: ["builder"],
    [COMPLEX]: ["code_reviewer", "P · build step"],
  });
});

test("POST /runners/:id/conformance with compression: on a local executor it is asked for; on another it is refused at once", async () => {
  const before = unwrap(await listCommands(t.db)).length;
  const refused = await post(SPINE_SEED.runnerId, {
    executor_id: "ctr",
    model_id: CHEAP,
    compression: true,
  });
  expect(refused.status).toBe(400);
  expect(ApiErrorBody.parse(await refused.json()).error).toMatchObject({
    class: "validation",
    message: expect.stringContaining(
      "context compression runs on a local executor only",
    ),
  });
  expect(unwrap(await listCommands(t.db))).toHaveLength(before);
  const res = await post(
    SPINE_SEED.runnerId,
    { executor_id: "local", model_id: CHEAP, compression: true },
    "conf-ctx",
  );
  expect(res.status).toBe(202);
  const { command_id } = RunnerConformanceAccepted.parse(await res.json());
  const inserted = unwrap(await listCommands(t.db)).find(
    (c) => c.id === command_id,
  );
  expect(JSON.parse(inserted?.payload_json ?? "null")).toEqual({
    runner_id: SPINE_SEED.runnerId,
    executor_id: "local",
    model_id: CHEAP,
    compression: true,
  });
});

// The runner update check: the supervisor's row, dismissed through the operator's REST
// door, appearing and disappearing from GET /runners and GET /fleet.
test("an open runner update appears on GET /runners and GET /fleet, and the dismiss door clears it", async () => {
  unwrap(
    await recordRunnerUpdate(t.db, {
      runner_id: SPINE_SEED.runnerId,
      current: "0.3.283",
      latest: "0.3.290",
      newer: true,
      notes_url: "https://example.com/changelog",
    }),
  );

  const runners = RunnersView.parse(
    await (await call("/runners")).json(),
  ).runners;
  const runner = runners.find((r) => r.id === SPINE_SEED.runnerId);
  expect(runner?.update).toEqual({
    runner_id: SPINE_SEED.runnerId,
    current: "0.3.283",
    latest: "0.3.290",
    notes_url: "https://example.com/changelog",
    found_at: expect.any(Number),
  });

  const fleet = Fleet.parse(await (await call("/fleet")).json());
  expect(fleet.runner_updates).toEqual([
    expect.objectContaining({
      runner_id: SPINE_SEED.runnerId,
      latest: "0.3.290",
    }),
  ]);

  // Dismissing an unseen version is not_found.
  const missing = await call(
    `/runners/${SPINE_SEED.runnerId}/updates/9.9.9/dismiss`,
    { method: "POST" },
  );
  expect(missing.status).toBe(404);

  const dismiss = await call(
    `/runners/${SPINE_SEED.runnerId}/updates/0.3.290/dismiss`,
    { method: "POST" },
  );
  expect(dismiss.status).toBe(200);
  expect(RunnerUpdateDismissed.parse(await dismiss.json())).toEqual({
    runner_id: SPINE_SEED.runnerId,
    latest: "0.3.290",
  });
  // Idempotent: dismissing again is still 200, not an error.
  const again = await call(
    `/runners/${SPINE_SEED.runnerId}/updates/0.3.290/dismiss`,
    { method: "POST" },
  );
  expect(again.status).toBe(200);

  const after = RunnersView.parse(
    await (await call("/runners")).json(),
  ).runners.find((r) => r.id === SPINE_SEED.runnerId);
  expect(after?.update).toBeNull();
  const fleetAfter = Fleet.parse(await (await call("/fleet")).json());
  expect(fleetAfter.runner_updates).toEqual([]);
});
