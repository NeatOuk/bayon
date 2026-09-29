// POST /projects over HTTP against a temp-file DB (§9.5 amendment).
import {
  FakeClock,
  NO_STEP_TIERS,
  QA_CI_NEEDS_PR,
  systemClock,
} from "@bayon/core";
import {
  listRepos,
  listTickets,
  listWorkspaces,
  openDb,
  type Db,
} from "@bayon/db";
import {
  allowTickets,
  refuseTickets,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import {
  DEFAULT_JIRA_PUSH_VIEW,
  NO_DELIVERY,
  NO_DOCS,
  NO_QA,
  ApiErrorBody,
  AuditPage,
  ProjectCreated,
  ProjectSettingsState,
  ProjectsView,
  PushTargetsDetected,
  type CreateProjectRequest,
} from "@bayon/proto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dbStore } from "../db-store.js";
import { startApi, type RunningApi } from "../server.js";
import { ProjectsService } from "./projects-service.js";

const TOKEN = "e2e-projects-0123456789abcdef";

let spine: TempDb;
let apiDb: Db;
let api: RunningApi;

beforeAll(async () => {
  spine = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  unwrap(await seedSpine(spine.db, 1));
  unwrap(
    await seedRows(spine.db, {
      executors: [
        { id: "disabled", kind: "local", config_json: "{}", enabled: 0 },
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
});

afterAll(async () => {
  await api?.close();
  await apiDb?.close();
  spine?.cleanup();
});

const call = (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> =>
  fetch(`${api.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function expectError(res: Response, status: number, errorClass: string) {
  expect(res.status).toBe(status);
  const body = ApiErrorBody.parse(await res.json());
  expect(body.error.class).toBe(errorClass);
  return body.error;
}

const REQUEST: CreateProjectRequest = {
  name: "e2e1",
  repo_url: "https://example.com/e2e1.git",
  runner_id: "fixture",
  executor_id: "local",
  orchestrator: true,
};

test("POST /projects needs the operator's bearer", async () => {
  const res = await fetch(`${api.url}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(REQUEST),
  });
  expect(res.status).toBe(401);
});

describe("each refusal is 400 and writes nothing", () => {
  test.each([
    ["a bad name", { ...REQUEST, name: "e2e refused 1" }],
    [
      "a bad repo_url",
      { ...REQUEST, name: "e2e-refused-2", repo_url: "/local/path" },
    ],
    ["the reserved mirror prefix", { ...REQUEST, name: "frm-refused" }],
    [
      "an unregistered runner",
      { ...REQUEST, name: "e2e-refused-3", runner_id: "nobody" },
    ],
    [
      "an unregistered reviewer runner",
      { ...REQUEST, name: "e2e-refused-4", reviewer_runner_id: "nobody" },
    ],
    [
      "an absent executor",
      { ...REQUEST, name: "e2e-refused-5", executor_id: "nowhere" },
    ],
    [
      "a disabled executor",
      { ...REQUEST, name: "e2e-refused-6", executor_id: "disabled" },
    ],
  ])("%s", async (_label, body) => {
    const reposBefore = unwrap(await listRepos(apiDb)).length;
    const workspacesBefore = unwrap(await listWorkspaces(apiDb)).length;
    const res = await call("POST", "/projects", body);
    await expectError(res, 400, "validation");
    expect(unwrap(await listRepos(apiDb))).toHaveLength(reposBefore);
    expect(unwrap(await listWorkspaces(apiDb))).toHaveLength(workspacesBefore);
  });
});

test("happy path is 201 with the documented shape; a repeat name is 409; the audit row appears", async () => {
  const res = await call("POST", "/projects", REQUEST);
  expect(res.status).toBe(201);
  const created = ProjectCreated.parse(await res.json());
  expect(created).toEqual({
    repo_id: "e2e1",
    workspace_id: "e2e1",
    builder_agent_id: "e2e1-builder",
    orchestrator_agent_id: "e2e1-orchestrator",
    reviewer_agent_id: "e2e1-reviewer",
    submodule_repo_ids: [],
    // A URL project is not probed for a push target: nothing to warn about.
    warnings: [],
  });

  const repeat = await call("POST", "/projects", REQUEST);
  await expectError(repeat, 409, "conflict");

  const audit = await call("GET", "/audit?action=project.create");
  expect(audit.status).toBe(200);
  const page = AuditPage.parse(await audit.json());
  const entry = page.items.find((e) => e.target_id === "e2e1");
  expect(entry).toMatchObject({
    actor: "operator",
    action: "project.create",
    target_kind: "project",
    target_id: "e2e1",
  });
  expect(entry?.payload).toMatchObject({
    via: "rest",
    repo: "https://example.com/e2e1.git",
    runner: "fixture",
    executor: "local",
    reviewer_runner: "fixture",
  });
});

test("GET /projects lists a created project with its repo, agents and open tickets", async () => {
  const made = await call("POST", "/projects", {
    ...REQUEST,
    name: "e2e-list",
  });
  expect(made.status).toBe(201);
  const res = await call("GET", "/projects");
  expect(res.status).toBe(200);
  const listed = ProjectsView.parse(await res.json()).projects.find(
    (p) => p.id === "e2e-list",
  );
  expect(listed).toEqual({
    id: "e2e-list",
    name: "e2e-list",
    kind: "single",
    repos: [
      {
        id: "e2e-list",
        origin_url: REQUEST.repo_url,
        push_url: null,
        rel_path: "e2e-list",
        submodule_path: null,
        default_base_branch: "main",
      },
    ],
    agents: [
      expect.objectContaining({ id: "e2e-list-builder", kind: "builder" }),
      expect.objectContaining({ id: "e2e-list-orchestrator" }),
      expect.objectContaining({ id: "e2e-list-reviewer", kind: "reviewer" }),
    ],
    open_tickets: 0,
    paused: false,
    staff_approval: false,
    jira: null,
    qa: NO_QA,
    docs: NO_DOCS,
    delivery: NO_DELIVERY,
    jira_push: DEFAULT_JIRA_PUSH_VIEW,
    step_tiers: NO_STEP_TIERS,
    context_compression: false,
  });
});

// The project's QA harness: set through `PATCH /projects/:id`, audited `project.set`,
// refused for a command that is not an argv, and — in mode `pending` — filing exactly one ticket
// from the versioned template that asks an agent to build one.
describe("the QA harness", () => {
  const CREATE: CreateProjectRequest = {
    name: "e2e-qa",
    repo_url: "https://example.com/e2e-qa.git",
    runner_id: "fixture",
    executor_id: "local",
    orchestrator: false,
    reviewer_runner_id: null,
  };
  const HARNESS = {
    mode: "command" as const,
    cmd: "./scripts/check {ticket}",
    timeout_ms: 600_000,
    secrets: ["QA_TOKEN"],
    reports: ["reports/*.xml"],
    junit: "reports/junit.xml",
  };

  beforeAll(async () => {
    expect((await call("POST", "/projects", CREATE)).status).toBe(201);
  });

  const qaOf = async (): Promise<unknown> =>
    ProjectsView.parse(
      await (await call("GET", "/projects")).json(),
    ).projects.find((p) => p.id === "e2e-qa")?.qa;

  test("PATCH sets the harness, answers it back, and the same values again change nothing", async () => {
    const res = await call("PATCH", "/projects/e2e-qa", { qa: HARNESS });
    expect(res.status).toBe(200);
    const state = ProjectSettingsState.parse(await res.json());
    expect(state).toMatchObject({
      project: "e2e-qa",
      changed: true,
      qa_ticket: null,
      qa: { ...HARNESS, secrets: ["QA_TOKEN"], reports: ["reports/*.xml"] },
    });
    expect(await qaOf()).toMatchObject({ mode: "command", cmd: HARNESS.cmd });

    const again = await call("PATCH", "/projects/e2e-qa", { qa: HARNESS });
    expect(ProjectSettingsState.parse(await again.json()).changed).toBe(false);
  });

  // The mutation check the spike names: drop the metacharacter refusal and each of these is stored
  // and then run as literal arguments, failing in a way that reads as a broken project.
  test("a command that is not an argv is refused 400, and nothing is written", async () => {
    for (const cmd of [
      "make check && echo done",
      "make check | tee out",
      "sh -c 'make check'",
      "make check > out.txt",
      "make check {tickt}",
    ]) {
      const res = await call("PATCH", "/projects/e2e-qa", {
        qa: { mode: "command", cmd },
      });
      expect(res.status, cmd).toBe(400);
    }
    // A mode of `command` with no command at all is refused the same way.
    expect(
      (await call("PATCH", "/projects/e2e-qa", { qa: { mode: "command" } }))
        .status,
    ).toBe(400);
    // A secret name that is not one, and a glob that leaves the worktree.
    for (const qa of [
      { mode: "command", cmd: "make check", secrets: ["lower"] },
      { mode: "command", cmd: "make check", reports: ["../out.xml"] },
    ]) {
      expect((await call("PATCH", "/projects/e2e-qa", { qa })).status).toBe(
        400,
      );
    }
    // …and the stored harness is still the one that passed.
    expect(await qaOf()).toMatchObject({ cmd: HARNESS.cmd });
  });

  test("mode pending files one ticket from the template; a second PATCH files none", async () => {
    const res = await call("PATCH", "/projects/e2e-qa", {
      qa: { mode: "pending" },
    });
    expect(res.status).toBe(200);
    const state = ProjectSettingsState.parse(await res.json());
    expect(state.qa.mode).toBe("pending");
    expect(state.qa_ticket).not.toBeNull();

    const tickets = unwrap(
      await listTickets(apiDb, { workspace_id: "e2e-qa", limit: 10 }),
    ).rows;
    expect(tickets).toHaveLength(1);
    const [filed] = tickets;
    expect(filed).toMatchObject({
      origin: "operator",
      status: "backlog",
      type: "chore",
      workspace_id: "e2e-qa",
    });
    // The body is the compiled template, and it names no framework, file or report format.
    expect(filed?.body_md).toContain("exits 0 when the project is good");
    expect(filed?.body_md).toContain("{ticket}");
    expect(filed?.acceptance_md).toContain("argv with no shell");

    // Picking pending again changes nothing, so it files nothing.
    const again = await call("PATCH", "/projects/e2e-qa", {
      qa: { mode: "pending" },
    });
    expect(ProjectSettingsState.parse(await again.json())).toMatchObject({
      changed: false,
      qa_ticket: null,
    });
    expect(
      unwrap(await listTickets(apiDb, { workspace_id: "e2e-qa", limit: 10 }))
        .rows,
    ).toHaveLength(1);
  });

  // The review's MEDIUM: the ticket is filed **inside** the settings write. Before, a failure to
  // file left the mode already `pending`, and the retry — which files only on the transition — saw
  // "already pending" and filed nothing, stranding the project with no ticket and no way back.
  test("a ticket that cannot be filed rolls the mode back, and asking again works", async () => {
    expect(
      (await call("PATCH", "/projects/e2e-qa", { qa: { mode: "none" } }))
        .status,
    ).toBe(200);
    const before = unwrap(
      await listTickets(apiDb, { workspace_id: "e2e-qa", limit: 10 }),
    ).rows.length;

    // Every ticket insert for this project refused: the settings UPDATE has already run when it
    // fires, so a filer outside the transaction would leave `pending` behind.
    refuseTickets(apiDb, "e2e-qa");
    const failed = await call("PATCH", "/projects/e2e-qa", {
      qa: { mode: "pending" },
    });
    expect(failed.status).not.toBe(200);
    // Rolled back whole: the mode never moved, and no ticket was filed.
    expect(await qaOf()).toMatchObject({ mode: "none" });
    expect(
      unwrap(await listTickets(apiDb, { workspace_id: "e2e-qa", limit: 10 }))
        .rows,
    ).toHaveLength(before);

    allowTickets(apiDb);
    const retried = await call("PATCH", "/projects/e2e-qa", {
      qa: { mode: "pending" },
    });
    expect(retried.status).toBe(200);
    const state = ProjectSettingsState.parse(await retried.json());
    expect(state.qa.mode).toBe("pending");
    expect(state.qa_ticket).not.toBeNull();
    expect(
      unwrap(await listTickets(apiDb, { workspace_id: "e2e-qa", limit: 10 }))
        .rows,
    ).toHaveLength(before + 1);
  });

  test("the audit names the QA fields that changed, and no secret value", async () => {
    const audit = AuditPage.parse(
      await (await call("GET", "/audit?action=project.*")).json(),
    ).items;
    // Two `project.set` rows for this project: the harness, then the move to pending.
    const sets = audit.filter(
      (a) => a.target_id === "e2e-qa" && a.action === "project.set",
    );
    // One row per change this suite made, each naming only what moved.
    const qas = sets.map(
      (a) => (a.payload as { qa?: Record<string, unknown> }).qa,
    );
    expect(qas.every((qa) => qa !== undefined)).toBe(true);
    expect([...new Set(qas.map((qa) => qa?.["mode"]))].toSorted()).toEqual([
      "command",
      "none",
      "pending",
    ]);
    const configured = qas.find((qa) => qa?.["mode"] === "command");
    expect(configured).toMatchObject({
      cmd: HARNESS.cmd,
      secrets: ["QA_TOKEN"],
      reports: ["reports/*.xml"],
      junit: "reports/junit.xml",
    });
    // The request is its own row, targeting the ticket it filed, and naming the project. One per
    // ticket actually filed: the run that rolled back left none.
    const asked = audit.filter(
      (a) => a.action === "project.qa_harness_requested",
    );
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatchObject({
      actor: "operator",
      target_kind: "ticket",
      payload: { project: "e2e-qa" },
    });
  });
});

// A documentation source on the create. "Same as Jira" is resolved by core's own rule,
// the one `PATCH /projects/:id` runs — so the create refuses with the same sentence rather than
// letting the row reach 037's CHECK and handing the caller a constraint message.
describe("POST /projects with a documentation source", () => {
  const JIRA = {
    url: "https://acme.atlassian.net",
    email: "op@acme.test",
    jql: "project = ACME",
  };

  test("with a Jira source in the same request, it takes that site and account", async () => {
    const res = await call("POST", "/projects", {
      ...REQUEST,
      name: "e2e-docs",
      repo_url: "https://example.com/e2e-docs.git",
      jira: JIRA,
      docs: { kind: "confluence", spaces: ["ONE"] },
    });
    expect(res.status).toBe(201);
    const listed = ProjectsView.parse(
      await (await call("GET", "/projects")).json(),
    ).projects.find((p) => p.id === "e2e-docs");
    expect(listed?.docs).toEqual({
      kind: "confluence",
      url: JIRA.url,
      email: JIRA.email,
      spaces: ["ONE"],
    });
  });

  test("with no site anywhere it is a clean 400, naming the field and not the database", async () => {
    const before = unwrap(await listWorkspaces(spine.db)).length;
    const res = await call("POST", "/projects", {
      ...REQUEST,
      name: "e2e-nodocs",
      repo_url: "https://example.com/e2e-nodocs.git",
      docs: { kind: "confluence", spaces: ["ONE"] },
    });
    const error = await expectError(res, 400, "validation");
    expect(error.message).toBe(
      "a confluence documentation source needs a site and an account: this project has no Jira source to take them from",
    );
    // Not a constraint violation leaking the schema, and nothing written.
    expect(error.message).not.toMatch(/CHECK|constraint|SQLITE/i);
    expect(unwrap(await listWorkspaces(spine.db))).toHaveLength(before);
  });
});

// CI checks as the QA source: refused with core's one sentence unless delivery opens a
// pull request when review passes — on create, on PATCH, and on a delivery change away from it.
describe("CI checks as QA", () => {
  const CI = { mode: "ci", ci_checks: ["build"], ci_timeout_ms: 1_800_000 };
  const PR = { mode: "pull_request", when: "review_passed" };

  test("create refuses ci with no pull requests, and takes it beside them", async () => {
    const before = unwrap(await listWorkspaces(spine.db)).length;
    const refused = await call("POST", "/projects", {
      ...REQUEST,
      name: "e2e-ci-no",
      repo_url: "https://example.com/e2e-ci-no.git",
      qa: CI,
    });
    const error = await expectError(refused, 400, "validation");
    expect(error.message).toBe(QA_CI_NEEDS_PR);
    expect(unwrap(await listWorkspaces(spine.db))).toHaveLength(before);

    const made = await call("POST", "/projects", {
      ...REQUEST,
      name: "e2e-ci",
      repo_url: "https://example.com/e2e-ci.git",
      qa: CI,
      delivery: PR,
    });
    expect(made.status).toBe(201);
    const listed = ProjectsView.parse(
      await (await call("GET", "/projects")).json(),
    ).projects.find((p) => p.id === "e2e-ci");
    expect(listed?.qa).toMatchObject(CI);
  });

  test("create refuses a required check whose repo prefix is not one of the project's", async () => {
    const res = await call("POST", "/projects", {
      ...REQUEST,
      name: "e2e-ci-prefix",
      repo_url: "https://example.com/e2e-ci-prefix.git",
      qa: { ...CI, ci_checks: ["nope:build"] },
      delivery: PR,
    });
    const error = await expectError(res, 400, "validation");
    expect(error.message).toContain("“nope:build” reads as repo “nope”");
    // The project's own repo as the prefix is taken.
    const made = await call("POST", "/projects", {
      ...REQUEST,
      name: "e2e-ci-prefix",
      repo_url: "https://example.com/e2e-ci-prefix.git",
      qa: { ...CI, ci_checks: ["e2e-ci-prefix:build"] },
      delivery: PR,
    });
    expect(made.status).toBe(201);
    // A repo-shaped prefix with nothing after it is refused by the wire schema itself.
    const empty = await call("PATCH", "/projects/e2e-ci-prefix", {
      qa: { ...CI, ci_checks: ["e2e-ci-prefix:"] },
    });
    expect(empty.status).toBe(400);
  });

  test("PATCH refuses ci without pull requests, and a delivery change away from them", async () => {
    expect(
      (
        await call("POST", "/projects", {
          ...REQUEST,
          name: "e2e-ci-patch",
          repo_url: "https://example.com/e2e-ci-patch.git",
        })
      ).status,
    ).toBe(201);
    const path = "/projects/e2e-ci-patch";
    const refused = await call("PATCH", path, { qa: CI });
    expect((await expectError(refused, 400, "validation")).message).toBe(
      QA_CI_NEEDS_PR,
    );
    expect((await call("PATCH", path, { qa: CI, delivery: PR })).status).toBe(
      200,
    );
    const away = await call("PATCH", path, {
      delivery: { mode: "push", when: "review_passed" },
    });
    expect((await expectError(away, 400, "validation")).message).toBe(
      QA_CI_NEEDS_PR,
    );
  });
});

// A project's push targets (039): read by Detect (writes nothing), set by PATCH with the other
// settings, audited `project.set`, and refused with core's one sentence for a bad target.
describe("push targets", () => {
  const CREATE: CreateProjectRequest = {
    name: "e2e-push",
    repo_url: "https://example.com/e2e-push.git",
    runner_id: "fixture",
    executor_id: "local",
    orchestrator: false,
    reviewer_runner_id: null,
  };

  beforeAll(async () => {
    expect((await call("POST", "/projects", CREATE)).status).toBe(201);
  });

  const pushOf = async (): Promise<unknown> =>
    ProjectsView.parse(
      await (await call("GET", "/projects")).json(),
    ).projects.find((p) => p.id === "e2e-push")?.repos[0]?.push_url;

  test("Detect on a URL project proposes nothing, says why, and writes nothing", async () => {
    const res = await call("POST", "/projects/e2e-push/push-targets/detect");
    expect(res.status).toBe(200);
    expect(PushTargetsDetected.parse(await res.json())).toEqual({
      targets: [
        {
          repo_id: "e2e-push",
          submodule_path: null,
          push_url: null,
          detected: null,
          warning:
            "this repo was not created from a folder: its origin already is its remote.",
        },
      ],
    });
    expect(await pushOf()).toBeNull();
  });

  test("Detect on an unknown project is 404", async () => {
    await expectError(
      await call("POST", "/projects/nope/push-targets/detect"),
      404,
      "not_found",
    );
  });

  test("PATCH sets a target, answers every repo's, and audits it", async () => {
    const target = "git@forge.example:owner/e2e-push.git";
    const res = await call("PATCH", "/projects/e2e-push", {
      push_urls: [{ repo_id: "e2e-push", push_url: target }],
    });
    expect(res.status).toBe(200);
    const state = ProjectSettingsState.parse(await res.json());
    expect(state.changed).toBe(true);
    expect(state.push_targets).toEqual([
      { repo_id: "e2e-push", submodule_path: null, push_url: target },
    ]);
    expect(await pushOf()).toBe(target);

    const audit = AuditPage.parse(
      await (await call("GET", "/audit?action=project.set")).json(),
    ).items.find((e) => e.target_id === "e2e-push");
    expect(audit?.payload).toEqual({
      push_urls: [{ repo_id: "e2e-push", push_url: target }],
    });
  });

  test.each([
    [
      "a local path",
      "/src/e2e-push",
      /must be an https:\/\/, ssh:\/\/ or git@host:path URL\./,
    ],
    ["an http URL", "http://forge.example/o/r.git", /must be an https:\/\//],
    [
      "a URL with credentials",
      "https://me:hunter2@forge.example/o/r.git",
      /must not carry credentials/,
    ],
  ])(
    "%s is refused 400, and nothing is written",
    async (_what, url, message) => {
      const before = await pushOf();
      const error = await expectError(
        await call("PATCH", "/projects/e2e-push", {
          push_urls: [{ repo_id: "e2e-push", push_url: url }],
        }),
        400,
        "validation",
      );
      expect(error.message).toMatch(message);
      expect(error.message).not.toContain("hunter2");
      expect(await pushOf()).toBe(before);
    },
  );

  test("another project's repo is refused 400", async () => {
    await expectError(
      await call("PATCH", "/projects/e2e-push", {
        push_urls: [{ repo_id: "e2e1", push_url: null }],
      }),
      400,
      "validation",
    );
  });
});

// A tier per step: set on create or by `PATCH /projects/:id`, answered back, listed by
// `GET /projects`, and audited naming only the steps that moved. A tier is one of three words; a
// step is one of three; anything else is 400 and writes nothing.
describe("step tiers", () => {
  const CREATE: CreateProjectRequest = {
    name: "e2e-steps",
    repo_url: "https://example.com/e2e-steps.git",
    runner_id: "fixture",
    executor_id: "local",
    orchestrator: false,
    step_tiers: { plan: "complex" },
  };

  beforeAll(async () => {
    expect((await call("POST", "/projects", CREATE)).status).toBe(201);
  });

  const stepsOf = async (): Promise<unknown> =>
    ProjectsView.parse(
      await (await call("GET", "/projects")).json(),
    ).projects.find((p) => p.id === "e2e-steps")?.step_tiers;

  const setsOf = async (): Promise<unknown[]> =>
    AuditPage.parse(await (await call("GET", "/audit?action=project.*")).json())
      .items.filter((a) => a.target_id === "e2e-steps")
      .map((a) => ({
        action: a.action,
        step_tiers: (a.payload as { step_tiers?: unknown } | null)?.step_tiers,
      }));

  test("create stores the steps it names; the rest inherit", async () => {
    expect(await stepsOf()).toEqual({ ...NO_STEP_TIERS, plan: "complex" });
  });

  test("PATCH round-trips: answered, listed, the same again changes nothing, null inherits", async () => {
    const res = await call("PATCH", "/projects/e2e-steps", {
      step_tiers: { build: "standard", review: "complex" },
    });
    expect(res.status).toBe(200);
    const state = ProjectSettingsState.parse(await res.json());
    expect(state).toMatchObject({
      project: "e2e-steps",
      changed: true,
      step_tiers: { plan: "complex", build: "standard", review: "complex" },
    });
    expect(await stepsOf()).toEqual(state.step_tiers);

    const again = await call("PATCH", "/projects/e2e-steps", {
      step_tiers: { review: "complex" },
    });
    expect(ProjectSettingsState.parse(await again.json()).changed).toBe(false);

    const inherit = await call("PATCH", "/projects/e2e-steps", {
      step_tiers: { plan: null },
    });
    expect(ProjectSettingsState.parse(await inherit.json())).toMatchObject({
      changed: true,
      step_tiers: { plan: null, build: "standard", review: "complex" },
    });
    // Newest first: each row names only the steps that moved.
    expect(await setsOf()).toEqual([
      { action: "project.set", step_tiers: { plan: null } },
      {
        action: "project.set",
        step_tiers: { build: "standard", review: "complex" },
      },
      {
        action: "project.create",
        step_tiers: { plan: "complex", build: null, review: null },
      },
    ]);
  });

  test.each([
    ["a tier that is not one", { step_tiers: { plan: "huge" } }],
    ["a step that is not one", { step_tiers: { deploy: "cheap" } }],
    ["no step at all", { step_tiers: {} }],
  ])("%s is 400 and writes nothing", async (_, body) => {
    const before = await stepsOf();
    await expectError(
      await call("PATCH", "/projects/e2e-steps", body),
      400,
      "validation",
    );
    expect(await stepsOf()).toEqual(before);
  });

  test("an unknown project is 404", async () => {
    await expectError(
      await call("PATCH", "/projects/no-such-project", {
        step_tiers: { plan: "cheap" },
      }),
      404,
      "not_found",
    );
  });
});

// Context compression: off by default, set through `PATCH /projects/:id` (and at
// creation), audited `project.set` / `project.create` with the change and nothing else.
describe("context compression", () => {
  const CREATE: CreateProjectRequest = {
    name: "e2e-ctx",
    repo_url: "https://example.com/e2e-ctx.git",
    runner_id: "fixture",
    executor_id: "local",
    orchestrator: false,
  };

  beforeAll(async () => {
    expect((await call("POST", "/projects", CREATE)).status).toBe(201);
    expect(
      (
        await call("POST", "/projects", {
          ...CREATE,
          name: "e2e-ctx-on",
          repo_url: "https://example.com/e2e-ctx-on.git",
          context_compression: true,
        })
      ).status,
    ).toBe(201);
  });

  const listed = async (id: string): Promise<unknown> =>
    ProjectsView.parse(
      await (await call("GET", "/projects")).json(),
    ).projects.find((p) => p.id === id)?.context_compression;

  const audits = async (id: string): Promise<unknown[]> =>
    AuditPage.parse(await (await call("GET", "/audit?action=project.*")).json())
      .items.filter((a) => a.target_id === id)
      .map((a) => ({ action: a.action, payload: a.payload }));

  test("off by default; a project created with it is on, and its create row says so", async () => {
    expect(await listed("e2e-ctx")).toBe(false);
    expect(await listed("e2e-ctx-on")).toBe(true);
    expect(await audits("e2e-ctx-on")).toMatchObject([
      {
        action: "project.create",
        payload: expect.objectContaining({ context_compression: true }),
      },
    ]);
    expect(
      (await audits("e2e-ctx")).map((a) => (a as { payload: object }).payload),
    ).not.toContainEqual(
      expect.objectContaining({ context_compression: true }),
    );
  });

  test("PATCH on, again, off: answered, listed, one audited project.set per change naming only it", async () => {
    const on = await call("PATCH", "/projects/e2e-ctx", {
      context_compression: true,
    });
    expect(on.status).toBe(200);
    expect(ProjectSettingsState.parse(await on.json())).toMatchObject({
      project: "e2e-ctx",
      context_compression: true,
      changed: true,
    });
    expect(await listed("e2e-ctx")).toBe(true);
    const again = await call("PATCH", "/projects/e2e-ctx", {
      context_compression: true,
    });
    expect(ProjectSettingsState.parse(await again.json()).changed).toBe(false);
    const off = await call("PATCH", "/projects/e2e-ctx", {
      context_compression: false,
    });
    expect(ProjectSettingsState.parse(await off.json())).toMatchObject({
      context_compression: false,
      changed: true,
    });
    expect(await listed("e2e-ctx")).toBe(false);
    // Newest first.
    expect(
      (await audits("e2e-ctx")).filter(
        (a) => (a as { action: string }).action === "project.set",
      ),
    ).toEqual([
      { action: "project.set", payload: { context_compression: false } },
      { action: "project.set", payload: { context_compression: true } },
    ]);
  });

  test("a switch that is not a boolean is 400 and writes nothing", async () => {
    await expectError(
      await call("PATCH", "/projects/e2e-ctx", { context_compression: "yes" }),
      400,
      "validation",
    );
    expect(await listed("e2e-ctx")).toBe(false);
  });
});
