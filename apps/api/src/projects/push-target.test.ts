import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, LOCAL_ROOTS_KEY } from "@bayon/core";
import { getRepo } from "@bayon/db";
import {
  listAudit,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import type { CreateProjectRequest } from "@bayon/proto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runGit } from "../tickets/git-facts.js";
import { ProjectsService } from "./projects-service.js";
import { detectPushUrl } from "./push-target.js";

// A folder project's push target (migration 039), against real git repositories in a temp folder:
// read from the folder's own origin at creation (and each submodule checkout's own origin), with
// any credential taken out before it is stored or shown; and re-read, never saved, by Detect.

/** git with no global or system config, so the operator's own never runs here. */
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

function repoAt(dir: string, branch = "main"): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", branch);
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
}

const SECRET = "hunter2-not-a-real-token";
const REMOTE = "https://forge.example/an-owner/app.git";

let dir: string;
let root: string;
let t: TempDb;
let service: ProjectsService;

beforeEach(async () => {
  // Real: an allowed folder is used only when it is its own real path (macOS: /var → /private/var).
  dir = realpathSync(mkdtempSync(join(tmpdir(), "frm-push-")));
  root = join(dir, "allowed");
  mkdirSync(root, { recursive: true });
  t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  unwrap(await seedSpine(t.db, 1));
  unwrap(
    await seedRows(t.db, {
      settings: [
        {
          key: LOCAL_ROOTS_KEY,
          value_json: JSON.stringify([root]),
          updated_at: 1,
        },
      ],
    }),
  );
  service = new ProjectsService({
    db: t.db,
    clock: new FakeClock(1_700_000_000_000),
    mirrorsRoot: "/home/frm/mirrors",
  });
});

