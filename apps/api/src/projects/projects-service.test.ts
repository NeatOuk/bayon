import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, LOCAL_ROOTS_KEY, workspaceLayout } from "@bayon/core";
import {
  getAgent,
  getProfile,
  getRepo,
  getWorkspace,
  getWorkspaceRepos,
} from "@bayon/db";
import {
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import type { CreateProjectRequest } from "@bayon/proto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ProjectsService } from "./projects-service.js";

/** git with no global or system config, so the operator's own (hooks, signing) never runs here. */
const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "-c",
      "protocol.file.allow=always",
      "-C",
      cwd,
      ...args,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    },
  );

/** A repo at `dir` with one commit, on `branch`. */
function repoAt(dir: string, branch = "main"): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", branch);
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
}

// projects-service.test.ts: ProjectsService's refusals and its happy path, against a fixture db
// (no HTTP; projects.e2e.test.ts covers the wire).

let t: TempDb;
let service: ProjectsService;

beforeEach(async () => {
  t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  // The `fixture` runner and `local` executor a project's agents point at.
  unwrap(await seedSpine(t.db, 1));
  service = new ProjectsService({
    db: t.db,
    clock: new FakeClock(1_700_000_000_000),
    mirrorsRoot: "/home/frm/mirrors",
  });
});
afterEach(() => t.cleanup());

const REQUEST: CreateProjectRequest = {
  name: "demo",
  repo_url: "https://example.com/demo.git",
  runner_id: "fixture",
  executor_id: "local",
  orchestrator: true,
};

test("an unregistered runner is validation, not not_found", async () => {
  const result = await service.create({ ...REQUEST, runner_id: "nobody" });
  expect(result).toMatchObject({ ok: false, error: { class: "validation" } });
});

test("an unregistered reviewer runner is validation", async () => {
  const result = await service.create({
    ...REQUEST,
    reviewer_runner_id: "nobody",
  });
  expect(result).toMatchObject({ ok: false, error: { class: "validation" } });
});

test("a disabled executor is validation, not not_found", async () => {
  unwrap(
    await seedRows(t.db, {
      executors: [{ id: "off", kind: "local", config_json: "{}", enabled: 0 }],
    }),
  );
  const result = await service.create({ ...REQUEST, executor_id: "off" });
  expect(result).toMatchObject({ ok: false, error: { class: "validation" } });
});

test("an absent executor is validation", async () => {
  const result = await service.create({ ...REQUEST, executor_id: "nowhere" });
  expect(result).toMatchObject({ ok: false, error: { class: "validation" } });
});

test("an existing repo id is conflict", async () => {
  unwrap(await service.create(REQUEST));
  const result = await service.create(REQUEST);
  expect(result).toMatchObject({ ok: false, error: { class: "conflict" } });
});

test("a bad name is validation, before any read", async () => {
  const result = await service.create({ ...REQUEST, name: "Demo" });
  expect(result).toMatchObject({ ok: false, error: { class: "validation" } });
});

test("a bad repo_url is validation", async () => {
  const result = await service.create({ ...REQUEST, repo_url: "/local/path" });
  expect(result).toMatchObject({ ok: false, error: { class: "validation" } });
});

test("without FRM_HOME (no mirrorsRoot) every create is refused", async () => {
  const noHome = new ProjectsService({
    db: t.db,
    clock: new FakeClock(1_700_000_000_000),
    mirrorsRoot: null,
  });
  const result = await noHome.create(REQUEST);
  expect(result).toMatchObject({ ok: false, error: { class: "validation" } });
});

test("a happy path returns ids a direct read confirms were written", async () => {
  const result = await service.create(REQUEST);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value).toEqual({
    repo_id: "demo",
    workspace_id: "demo",
    builder_agent_id: "demo-builder",
    orchestrator_agent_id: "demo-orchestrator",
    reviewer_agent_id: "demo-reviewer",
    submodule_repo_ids: [],
    warnings: [],
  });
  expect(unwrap(await getRepo(t.db, "demo"))).toMatchObject({
    origin_url: "https://example.com/demo.git",
    push_url: null,
    mirror_path: "/home/frm/mirrors/demo.git",
  });
  expect(unwrap(await getAgent(t.db, "demo-builder"))).toMatchObject({
    kind: "builder",
    runner_id: "fixture",
  });
  expect(unwrap(await getProfile(t.db, "demo-build"))).toMatchObject({
    runner_id: "fixture",
  });
});

