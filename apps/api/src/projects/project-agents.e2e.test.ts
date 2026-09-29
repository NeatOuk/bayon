// POST /projects/:id/agents and PATCH /agents/:id over HTTP against a temp-file DB.
import { FakeClock, systemClock } from "@bayon/core";
import { getAgent, openDb, type Db } from "@bayon/db";
import {
  modelRow,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import {
  AgentPulsesPage,
  AgentView,
  ApiErrorBody,
  AuditPage,
  ProjectsView,
  PulsePolicy,
} from "@bayon/proto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dbStore } from "../db-store.js";
import { startApi, type RunningApi } from "../server.js";
import { ProjectsService } from "./projects-service.js";

const TOKEN = "e2e-project-agents-0123456789abcdef";

let spine: TempDb;
let apiDb: Db;
let api: RunningApi;

const call = (
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> =>
  fetch(`${api.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function expectError(res: Response, status: number, errorClass: string) {
  expect(res.status).toBe(status);
  const body = ApiErrorBody.parse(await res.json());
  expect(body.error.class).toBe(errorClass);
  return body.error;
}

/** A project's agent ids, as GET /projects lists them. */
async function agentsOf(project: string): Promise<string[]> {
  const res = await call("GET", "/projects");
  const found = ProjectsView.parse(await res.json()).projects.find(
    (p) => p.id === project,
  );
  return (found?.agents ?? []).map((a) => a.id);
}

const shopAgents = () => agentsOf("shop");

async function audits(action: string) {
  const res = await call("GET", `/audit?action=${action}`);
  expect(res.status).toBe(200);
  return AuditPage.parse(await res.json()).items;
}

beforeAll(async () => {
  spine = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  unwrap(await seedSpine(spine.db, 1));
  unwrap(
    await seedRows(spine.db, {
      runners: [
        { id: "runner-b", kind: "script", adapter: "fixture", caps_json: "{}" },
        {
          id: "runner-off",
          kind: "script",
          adapter: "fixture",
          caps_json: "{}",
          enabled: 0,
        },
      ],
    }),
  );
  apiDb = unwrap(await openDb({ path: spine.path, clock: systemClock }));
  api = await startApi({
    config: { token: TOKEN, host: "127.0.0.1", port: 0 },
    store: dbStore(apiDb),
    clock: systemClock,
    logger: false,
    projects: new ProjectsService({
      db: apiDb,
      clock: systemClock,
      mirrorsRoot: "/home/frm/mirrors",
    }),
  });
  // `shop` as POST /projects makes it: shop-builder, shop-orchestrator, shop-reviewer on fixture.
  const made = await call("POST", "/projects", {
    name: "shop",
    repo_url: "https://example.com/shop.git",
    runner_id: "fixture",
  });
  expect(made.status).toBe(201);
});

afterAll(async () => {
  await api?.close();
  await apiDb?.close();
  spine?.cleanup();
});

test("both doors need the operator's bearer", async () => {
  for (const [method, path, body] of [
    [
      "POST",
      "/projects/shop/agents",
      { kind: "builder", runner_id: "runner-b" },
    ],
    ["PATCH", "/agents/shop-builder", { enabled: false }],
  ] as const) {
    const res = await fetch(`${api.url}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status, `${method} ${path}`).toBe(401);
  }
});