afterEach(() => {
  t.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const REQUEST: CreateProjectRequest = {
  name: "demo",
  repo_url: "/placeholder",
  runner_id: "fixture",
  executor_id: "local",
  orchestrator: false,
  reviewer_runner_id: null,
};

const create = (repoUrl: string) =>
  service.create({ ...REQUEST, repo_url: repoUrl });

describe("detectPushUrl", () => {
  const detect = (folder: string) => detectPushUrl(runGit(), folder);

  test("an https origin is the target, as the folder spells it", async () => {
    const app = join(root, "app");
    repoAt(app);
    git(app, "remote", "add", "origin", REMOTE);
    expect(await detect(app)).toEqual({ push_url: REMOTE, warning: null });
  });

  test("an scp-like ssh origin is the target", async () => {
    const app = join(root, "app");
    repoAt(app);
    git(app, "remote", "add", "origin", "git@forge.example:an-owner/app.git");
    expect((await detect(app)).push_url).toBe(
      "git@forge.example:an-owner/app.git",
    );
  });

  test("no origin is no target, and nothing to warn about", async () => {
    const app = join(root, "app");
    repoAt(app);
    expect(await detect(app)).toEqual({ push_url: null, warning: null });
  });

  test("a credential in the origin is taken out, and the warning never repeats it", async () => {
    const app = join(root, "app");
    repoAt(app);
    git(
      app,
      "remote",
      "add",
      "origin",
      `https://someone:${SECRET}@forge.example/an-owner/app.git`,
    );
    const found = await detect(app);
    expect(found.push_url).toBe(REMOTE);
    expect(found.warning).toMatch(/carried credentials; they were removed/);
    expect(JSON.stringify(found)).not.toContain(SECRET);
    expect(JSON.stringify(found)).not.toContain("someone");
  });

  test("a folder whose origin is another folder has no target, and says so", async () => {
    const app = join(root, "app");
    repoAt(app);
    git(app, "remote", "add", "origin", join(dir, "upstream"));
    const found = await detect(app);
    expect(found.push_url).toBeNull();
    expect(found.warning).toMatch(
      /is not an https:\/\/, ssh:\/\/ or git@host:path remote/,
    );
  });

  test("an http origin with a credential: no target, and the credential is not echoed", async () => {
    const app = join(root, "app");
    repoAt(app);
    git(
      app,
      "remote",
      "add",
      "origin",
      `http://someone:${SECRET}@forge.example/o/app.git`,
    );
    const found = await detect(app);
    expect(found.push_url).toBeNull();
    expect(found.warning).not.toContain(SECRET);
  });

  test("a folder git cannot read at all warns without git's words", async () => {
    const found = await detect(join(dir, "not-a-repo"));
    expect(found.push_url).toBeNull();
    expect(found.warning).toMatch(/its origin could not be read/);
  });
});

describe("at creation", () => {
  test("a single folder records its own origin as the push target", async () => {
    const app = join(root, "app");
    repoAt(app);
    git(app, "remote", "add", "origin", REMOTE);
    const created = unwrap(await create(app));
    expect(created.warnings).toEqual([]);
    expect(unwrap(await getRepo(t.db, "demo"))).toMatchObject({
      origin_url: realpathSync.native(app),
      push_url: REMOTE,
    });
    const audit = unwrap(await listAudit(t.db)).at(-1);
    expect(JSON.parse(audit?.payload_json ?? "null")).toMatchObject({
      push_url: REMOTE,
    });
  });

  test("credentials are stripped before storing, and the create answer warns", async () => {
    const app = join(root, "app");
    repoAt(app);
    git(
      app,
      "remote",
      "add",
      "origin",
      `https://${SECRET}@forge.example/an-owner/app.git`,
    );
    const created = unwrap(await create(app));
    expect(created.warnings).toHaveLength(1);
    expect(created.warnings[0]).toMatch(/carried credentials/);
    expect(unwrap(await getRepo(t.db, "demo")).push_url).toBe(REMOTE);
    // Nowhere in the database: not the row, not the audit.
    const audit = JSON.stringify(unwrap(await listAudit(t.db)));
    expect(audit).not.toContain(SECRET);
    expect(JSON.stringify(created)).not.toContain(SECRET);
  });

  test("a folder with no origin records none, with no warning", async () => {
    const app = join(root, "app");
    repoAt(app);
    const created = unwrap(await create(app));
    expect(created.warnings).toEqual([]);
    expect(unwrap(await getRepo(t.db, "demo")).push_url).toBeNull();
  });

  test("a submodule project reads each submodule checkout's own origin", async () => {
    const webSrc = join(dir, "src-web");
    const apiSrc = join(dir, "src-api");
    repoAt(webSrc, "master");
    repoAt(apiSrc);
    const umbrella = join(root, "umbrella");
    repoAt(umbrella, "trunk");
    git(umbrella, "submodule", "add", "-q", webSrc, "Web");
    git(umbrella, "submodule", "add", "-q", apiSrc, "Api");
    git(umbrella, "commit", "-q", "-m", "subs");
    git(
      umbrella,
      "remote",
      "add",
      "origin",
      "git@forge.example:o/umbrella.git",
    );
    // Each checkout's origin was the local source it was added from; the owner re-points them.
    git(
      join(umbrella, "Web"),
      "remote",
      "set-url",
      "origin",
      "https://forge.example/o/web.git",
    );
    git(
      join(umbrella, "Api"),
      "remote",
      "set-url",
      "origin",
      `ssh://git:${SECRET}@forge.example/o/api.git`,
    );

    const created = unwrap(await create(umbrella));
    expect(created.submodule_repo_ids.toSorted()).toEqual([
      "demo-api",
      "demo-web",
    ]);
    expect(unwrap(await getRepo(t.db, "demo")).push_url).toBe(
      "git@forge.example:o/umbrella.git",
    );
    expect(unwrap(await getRepo(t.db, "demo-web"))).toMatchObject({
      origin_url: realpathSync.native(join(umbrella, "Web")),
      push_url: "https://forge.example/o/web.git",
    });
    // The ssh password is gone; the login stays.
    expect(unwrap(await getRepo(t.db, "demo-api")).push_url).toBe(
      "ssh://git@forge.example/o/api.git",
    );
    expect(created.warnings).toHaveLength(1);
    expect(created.warnings[0]).toMatch(/Api: its origin carried credentials/);
    expect(JSON.stringify(unwrap(await listAudit(t.db)))).not.toContain(SECRET);
  });

  test("a submodule whose origin is still a local folder gets no target, and a warning", async () => {
    const webSrc = join(dir, "src-web");
    repoAt(webSrc, "master");
    const umbrella = join(root, "umbrella");
    repoAt(umbrella, "trunk");
    git(umbrella, "submodule", "add", "-q", webSrc, "Web");
    git(umbrella, "commit", "-q", "-m", "web");

    const created = unwrap(await create(umbrella));
    expect(unwrap(await getRepo(t.db, "demo-web")).push_url).toBeNull();
    expect(created.warnings).toHaveLength(1);
    expect(created.warnings[0]).toMatch(/Web: its origin .* is not an https/);
  });
});

describe("Detect", () => {
  test("proposes each folder's origin now, beside the stored target, and writes nothing", async () => {
    const app = join(root, "app");
    repoAt(app);
    unwrap(await create(app));
    const audited = unwrap(await listAudit(t.db)).length;
    // The owner adds a remote after the project was created.
    git(
      app,
      "remote",
      "add",
      "origin",
      `https://x:${SECRET}@forge.example/o/app.git`,
    );

    const found = unwrap(await service.detectPushTargets("demo"));
    expect(found.targets).toEqual([
      {
        repo_id: "demo",
        submodule_path: null,
        push_url: null,
        detected: "https://forge.example/o/app.git",
        warning: expect.stringMatching(/carried credentials/),
      },
    ]);
    expect(JSON.stringify(found)).not.toContain(SECRET);
    expect(unwrap(await getRepo(t.db, "demo")).push_url).toBeNull();
    expect(unwrap(await listAudit(t.db))).toHaveLength(audited);
  });

  test("a folder with no origin says so", async () => {
    const app = join(root, "app");
    repoAt(app);
    unwrap(await create(app));
    const found = unwrap(await service.detectPushTargets("demo"));
    expect(found.targets[0]).toMatchObject({
      detected: null,
      warning: expect.stringMatching(/has no origin remote\./),
    });
  });

  test("a folder no longer allowed is not read", async () => {
    const app = join(root, "app");
    repoAt(app);
    git(app, "remote", "add", "origin", REMOTE);
    unwrap(await create(app));
    unwrap(
      await seedRows(t.db, {
        settings: [
          {
            key: LOCAL_ROOTS_KEY,
            value_json: JSON.stringify([join(dir, "elsewhere")]),
            updated_at: 2,
          },
        ],
      }),
    );
    const found = unwrap(await service.detectPushTargets("demo"));
    expect(found.targets[0]?.detected).toBeNull();
    expect(found.targets[0]?.warning).toMatch(
      /^Agents are not allowed to use /,
    );
  });
});