test("no orchestrator, no reviewer: those ids are null and no rows exist for them", async () => {
  const result = await service.create({
    ...REQUEST,
    orchestrator: false,
    reviewer_runner_id: null,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.orchestrator_agent_id).toBeNull();
  expect(result.value.reviewer_agent_id).toBeNull();
  expect((await getAgent(t.db, "demo-orchestrator")).ok).toBe(false);
  expect((await getAgent(t.db, "demo-reviewer")).ok).toBe(false);
});

describe("a folder as the repo (projects.local_roots, §14)", () => {
  // tmpdir is a symlink on macOS (/var -> /private/var): the allowed folder is named through it,
  // so these also hold that both sides are compared as real paths.
  let dir: string;
  let root: string;
  let repo: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "frm-roots-"));
    root = join(dir, "allowed");
    repo = join(root, "app");
    repoAt(repo);
    repoAt(join(dir, "elsewhere"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const allow = async (...roots: string[]) =>
    unwrap(
      await seedRows(t.db, {
        settings: [
          {
            key: LOCAL_ROOTS_KEY,
            value_json: JSON.stringify(roots),
            updated_at: 1,
          },
        ],
      }),
    );
  const refusal = async (repoUrl: string): Promise<string> => {
    const result = await service.create({ ...REQUEST, repo_url: repoUrl });
    expect(result).toMatchObject({ ok: false, error: { class: "validation" } });
    expect((await getRepo(t.db, "demo")).ok).toBe(false); // nothing written
    return result.ok ? "" : result.error.message;
  };

  test("with no folder allowed, a path is refused and the refusal names the command", async () => {
    expect(await refusal(repo)).toContain(
      `frm settings set ${LOCAL_ROOTS_KEY}`,
    );
  });

  test("a git repo inside an allowed folder is created, keeping its real path", async () => {
    await allow(root);
    unwrap(await service.create({ ...REQUEST, repo_url: repo }));
    expect(unwrap(await getRepo(t.db, "demo")).origin_url).toBe(
      realpathSync(repo),
    );
  });

  test("the allowed folder itself may be the repo", async () => {
    git(root, "init", "-q", "-b", "main");
    git(root, "commit", "-q", "--allow-empty", "-m", "root");
    await allow(root);
    expect((await service.create({ ...REQUEST, repo_url: root })).ok).toBe(
      true,
    );
  });

  test("any allowed folder admits, and one that no longer exists is skipped", async () => {
    await allow(join(dir, "gone"), join(dir, "elsewhere"));
    expect(
      (await service.create({ ...REQUEST, repo_url: join(dir, "elsewhere") }))
        .ok,
    ).toBe(true);
  });

  test("an allowed folder named through a symlink admits what is really inside it", async () => {
    symlinkSync(root, join(dir, "alias"));
    await allow(join(dir, "alias"));
    unwrap(await service.create({ ...REQUEST, repo_url: repo }));
    expect(unwrap(await getRepo(t.db, "demo")).origin_url).toBe(
      realpathSync(repo),
    );
  });

  test("on a case-insensitive disk, a path typed in another case is inside", async () => {
    const upper = repo.toUpperCase();
    // A case-sensitive disk (Linux) has no such path: nothing to hold there.
    if (!existsSync(upper)) return;
    await allow(root);
    unwrap(await service.create({ ...REQUEST, repo_url: upper }));
    expect(unwrap(await getRepo(t.db, "demo")).origin_url).toBe(
      realpathSync.native(repo),
    );
  });

  test("outside every allowed folder is refused", async () => {
    await allow(root);
    await refusal(join(dir, "elsewhere"));
  });

  test("a sibling that shares the folder's name as a prefix is outside it", async () => {
    repoAt(join(`${root}-evil`, "app"));
    await allow(root);
    await refusal(join(`${root}-evil`, "app"));
  });

  test("a symlink inside an allowed folder that points out of it is refused", async () => {
    symlinkSync(join(dir, "elsewhere"), join(root, "link"));
    await allow(root);
    await refusal(join(root, "link"));
  });

  test("a .. walk out of an allowed folder is refused", async () => {
    await allow(root);
    await refusal(join(root, "..", "elsewhere"));
  });

  test("a missing path gets the same answer as one outside, so the route is no oracle", async () => {
    await allow(root);
    const missing = await refusal(join(root, "nope"));
    const outside = await refusal(join(dir, "elsewhere"));
    expect(missing.replace(join(root, "nope"), "P")).toBe(
      outside.replace(join(dir, "elsewhere"), "P"),
    );
  });

  test("a folder that is not a git repo is refused", async () => {
    mkdirSync(join(root, "plain"));
    await allow(root);
    expect(await refusal(join(root, "plain"))).toContain(
      "not a git repository",
    );
  });

  describe("with submodules, one submodule workspace (§3.1)", () => {
    let umbrella: string;
    let web: string;
    beforeEach(() => {
      web = join(dir, "src-web");
      repoAt(web, "master");
      umbrella = join(root, "kite");
      repoAt(umbrella, "trunk");
      git(umbrella, "submodule", "add", "-q", web, "Web");
      git(umbrella, "commit", "-q", "-m", "web");
    });

    test("the folder is the primary and each submodule a dep, in a layout the supervisor accepts", async () => {
      await allow(root);
      const created = unwrap(
        await service.create({ ...REQUEST, repo_url: umbrella }),
      );
      expect(created.submodule_repo_ids).toEqual(["demo-web"]);
      expect(unwrap(await getWorkspace(t.db, "demo")).kind).toBe("submodule");
      const layout = workspaceLayout(
        "submodule",
        unwrap(await getWorkspaceRepos(t.db, "demo")),
      );
      expect(layout.ok).toBe(true);
      expect(unwrap(await getRepo(t.db, "demo"))).toMatchObject({
        has_submodules: 1,
        default_base_branch: "trunk", // the folder's own branch, none asked for
      });
      expect(unwrap(await getRepo(t.db, "demo-web"))).toMatchObject({
        origin_url: realpathSync.native(join(umbrella, "Web")),
        default_base_branch: "master",
        mirror_path: "/home/frm/mirrors/demo-web.git",
      });
    });

    test("an explicit base branch wins over the folder's", async () => {
      await allow(root);
      unwrap(
        await service.create({
          ...REQUEST,
          repo_url: umbrella,
          base_branch: "release",
        }),
      );
      expect(unwrap(await getRepo(t.db, "demo")).default_base_branch).toBe(
        "release",
      );
    });

    test("a submodule not checked out in the folder is refused", async () => {
      const fresh = join(root, "fresh");
      git(root, "clone", "-q", umbrella, fresh);
      await allow(root);
      expect(await refusal(fresh)).toContain("submodule Web");
      expect((await getRepo(t.db, "demo-web")).ok).toBe(false);
    });

    test("a submodule whose folder links out of the allowed ones is refused", async () => {
      rmSync(join(umbrella, "Web"), { recursive: true, force: true });
      symlinkSync(join(dir, "elsewhere"), join(umbrella, "Web"));
      await allow(root);
      expect(await refusal(umbrella)).toContain("submodule Web");
    });

    test("a submodule with submodules of its own is refused", async () => {
      const leaf = join(dir, "src-leaf");
      repoAt(leaf);
      const mid = join(dir, "src-mid");
      repoAt(mid);
      git(mid, "submodule", "add", "-q", leaf, "leaf");
      git(mid, "commit", "-q", "-m", "leaf");
      git(umbrella, "submodule", "add", "-q", mid, "Mid");
      git(umbrella, "commit", "-q", "-m", "mid");
      await allow(root);
      expect(await refusal(umbrella)).toContain("submodules of its own");
    });

    test("an [include] in .gitmodules is never followed, so no file outside is read", async () => {
      // Followed, the included file would add a submodule Evil, missing here, and refuse.
      writeFileSync(
        join(dir, "evil.conf"),
        '[submodule "Evil"]\n\tpath = Evil\n\turl = /nowhere\n',
      );
      appendFileSync(
        join(umbrella, ".gitmodules"),
        `[include]\n\tpath = ${join(dir, "evil.conf")}\n`,
      );
      git(umbrella, "commit", "-q", "-am", "include");
      await allow(root);
      const created = unwrap(
        await service.create({ ...REQUEST, repo_url: umbrella }),
      );
      expect(created.submodule_repo_ids).toEqual(["demo-web"]);
    });

    test("a submodule checked out detached takes a branch it really has as its base", async () => {
      // `git submodule update --init` leaves each submodule on no branch; the column's `main`
      // default would then be fetched at every spawn from a repo that has no main.
      const dev = join(dir, "src-dev");
      repoAt(dev, "develop");
      git(umbrella, "submodule", "add", "-q", dev, "Dev");
      git(umbrella, "commit", "-q", "-m", "dev");
      const fresh = join(root, "fresh");
      git(root, "clone", "-q", umbrella, fresh);
      git(fresh, "submodule", "update", "-q", "--init");
      expect(() =>
        git(join(fresh, "Dev"), "symbolic-ref", "-q", "HEAD"),
      ).toThrow(); // really detached
      await allow(root);
      unwrap(await service.create({ ...REQUEST, repo_url: fresh }));
      expect(unwrap(await getRepo(t.db, "demo-dev")).default_base_branch).toBe(
        "develop",
      );
      expect(unwrap(await getRepo(t.db, "demo-web")).default_base_branch).toBe(
        "master",
      );
    });

    test("a pinned commit on no branch or tag of the submodule is refused", async () => {
      const sub = join(umbrella, "Web");
      git(sub, "checkout", "-q", "--detach");
      git(sub, "commit", "-q", "--allow-empty", "-m", "loose");
      git(umbrella, "commit", "-q", "-am", "pin loose");
      git(sub, "checkout", "-q", "master");
      await allow(root);
      expect(await refusal(umbrella)).toContain("on no branch or tag");
    });
  });

  test("a folder on no branch, with no main or master, needs a base branch asked for", async () => {
    const odd = join(root, "odd");
    repoAt(odd, "trunk");
    git(odd, "checkout", "-q", "--detach");
    await allow(root);
    expect(await refusal(odd)).toContain("give a base branch");
    unwrap(
      await service.create({ ...REQUEST, repo_url: odd, base_branch: "trunk" }),
    );
  });

  test("a malformed setting is refused, not read as allowing anything", async () => {
    await allow("relative/path");
    expect(await refusal(repo)).toContain(LOCAL_ROOTS_KEY);
  });
});
