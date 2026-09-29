// /folders over HTTP against a temp-file DB and real folders: "from this
// host" is the proxy's header on a loopback socket and nothing else; allowing appends and is
// audited; initialising touches only a folder with no commit inside an allowed one.
import { execFileSync } from "node:child_process";
import type { IncomingMessage } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, LOCAL_ROOTS_KEY, systemClock } from "@bayon/core";
import { getSettings, openDb, type Db } from "@bayon/db";
import {
  listAudit,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import {
  ApiErrorBody,
  FolderAllowed,
  FolderCheck,
  LOCAL_BROWSER_HEADER,
  ProjectCreated,
} from "@bayon/proto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { dbStore } from "../../db-store.js";
import { startApi, type RunningApi } from "../../server.js";
import { ProjectsService } from "../projects-service.js";
import { FrmHttpError } from "../../errors.js";
import { FoldersController } from "./folders.controller.js";
import {
  FOLDER_INIT_ACTION,
  FOLDER_INIT_START_ACTION,
  FoldersService,
} from "./folders-service.js";

const TOKEN = "e2e-folders-0123456789abcdef";
/** The host-only key the proxy would send (local-key.ts); a test value here. */
const KEY = "c0ffee".repeat(10) + "abcd";
const LOCAL = { [LOCAL_BROWSER_HEADER]: KEY };

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-C", cwd, ...args],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    },
  ).trim();

/** A non-loopback IPv4 address of this machine: only for the opt-in real-socket test. */
const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((i) => i !== undefined && i.family === "IPv4" && !i.internal)?.address;
const LAN_TESTS = process.env.FRM_LAN_TESTS === "1" && lanAddress !== undefined;

let spine: TempDb;
let apiDb: Db;
let api: RunningApi;
let dir: string;
/** The operator's home, for the "too wide" rule: the temp folder itself. */
let home: string;
let frmHome: string;
let folders: FoldersService;
let root: string;
let outside: string;

beforeAll(async () => {
  spine = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  unwrap(await seedSpine(spine.db, 1));
  apiDb = unwrap(await openDb({ path: spine.path, clock: systemClock }));
  dir = realpathSync(mkdtempSync(join(tmpdir(), "frm-folders-e2e-")));
  home = join(dir, "home");
  frmHome = join(home, "frm");
  mkdirSync(frmHome, { recursive: true });
  folders = new FoldersService({ db: apiDb, home, frmHome, localKey: KEY });
  api = await startApi({
    config: { token: TOKEN, host: "127.0.0.1", port: 0 },
    store: dbStore(apiDb),
    clock: systemClock,
    logger: false,
    projects: new ProjectsService({
      db: apiDb,
      clock: systemClock,
      mirrorsRoot: join(dir, "mirrors"),
    }),
    folders,
  });
});

afterAll(async () => {
  await api?.close();
  await apiDb?.close();
  spine?.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
beforeEach(async () => {
  n += 1;
  root = join(home, `work-${n}`);
  outside = join(home, `other-${n}`);
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  await setRoots(["/srv/kept", root]);
});

async function setRoots(roots: readonly string[]): Promise<void> {
  unwrap(
    await seedRows(spine.db, {
      settings: [
        {
          key: LOCAL_ROOTS_KEY,
          value_json: JSON.stringify(roots),
          updated_at: 1,
        },
      ],
    }),
  );
}

const roots = async () =>
  unwrap(await getSettings(apiDb, [LOCAL_ROOTS_KEY])).get(LOCAL_ROOTS_KEY);

const post = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  base = api.url,
): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });

async function refused(res: Response, status: number): Promise<string> {
  expect(res.status).toBe(status);
  return ApiErrorBody.parse(await res.json()).error.message;
}

const auditOf = async (action: string) =>
  unwrap(await listAudit(spine.db)).filter((row) => row.action === action);

