import { FakeClock, workspaceLayout } from "@bayon/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  listAudit,
  listCommands,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
  type TempDb,
} from "../testing.js";
import {
  getAgent,
  getProfile,
  getRepo,
  getWorkspace,
  getWorkspaceRepos,
} from "./config.js";
import { listRepos, listWorkspaces } from "./registry-reads.js";
import { createProject, type NewProject } from "./project-create.js";

let t: TempDb;
beforeEach(async () => {
  t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  // The runner and executor rows a project's agents point at, as a booted supervisor leaves them.
  unwrap(await seedSpine(t.db, 1));
});
afterEach(() => t.cleanup());

const HASH = "0".repeat(64);

function newProject(o: Partial<NewProject> = {}): NewProject {
  return {
    name: "demo",
    runner: "fixture",
    executor: "local",
    reviewerRunner: "fixture",
    repo: {
      id: "demo",
      name: "demo",
      origin_url: "https://example.com/demo.git",
      mirror_path: "/home/frm/mirrors/demo.git",
    },
    workspace: { id: "demo", name: "demo", kind: "single" },
    workspaceRepo: { workspace_id: "demo", repo_id: "demo", rel_path: "demo" },
    submodules: [],
    profiles: [
      {
        id: "demo-build",
        name: "demo-build",
        runner_id: "fixture",
        model_tier: "standard",
        version: 1,
        hash: HASH,
        created_at: 1_000,
      },
      {
        id: "demo-review",
        name: "demo-review",
        runner_id: "fixture",
        model_tier: "standard",
        version: 1,
        hash: HASH,
        created_at: 1_000,
      },
    ],
    agents: [
      {
        id: "demo-builder",
        name: "demo-builder",
        kind: "builder",
        runner_id: "fixture",
        executor_id: "local",
        profile_id: "demo-build",
        workspace_id: "demo",
        created_at: 1_000,
      },
      {
        id: "demo-reviewer",
        name: "demo-reviewer",
        kind: "reviewer",
        runner_id: "fixture",
        executor_id: "local",
        profile_id: "demo-review",
        workspace_id: "demo",
        created_at: 1_000,
      },
    ],
    ...o,
  };
}

test("writes exactly the five tables' rows plus one audit_log row, in one transaction", async () => {
  const written = await createProject(t.db, newProject());
  expect(written.ok).toBe(true);

  expect(unwrap(await getRepo(t.db, "demo"))).toMatchObject({
    origin_url: "https://example.com/demo.git",
  });
  expect(unwrap(await getWorkspace(t.db, "demo"))).toMatchObject({
    kind: "single",
  });
  expect(unwrap(await getWorkspaceRepos(t.db, "demo"))).toMatchObject([
    { id: "demo" },
  ]);
  expect(unwrap(await getProfile(t.db, "demo-build"))).toMatchObject({
    runner_id: "fixture",
  });
  expect(unwrap(await getProfile(t.db, "demo-review"))).toMatchObject({
    runner_id: "fixture",
  });
  const builder = unwrap(await getAgent(t.db, "demo-builder"));
  expect(builder).toMatchObject({ kind: "builder", workspace_id: "demo" });
  expect(builder.mission_id).toBeNull();
  const reviewer = unwrap(await getAgent(t.db, "demo-reviewer"));
  expect(reviewer.mission_id).toBeNull();

  const audit = unwrap(await listAudit(t.db));
  expect(audit).toHaveLength(1);
  const [entry] = audit;
  expect(entry).toMatchObject({
    actor: "operator",
    action: "project.create",
    target_kind: "project",
    target_id: "demo",
  });
  expect(JSON.parse(entry?.payload_json ?? "null")).toEqual({
    via: "rest",
    repo: "https://example.com/demo.git",
    runner: "fixture",
    executor: "local",
    reviewer_runner: "fixture",
    agents: ["demo-builder", "demo-reviewer"],
  });

  // Never touched: commands, and no other project's rows.
  expect(unwrap(await listCommands(t.db))).toEqual([]);
});

test("a duplicate repo id is conflict; nothing is written", async () => {
  unwrap(await createProject(t.db, newProject()));
  const repoCountBefore = unwrap(await listRepos(t.db)).length;
  const workspaceCountBefore = unwrap(await listWorkspaces(t.db)).length;
  const auditCountBefore = unwrap(await listAudit(t.db)).length;

  const again = await createProject(
    t.db,
    newProject({
      workspace: { id: "demo-2", name: "demo-2", kind: "single" },
      workspaceRepo: {
        workspace_id: "demo-2",
        repo_id: "demo",
        rel_path: "demo-2",
      },
      profiles: [],
      agents: [],
    }),
  );
  expect(again.ok).toBe(false);
  if (!again.ok) expect(again.error.class).toBe("conflict");
  expect(unwrap(await listRepos(t.db))).toHaveLength(repoCountBefore);
  expect(unwrap(await listWorkspaces(t.db))).toHaveLength(workspaceCountBefore);
  expect(unwrap(await listAudit(t.db))).toHaveLength(auditCountBefore);
  expect((await getWorkspace(t.db, "demo-2")).ok).toBe(false);
});