describe("POST /projects/:id/agents", () => {
  test("201: a builder on another runner, beside the project's own, with its audit row", async () => {
    const res = await call("POST", "/projects/shop/agents", {
      kind: "builder",
      runner_id: "runner-b",
    });
    expect(res.status).toBe(201);
    expect(AgentView.parse(await res.json())).toEqual({
      id: "shop-builder-1",
      name: "shop-builder-1",
      kind: "builder",
      runner_id: "runner-b",
      profile_id: "shop-builder-runner-b",
      workspace_id: "shop",
      executor_id: "local",
      max_concurrency: 1,
      enabled: true,
    });
    expect(await shopAgents()).toContain("shop-builder-1");
    expect(
      (await audits("agent.create")).find(
        (e) => e.target_id === "shop-builder-1",
      ),
    ).toMatchObject({
      actor: "operator",
      target_kind: "agent",
      payload: {
        via: "rest",
        workspace: "shop",
        kind: "builder",
        runner: "runner-b",
        profile: "shop-builder-runner-b",
      },
    });
  });

  test("201: a second on the same runner shares its profile; a reviewer is numbered on its own", async () => {
    const second = await call("POST", "/projects/shop/agents", {
      kind: "builder",
      runner_id: "runner-b",
      max_concurrency: 2,
    });
    expect(second.status).toBe(201);
    expect(AgentView.parse(await second.json())).toMatchObject({
      id: "shop-builder-2",
      profile_id: "shop-builder-runner-b",
      max_concurrency: 2,
    });
    const reviewer = await call("POST", "/projects/shop/agents", {
      kind: "reviewer",
      runner_id: "fixture",
    });
    expect(reviewer.status).toBe(201);
    expect(AgentView.parse(await reviewer.json())).toMatchObject({
      id: "shop-reviewer-1",
      kind: "reviewer",
      runner_id: "fixture",
      profile_id: "shop-reviewer-fixture",
    });
  });

  test.each<[string, string, unknown]>([
    [
      "an unregistered runner",
      "shop",
      { kind: "builder", runner_id: "nobody" },
    ],
    ["a disabled runner", "shop", { kind: "builder", runner_id: "runner-off" }],
    [
      "a kind no door adds",
      "shop",
      { kind: "investigator", runner_id: "fixture" },
    ],
    ["no runner", "shop", { kind: "builder" }],
    [
      "a negative max_concurrency",
      "shop",
      { kind: "builder", runner_id: "fixture", max_concurrency: -1 },
    ],
    [
      "a mission",
      "shop",
      { kind: "builder", runner_id: "fixture", mission_id: "m-1" },
    ],
  ])("400 for %s, writing nothing", async (_label, project, body) => {
    const agentsBefore = await shopAgents();
    const auditBefore = (await audits("agent.create")).length;
    await expectError(
      await call("POST", `/projects/${project}/agents`, body),
      400,
      "validation",
    );
    expect(await shopAgents()).toEqual(agentsBefore);
    expect(await audits("agent.create")).toHaveLength(auditBefore);
    expect((await getAgent(apiDb, `${project}-builder-1`)).ok).toBe(
      project === "shop",
    );
  });
});

// An orchestrator: `lab` is made without one, as `bayon` was left; the door adds one,
// and refuses a second while one is enabled.
describe("POST /projects/:id/agents with kind orchestrator", () => {
  beforeAll(async () => {
    const made = await call("POST", "/projects", {
      name: "lab",
      repo_url: "https://example.com/lab.git",
      runner_id: "fixture",
      orchestrator: false,
    });
    expect(made.status).toBe(201);
  });

  const addOrchestrator = (project: string, runner = "runner-b") =>
    call("POST", `/projects/${project}/agents`, {
      kind: "orchestrator",
      runner_id: runner,
    });

  test("201: lab-orchestrator-1 on lab-orchestrate-runner-b, audited, pulsing on the default policy", async () => {
    const res = await addOrchestrator("lab");
    expect(res.status).toBe(201);
    expect(AgentView.parse(await res.json())).toEqual({
      id: "lab-orchestrator-1",
      name: "lab-orchestrator-1",
      kind: "orchestrator",
      runner_id: "runner-b",
      profile_id: "lab-orchestrate-runner-b",
      workspace_id: "lab",
      executor_id: "local",
      max_concurrency: 1,
      enabled: true,
    });
    expect(
      (await audits("agent.create")).find(
        (e) => e.target_id === "lab-orchestrator-1",
      )?.payload,
    ).toEqual({
      via: "rest",
      workspace: "lab",
      kind: "orchestrator",
      runner: "runner-b",
      profile: "lab-orchestrate-runner-b",
    });
    const policies = await call("GET", "/agents/pulse-policies");
    expect(
      AgentPulsesPage.parse(await policies.json()).items.find(
        (a) => a.agent_id === "lab-orchestrator-1",
      ),
    ).toMatchObject({
      mode: "hybrid",
      interval_ms: 5_400_000,
      debounce_ms: 60_000,
      min_gap_ms: 300_000,
      max_per_hour: 8,
      jitter_pct: 5,
    });
  });

  test.each([
    ["lab", "lab-orchestrator-1"],
    ["shop", "shop-orchestrator"],
  ])(
    "409 for a second in %s while %s is enabled, writing nothing",
    async (project, existing) => {
      const agentsBefore = await agentsOf(project);
      const auditBefore = (await audits("agent.create")).length;
      const error = await expectError(
        await addOrchestrator(project, "fixture"),
        409,
        "conflict",
      );
      expect(error.message).toBe(
        `project ${project} already has an enabled orchestrator, ${existing}: disable it before adding another`,
      );
      expect(await agentsOf(project)).toEqual(agentsBefore);
      expect(await audits("agent.create")).toHaveLength(auditBefore);
    },
  );

  test("disabled, it is replaced: lab-orchestrator-2 on the same profile; re-enabling the old one is 409", async () => {
    const off = await call("PATCH", "/agents/lab-orchestrator-1", {
      enabled: false,
    });
    expect(off.status).toBe(200);
    const res = await addOrchestrator("lab");
    expect(res.status).toBe(201);
    expect(AgentView.parse(await res.json())).toMatchObject({
      id: "lab-orchestrator-2",
      profile_id: "lab-orchestrate-runner-b",
      enabled: true,
    });
    await expectError(
      await call("PATCH", "/agents/lab-orchestrator-1", { enabled: true }),
      409,
      "conflict",
    );
    expect(unwrap(await getAgent(apiDb, "lab-orchestrator-1")).enabled).toBe(0);
  });
});