describe("POST /folders/check", () => {
  test("to a browser elsewhere, a folder outside the roots is not_allowed with the command, and existing reads like missing", async () => {
    const there = FolderCheck.parse(
      await (await post("/folders/check", { path: outside })).json(),
    );
    expect(there).toMatchObject({
      state: "not_allowed",
      local: false,
      real_path: null,
      parent: null,
    });
    expect(there.allow_command).toBe(`pnpm frm roots add ${outside} --yes`);
    const missing = FolderCheck.parse(
      await (await post("/folders/check", { path: join(home, "nope") })).json(),
    );
    expect(missing.state).toBe("not_allowed");
    expect(missing.real_path).toBeNull();
  });

  test("to this host, a folder outside is not_allowed with its real path and parent; a missing one is missing", async () => {
    const there = FolderCheck.parse(
      await (await post("/folders/check", { path: outside }, LOCAL)).json(),
    );
    expect(there).toMatchObject({
      state: "not_allowed",
      local: true,
      real_path: outside,
      // Its parent is the home folder: never offered.
      parent: null,
    });
    const nested = join(outside, "app");
    mkdirSync(nested);
    expect(
      FolderCheck.parse(
        await (await post("/folders/check", { path: nested }, LOCAL)).json(),
      ).parent,
    ).toBe(outside);
    expect(
      FolderCheck.parse(
        await (
          await post("/folders/check", { path: join(home, "nope") }, LOCAL)
        ).json(),
      ).state,
    ).toBe("missing");
  });

  test.each([
    ["an empty folder", "empty", () => undefined, "not_repo_empty"],
    [
      "a folder with files",
      "files",
      (p: string) => writeFileSync(join(p, "a.txt"), "x"),
      "not_repo_files",
    ],
    [
      "a repo with no commits",
      "fresh",
      (p: string) => git(p, "init", "-q", "-b", "main"),
      "no_commits",
    ],
    [
      "a ready repo",
      "ready",
      (p: string) => {
        git(p, "init", "-q", "-b", "main");
        git(p, "commit", "-q", "--allow-empty", "-m", "one");
      },
      "ready",
    ],
  ])("inside the roots, %s", async (_n, name, make, state) => {
    const path = join(root, name);
    mkdirSync(path);
    make(path);
    const check = FolderCheck.parse(
      await (await post("/folders/check", { path })).json(),
    );
    expect(check).toMatchObject({ state, real_path: path });
  });

  test("a relative path is refused in plain words", async () => {
    expect(
      await refused(await post("/folders/check", { path: "ttm" }), 400),
    ).toMatch(/^That is not a full folder path/);
  });
});