test("the reserved mirror prefix is refused before anything is written", async () => {
  const refused = await createProject(
    t.db,
    newProject({
      name: "frm-demo",
      repo: {
        id: "frm-demo",
        name: "frm-demo",
        origin_url: "https://example.com/demo.git",
        mirror_path: "/home/frm/mirrors/frm-demo.git",
      },
      workspace: { id: "frm-demo", name: "frm-demo", kind: "single" },
      workspaceRepo: {
        workspace_id: "frm-demo",
        repo_id: "frm-demo",
        rel_path: "frm-demo",
      },
    }),
  );
  expect(refused.ok).toBe(false);
  if (!refused.ok) {
    expect(refused.error.class).toBe("validation");
    expect(refused.error.message).toContain("reserved");
  }
  expect((await getRepo(t.db, "frm-demo")).ok).toBe(false);
  expect(unwrap(await listAudit(t.db))).toEqual([]);
});

test("no orchestrator, no reviewer: exactly the rows given, agents.mission_id absent from every row", async () => {
  const solo = newProject({
    profiles: [
      {
        id: "demo-build",
        name: "demo-build",
        runner_id: "fixture",
        model_tier: "standard",
        version: 1,
        hash: HASH,
        created_at: 1_000,
      },
    ],
    agents: [
      {
        id: "demo-builder",
        name: "demo-builder",
        kind: "builder",
        runner_id: "fixture",
        executor_id: "local",
        profile_id: "demo-build",
        workspace_id: "demo",
        created_at: 1_000,
      },
    ],
  });
  unwrap(await createProject(t.db, solo));
  expect((await getProfile(t.db, "demo-review")).ok).toBe(false);
  expect((await getAgent(t.db, "demo-reviewer")).ok).toBe(false);
  expect(unwrap(await getAgent(t.db, "demo-builder")).mission_id).toBeNull();
});

/** A submodule workspace: the primary and one dep, as the route builds them. */
const withSubmodule = (depId = "demo-web"): NewProject =>
  newProject({
    repo: {
      id: "demo",
      name: "demo",
      origin_url: "/src/demo",
      mirror_path: "/home/frm/mirrors/demo.git",
      has_submodules: 1,
    },
    workspace: { id: "demo", name: "demo", kind: "submodule" },
    workspaceRepo: {
      workspace_id: "demo",
      repo_id: "demo",
      rel_path: "demo",
      role: "primary",
    },
    submodules: [
      {
        repo: {
          id: depId,
          name: depId,
          origin_url: "/src/demo/web",
          mirror_path: `/home/frm/mirrors/${depId}.git`,
          default_base_branch: "master",
        },
        workspaceRepo: {
          workspace_id: "demo",
          repo_id: depId,
          rel_path: "demo/web",
          role: "dep",
          submodule_path: "web",
        },
      },
    ],
  });

test("a submodule workspace's deps are written with it, in a layout the supervisor accepts", async () => {
  unwrap(await createProject(t.db, withSubmodule()));
  const rows = unwrap(await getWorkspaceRepos(t.db, "demo"));
  const layout = workspaceLayout("submodule", rows);
  expect(layout.ok).toBe(true);
  expect(unwrap(await getRepo(t.db, "demo-web"))).toMatchObject({
    origin_url: "/src/demo/web",
    default_base_branch: "master",
  });
  const audit = unwrap(await listAudit(t.db)).at(-1);
  expect(JSON.parse(audit?.payload_json ?? "null")).toMatchObject({
    submodules: ["/src/demo/web"],
  });
});

test("a dep id that already exists writes nothing at all", async () => {
  unwrap(
    await seedRows(t.db, {
      repos: [
        { id: "demo-web", name: "demo-web", mirror_path: "/m/demo-web.git" },
      ],
    }),
  );
  const refused = await createProject(t.db, withSubmodule());
  expect(refused.ok).toBe(false);
  expect((await getRepo(t.db, "demo")).ok).toBe(false);
  expect((await getWorkspace(t.db, "demo")).ok).toBe(false);
});

test("a reserved dep id is refused before anything is written", async () => {
  const refused = await createProject(t.db, withSubmodule("frm-web"));
  expect(refused).toMatchObject({ ok: false, error: { class: "validation" } });
  expect((await getRepo(t.db, "demo")).ok).toBe(false);
});

test("each repo's push target is written with it, and the audit row names them (039)", async () => {
  const base = withSubmodule();
  const [dep] = base.submodules;
  if (dep === undefined) throw new Error("fixture has a submodule");
  unwrap(
    await createProject(t.db, {
      ...base,
      repo: { ...base.repo, push_url: "git@forge.example:owner/demo.git" },
      submodules: [
        {
          ...dep,
          repo: {
            ...dep.repo,
            push_url: "https://forge.example/owner/web.git",
          },
        },
      ],
    }),
  );
  expect(unwrap(await getRepo(t.db, "demo")).push_url).toBe(
    "git@forge.example:owner/demo.git",
  );
  expect(unwrap(await getRepo(t.db, "demo-web")).push_url).toBe(
    "https://forge.example/owner/web.git",
  );
  const audit = unwrap(await listAudit(t.db)).at(-1);
  expect(JSON.parse(audit?.payload_json ?? "null")).toMatchObject({
    push_url: "git@forge.example:owner/demo.git",
    submodule_push_urls: ["https://forge.example/owner/web.git"],
  });
});

test("a project with no push target records none", async () => {
  unwrap(await createProject(t.db, withSubmodule()));
  expect(unwrap(await getRepo(t.db, "demo")).push_url).toBeNull();
  const audit = unwrap(await listAudit(t.db)).at(-1);
  expect(JSON.parse(audit?.payload_json ?? "null")).not.toHaveProperty(
    "push_url",
  );
});