test("404 for an unknown project in the path, writing nothing", async () => {
  const auditBefore = (await audits("agent.create")).length;
  await expectError(
    await call("POST", "/projects/nowhere/agents", {
      kind: "builder",
      runner_id: "runner-b",
    }),
    404,
    "not_found",
  );
  expect(await audits("agent.create")).toHaveLength(auditBefore);
  expect((await getAgent(apiDb, "nowhere-builder-1")).ok).toBe(false);
});

describe("PATCH /agents/:id", () => {
  test("200: disables, resizes and re-enables, each audited via rest; a no-op audits nothing", async () => {
    const off = await call("PATCH", "/agents/shop-builder", { enabled: false });
    expect(off.status).toBe(200);
    expect(AgentView.parse(await off.json())).toMatchObject({
      id: "shop-builder",
      kind: "builder",
      workspace_id: "shop",
      enabled: false,
      max_concurrency: 1,
    });
    const resized = await call("PATCH", "/agents/shop-builder", {
      enabled: true,
      max_concurrency: 3,
    });
    expect(resized.status).toBe(200);
    expect(AgentView.parse(await resized.json())).toMatchObject({
      enabled: true,
      max_concurrency: 3,
    });
    const before = await audits("agent.set");
    const same = await call("PATCH", "/agents/shop-builder", {
      max_concurrency: 3,
    });
    expect(same.status).toBe(200);
    expect(await audits("agent.set")).toHaveLength(before.length);
    const mine = before.filter((e) => e.target_id === "shop-builder");
    expect(mine.map((e) => e.payload)).toEqual(
      expect.arrayContaining([
        { via: "rest", from: { enabled: 1 }, to: { enabled: 0 } },
        {
          via: "rest",
          from: { enabled: 0, max_concurrency: 1 },
          to: { enabled: 1, max_concurrency: 3 },
        },
      ]),
    );
  });

  test("404 for an unknown agent", async () => {
    await expectError(
      await call("PATCH", "/agents/nobody", { enabled: false }),
      404,
      "not_found",
    );
  });

  test.each<[string, unknown]>([
    ["an empty body", {}],
    ["a negative max_concurrency", { max_concurrency: -1 }],
    ["a profile", { profile_id: "shop-build" }],
    ["a mission", { mission_id: "m-1" }],
    ["a runner", { enabled: true, runner_id: "runner-b" }],
    ["a project", { enabled: true, workspace_id: "other" }],
  ])("400 for %s, writing nothing", async (_label, body) => {
    const before = unwrap(await getAgent(apiDb, "shop-reviewer"));
    await expectError(
      await call("PATCH", "/agents/shop-reviewer", body),
      400,
      "validation",
    );
    expect(unwrap(await getAgent(apiDb, "shop-reviewer"))).toEqual(before);
  });

  test("PATCH /agents/:id/pulse-policy still reaches its own route", async () => {
    const res = await call("PATCH", "/agents/shop-orchestrator/pulse-policy", {
      mode: "manual",
    });
    expect(res.status).toBe(200);
    expect(PulsePolicy.parse(await res.json()).mode).toBe("manual");
  });
});

describe("GET /projects: each agent's model", () => {
  test("the builder binding's tier wins over the agent's profile; no active model is null", async () => {
    unwrap(
      await seedRows(spine.db, {
        models: [
          modelRow("runner-b", "cheap"),
          modelRow("runner-b", "standard"),
          modelRow("runner-b", "complex"),
        ],
        role_bindings: [
          {
            role: "builder",
            runner_id: "runner-b",
            model_tier: "complex",
            updated_at: 0,
          },
        ],
      }),
    );
    const made = await call("POST", "/projects/shop/agents", {
      kind: "builder",
      runner_id: "runner-b",
    });
    expect(made.status).toBe(201);
    const id = AgentView.parse(await made.json()).id;
    const res = await call("GET", "/projects");
    const shop = ProjectsView.parse(await res.json()).projects.find(
      (p) => p.id === "shop",
    );
    expect(shop?.agents.find((a) => a.id === id)?.model).toBe(
      "runner-b-complex-model",
    );
    // The spine's runner registers no model here: nothing to name.
    expect(
      shop?.agents.find((a) => a.id === "shop-reviewer")?.model,
    ).toBeNull();
  });
});