describe("POST /folders/allow", () => {
  test("from this host: the folder is appended, the roots already there kept, and the change audited", async () => {
    const before = (await auditOf("settings.put")).length;
    const res = await post(
      "/folders/allow",
      { path: outside, expect_root: outside },
      LOCAL,
    );
    expect(res.status).toBe(200);
    expect(FolderAllowed.parse(await res.json())).toEqual({
      root: outside,
      roots: ["/srv/kept", root, outside],
      changed: true,
    });
    expect(await roots()).toEqual(["/srv/kept", root, outside]);
    const rows = await auditOf("settings.put");
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({
      actor: "operator",
      target_id: LOCAL_ROOTS_KEY,
    });
    expect(JSON.parse(rows.at(-1)?.payload_json ?? "null")).toEqual({
      path: outside,
      scope: "folder",
      via: "gui-local",
      from: ["/srv/kept", root],
      to: ["/srv/kept", root, outside],
    });
  });

  test("the parent, when asked for", async () => {
    const nested = join(outside, "app");
    mkdirSync(nested);
    const res = await post(
      "/folders/allow",
      { path: nested, scope: "parent", expect_root: outside },
      LOCAL,
    );
    expect(FolderAllowed.parse(await res.json()).root).toBe(outside);
  });

  test("refused when the folder is no longer the one the confirm showed", async () => {
    const nested = join(outside, "app");
    mkdirSync(nested);
    expect(
      await refused(
        await post(
          "/folders/allow",
          { path: nested, scope: "parent", expect_root: nested },
          LOCAL,
        ),
        400,
      ),
    ).toMatch(/^The folder changed since you confirmed/);
    expect(await roots()).toEqual(["/srv/kept", root]);
  });

  test.each([
    ["Bayon's own folder", () => frmHome, /Bayon's own folder/],
    ["a folder inside it", () => join(frmHome, "logs"), /Bayon's own folder/],
    ["~/.ssh", () => join(home, ".ssh"), /~\/\.ssh/],
    [
      "a folder inside ~/Library",
      () => join(home, "Library", "x"),
      /~\/Library/,
    ],
  ])("%s is never allowed", async (_n, where, says) => {
    const path = where();
    mkdirSync(path, { recursive: true });
    expect(
      await refused(
        await post("/folders/allow", { path, expect_root: path }, LOCAL),
        400,
      ),
    ).toMatch(says);
    expect(await roots()).toEqual(["/srv/kept", root]);
  });

  test("the home folder, or a parent that is the home folder, is refused", async () => {
    expect(
      await refused(
        await post(
          "/folders/allow",
          { path: outside, scope: "parent", expect_root: home },
          LOCAL,
        ),
        400,
      ),
    ).toMatch(/whole home folder/);
    expect(
      await refused(
        await post("/folders/allow", { path: home, expect_root: home }, LOCAL),
        400,
      ),
    ).toMatch(/whole home folder/);
    expect(await roots()).toEqual(["/srv/kept", root]);
  });

  test("without the proxy's header it is refused (403), writing nothing, and says what to run", async () => {
    const before = (await auditOf("settings.put")).length;
    const message = await refused(
      await post("/folders/allow", { path: outside, expect_root: outside }),
      403,
    );
    expect(message).toMatch(/^Only a browser on the machine Bayon runs on/);
    expect(message).toContain(`pnpm frm roots add ${outside} --yes`);
    expect(message).not.toMatch(/§|BAYON-/);
    expect(await roots()).toEqual(["/srv/kept", root]);
    expect(await auditOf("settings.put")).toHaveLength(before);
  });

  test("with a header that is not the key it is refused the same way", async () => {
    await refused(
      await post(
        "/folders/allow",
        { path: outside, expect_root: outside },
        { [LOCAL_BROWSER_HEADER]: "1" },
      ),
      403,
    );
    expect(await roots()).toEqual(["/srv/kept", root]);
  });

  test("the key from a LAN peer (a request whose socket is not loopback) gets 403 and writes nothing", async () => {
    const before = (await auditOf("settings.put")).length;
    const controller = new FoldersController(folders);
    const lanRequest = {
      socket: { remoteAddress: "192.0.2.10" },
      headers: { ...LOCAL, origin: "http://192.0.2.10:5173" },
    } as unknown as IncomingMessage;
    const thrown = await controller
      .allow(lanRequest, {
        path: outside,
        scope: "folder",
        expect_root: outside,
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(thrown).toBeInstanceOf(FrmHttpError);
    expect((thrown as FrmHttpError).status).toBe(403);
    expect(await roots()).toEqual(["/srv/kept", root]);
    expect(await auditOf("settings.put")).toHaveLength(before);
  });

  // A real socket from this machine's LAN address: opt-in, since it listens on every interface.
  test.runIf(LAN_TESTS)(
    "over a real LAN socket the key is ignored (FRM_LAN_TESTS=1)",
    async () => {
      const lan = await startApi({
        config: { token: TOKEN, host: "0.0.0.0", port: 0 },
        store: dbStore(apiDb),
        clock: systemClock,
        logger: false,
        folders,
      });
      try {
        const base = lan.url.replace(/\/\/[^/:]+:/, `//${lanAddress ?? ""}:`);
        await refused(
          await post(
            "/folders/allow",
            { path: outside, expect_root: outside },
            LOCAL,
            base,
          ),
          403,
        );
        expect(await roots()).toEqual(["/srv/kept", root]);
      } finally {
        await lan.close();
      }
    },
  );
});

describe("a symlink inside an allowed folder that points out of it", () => {
  test("check: outside the roots, and to this host its real path, not the link", async () => {
    const link = join(root, "link");
    symlinkSync(outside, link);
    expect(
      FolderCheck.parse(
        await (await post("/folders/check", { path: link })).json(),
      ),
    ).toMatchObject({ state: "not_allowed", real_path: null });
    expect(
      FolderCheck.parse(
        await (await post("/folders/check", { path: link }, LOCAL)).json(),
      ),
    ).toMatchObject({ state: "not_allowed", real_path: outside });
  });

  test("allow: what is added is the real folder the confirm named, never the link", async () => {
    const link = join(root, "link");
    symlinkSync(outside, link);
    await refused(
      await post("/folders/allow", { path: link, expect_root: link }, LOCAL),
      400,
    );
    const res = await post(
      "/folders/allow",
      { path: link, expect_root: outside },
      LOCAL,
    );
    expect(FolderAllowed.parse(await res.json()).root).toBe(outside);
    expect(await roots()).toEqual(["/srv/kept", root, outside]);
  });

  test("init: refused, and the folder it points to is left untouched", async () => {
    const link = join(root, "link");
    symlinkSync(outside, link);
    expect(
      await refused(await post("/folders/init", { path: link }, LOCAL), 400),
    ).toMatch(/^Agents are not allowed to use/);
    expect(existsSync(join(outside, ".git"))).toBe(false);
  });

  test("an allowed folder stored as a link is skipped: nothing inside it counts as allowed", async () => {
    const alias = join(home, `alias-${n}`);
    symlinkSync(root, alias);
    await setRoots([alias]);
    const inside = join(root, "app");
    mkdirSync(inside);
    expect(
      FolderCheck.parse(
        await (await post("/folders/check", { path: inside }, LOCAL)).json(),
      ).state,
    ).toBe("not_allowed");
  });
});

describe("POST /folders/init", () => {
  test("an empty folder becomes a repo with one empty commit, audited, and then a project", async () => {
    const path = join(root, "ttm");
    mkdirSync(path);
    const res = await post("/folders/init", { path });
    expect(res.status).toBe(200);
    expect(FolderCheck.parse(await res.json())).toMatchObject({
      state: "ready",
      branch: "main",
    });
    expect(git(path, "ls-tree", "HEAD")).toBe("");
    const intent = await auditOf(FOLDER_INIT_START_ACTION);
    expect(intent.at(-1)).toMatchObject({
      actor: "operator",
      target_kind: "folder",
      target_id: path,
    });
    const rows = await auditOf(FOLDER_INIT_ACTION);
    expect(rows.at(-1)?.id ?? 0).toBeGreaterThan(intent.at(-1)?.id ?? 0);
    expect(rows.at(-1)).toMatchObject({
      actor: "operator",
      target_kind: "folder",
      target_id: path,
    });
    expect(JSON.parse(rows.at(-1)?.payload_json ?? "null")).toMatchObject({
      path,
      outcome: "done",
      created_repo: true,
      branch: "main",
      commit: git(path, "rev-parse", "HEAD"),
    });
    const created = await post("/projects", {
      name: `ttm${n}`,
      repo_url: path,
      runner_id: "fixture",
      executor_id: "local",
    });
    expect(created.status).toBe(201);
    ProjectCreated.parse(await created.json());
  });

  test("a folder with files: nothing of theirs is committed", async () => {
    const path = join(root, "files");
    mkdirSync(path);
    writeFileSync(join(path, "notes.md"), "mine");
    expect((await post("/folders/init", { path })).status).toBe(200);
    expect(git(path, "ls-tree", "HEAD")).toBe("");
    expect(git(path, "status", "--porcelain")).toBe("?? notes.md");
  });

  test("a repo with commits is refused and left as it was", async () => {
    const path = join(root, "ready");
    mkdirSync(path);
    git(path, "init", "-q", "-b", "main");
    git(path, "commit", "-q", "--allow-empty", "-m", "one");
    const head = git(path, "rev-parse", "HEAD");
    expect(await refused(await post("/folders/init", { path }), 400)).toMatch(
      /already has commits/,
    );
    expect(git(path, "rev-parse", "HEAD")).toBe(head);
    expect(
      JSON.parse(
        (await auditOf(FOLDER_INIT_ACTION)).at(-1)?.payload_json ?? "null",
      ),
    ).toMatchObject({ path, outcome: "refused" });
  });

  test("a folder outside the roots is refused, even from this host, and left untouched", async () => {
    const before = (await auditOf(FOLDER_INIT_ACTION)).length;
    expect(
      await refused(await post("/folders/init", { path: outside }, LOCAL), 400),
    ).toMatch(/^Agents are not allowed to use/);
    expect(() => git(outside, "rev-parse", "--git-dir")).toThrow();
    expect(await auditOf(FOLDER_INIT_ACTION)).toHaveLength(before);
  });
});
