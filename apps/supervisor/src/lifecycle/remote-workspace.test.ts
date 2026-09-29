// The workspace step's container side, run here with the local
// shell and git: the same fixed script and argv the container runs, against real bare mirrors.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  WORKSPACE_SH,
  parseWorkspaceOutput,
  workspaceArgv,
  workspaceStepProblem,
  type WorkspaceStep,
} from "./remote-workspace.js";

const PATH = process.env["PATH"] ?? "/usr/bin:/bin";
const base = realpathSync(mkdtempSync(join(tmpdir(), "frm-rws-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const GIT_ENV = {
  PATH,
  HOME: base,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "frm",
  GIT_AUTHOR_EMAIL: "frm@example.invalid",
  GIT_COMMITTER_NAME: "frm",
  GIT_COMMITTER_EMAIL: "frm@example.invalid",
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

/** A source repo with one commit of `file`, and its bare mirror under remote/mirror. */
function repo(
  name: string,
  file = "README.md",
): {
  src: string;
  mirror: string;
} {
  const src = join(base, "src", name);
  mkdirSync(src, { recursive: true });
  git(src, "init", "-q", "-b", "main");
  writeFileSync(join(src, file), `${name}\n`);
  git(src, "add", ".");
  git(src, "commit", "-q", "-m", name);
  return { src, mirror: join(base, "remote", "mirror", `${name}.git`) };
}
const bare = (r: { src: string; mirror: string }) =>
  git(base, "clone", "-q", "--bare", r.src, r.mirror);

const work = repo("repo_1", "DOCTRINE.md");
writeFileSync(join(work.src, "DOCTRINE.md"), "doctrine\n");
git(work.src, "commit", "-q", "-am", "base");
const baseSha = git(work.src, "rev-parse", "HEAD");
writeFileSync(join(work.src, "DOCTRINE.md"), "doctrine, revised\n");
git(work.src, "commit", "-q", "-am", "head");
const headSha = git(work.src, "rev-parse", "HEAD");
bare(work);
const mirror = work.mirror;

// A second repo, and a superproject with a nested submodule: super → libs/mid → vendor/leaf.
const lib = repo("lib");
bare(lib);
const leaf = repo("leaf");
bare(leaf);
const mid = repo("mid");
git(
  mid.src,
  "-c",
  "protocol.file.allow=always",
  "submodule",
  "add",
  "-q",
  leaf.src,
  "vendor/leaf",
);
git(mid.src, "commit", "-q", "-m", "leaf");
bare(mid);
const sup = repo("super");
git(
  sup.src,
  "-c",
  "protocol.file.allow=always",
  "submodule",
  "add",
  "-q",
  mid.src,
  "libs/mid",
);
git(sup.src, "commit", "-q", "-m", "mid");
bare(sup);
const midSha = git(sup.src, "rev-parse", "HEAD:libs/mid");
const leafSha = git(mid.src, "rev-parse", "HEAD:vendor/leaf");

/** A session root, as its container sees it. */
function session(id: string) {
  const root = join(base, "remote", "work", id);
  mkdirSync(root, { recursive: true });
  return {
    root,
    home: join(root, ".frm", "home"),
    tmp: join(root, ".frm", "tmp"),
  };
}

const run = (cwd: string, argv: readonly [string, ...string[]]): string =>
  execFileSync(argv[0], argv.slice(1), {
    cwd,
    env: { PATH, HOME: base },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

describe("the workspace step's fixed script", () => {
  test("dirs mode makes the private home and tmp (0700), and nothing else", () => {
    const s = session("S0");
    expect(run(s.root, workspaceArgv(s, { mode: "dirs" }))).toBe("");
    for (const dir of [s.home, s.tmp]) {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect(readdirSync(s.root)).toEqual([".frm"]);
  });

  test("branch mode: a clone borrowing the mirror's objects, a new branch at the base, .foreman/ excluded", () => {
    const s = session("S1");
    const dest = join(s.root, "repo");
    const out = run(
      s.root,
      workspaceArgv(s, {
        mode: "branch",
        clones: [{ mirror, dest, rev: baseSha, branch: "frm/S1" }],
      }),
    );
    expect([...parseWorkspaceOutput(out)]).toEqual([[dest, baseSha]]);
    expect(
      readFileSync(join(dest, ".git", "objects", "info", "alternates"), "utf8")
        .trim()
        .split("\n"),
    ).toEqual([join(mirror, "objects")]);
    expect(git(dest, "rev-parse", "--abbrev-ref", "HEAD")).toBe("frm/S1");
    expect(readFileSync(join(dest, "DOCTRINE.md"), "utf8")).toBe("doctrine\n");
    expect(
      readFileSync(join(dest, ".git", "info", "exclude"), "utf8"),
    ).toContain("\n.foreman/\n");
    expect(existsSync(s.home)).toBe(true);
  });

  test("detached mode checks a pinned commit out, on no branch", () => {
    const s = session("S2");
    const dest = join(s.root, "repo");
    const out = run(
      s.root,
      workspaceArgv(s, {
        mode: "detached",
        clones: [{ mirror, dest, rev: headSha, branch: "" }],
      }),
    );
    expect(parseWorkspaceOutput(out).get(dest)).toBe(headSha);
    expect(git(dest, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(readFileSync(join(dest, "DOCTRINE.md"), "utf8")).toBe(
      "doctrine, revised\n",
    );
  });

  test("a multi-repo step clones every repo as a sibling under the root", () => {
    const s = session("S4");
    const app = join(s.root, "app");
    const other = join(s.root, "lib");
    const libSha = git(lib.src, "rev-parse", "HEAD");
    const out = run(
      s.root,
      workspaceArgv(s, {
        mode: "branch",
        clones: [
          { mirror, dest: app, rev: baseSha, branch: "frm/S4" },
          { mirror: lib.mirror, dest: other, rev: libSha, branch: "frm/S4" },
        ],
      }),
    );
    expect([...parseWorkspaceOutput(out)]).toEqual([
      [app, baseSha],
      [other, libSha],
    ]);
    expect(git(other, "rev-parse", "--abbrev-ref", "HEAD")).toBe("frm/S4");
  });

  test("submodules, nested ones too, come from their mirrors at the gitlinks, on the session's branch", () => {
    const s = session("S5");
    const dest = join(s.root, "super");
    const supSha = git(sup.src, "rev-parse", "HEAD");
    const out = run(
      s.root,
      workspaceArgv(s, {
        mode: "branch",
        clones: [{ mirror: sup.mirror, dest, rev: supSha, branch: "frm/S5" }],
        submodules: [
          {
            parent: "",
            name: "libs/mid",
            path: "libs/mid",
            mirror: mid.mirror,
            sha: midSha,
          },
          {
            parent: "libs/mid",
            name: "vendor/leaf",
            path: "vendor/leaf",
            mirror: leaf.mirror,
            sha: leafSha,
          },
        ],
      }),
    );
    expect([...parseWorkspaceOutput(out)]).toEqual([
      [dest, supSha],
      ["libs/mid", midSha],
      ["libs/mid/vendor/leaf", leafSha],
    ]);
    const nested = join(dest, "libs", "mid", "vendor", "leaf");
    expect(readFileSync(join(nested, "README.md"), "utf8")).toBe("leaf\n");
    expect(git(nested, "rev-parse", "--abbrev-ref", "HEAD")).toBe("frm/S5");
    // -c-only registration: nothing in the superproject clone's config names a submodule.
    expect(() =>
      git(dest, "config", "--local", "--get-regexp", "^submodule\\."),
    ).toThrow();
  });

  test("a mirror that is not there fails the step", () => {
    const s = session("S3");
    expect(() =>
      run(
        s.root,
        workspaceArgv(s, {
          mode: "branch",
          clones: [
            {
              mirror: join(base, "remote", "mirror", "missing.git"),
              dest: join(s.root, "repo"),
              rev: baseSha,
              branch: "frm/S3",
            },
          ],
        }),
      ),
    ).toThrow();
  });

  test("a short tuple, or a submodule path climbing out, is refused by the script itself (L1)", () => {
    const s = session("S6");
    const short: [string, ...string[]] = [
      "/bin/sh",
      "-c",
      WORKSPACE_SH,
      "frm-workspace",
      s.home,
      s.tmp,
      "branch",
      mirror,
      join(s.root, "x"),
    ];
    expect(() => run(s.root, short)).toThrow(/a clone takes 4 arguments/);
    const supSha = git(sup.src, "rev-parse", "HEAD");
    expect(() =>
      run(
        s.root,
        workspaceArgv(s, {
          mode: "branch",
          clones: [
            {
              mirror: sup.mirror,
              dest: join(s.root, "super"),
              rev: supSha,
              branch: "frm/S6",
            },
          ],
          submodules: [
            {
              parent: "",
              name: "x",
              path: "../../escape",
              mirror: mid.mirror,
              sha: midSha,
            },
          ],
        }),
      ),
    ).toThrow(/a submodule path is a relative path/);
  });
});

describe("workspaceStepProblem (L1: the argv is checked before any exec)", () => {
  const root = "/frm/s/S";
  const clone = {
    mirror: "/m/r.git",
    dest: `${root}/r`,
    rev: baseSha,
    branch: "frm/S",
  };
  type Cloning = Exclude<WorkspaceStep, { mode: "dirs" }>;
  const step = (over: Partial<Cloning> = {}): WorkspaceStep => ({
    mode: "branch",
    clones: [clone],
    ...over,
  });

  test("a clean step passes, dirs mode always", () => {
    expect(workspaceStepProblem(root, step())).toBeNull();
    expect(workspaceStepProblem(root, { mode: "dirs" })).toBeNull();
  });

  test.each([
    [{ clones: [] }, "no repo to clone"],
    [
      { clones: [{ ...clone, dest: "/elsewhere/r" }] },
      'destination "/elsewhere/r" is not under /frm/s/S',
    ],
    [
      { clones: [{ ...clone, dest: `${root}/a/../../b` }] },
      `destination "${root}/a/../../b" is not under /frm/s/S`,
    ],
    [{ clones: [{ ...clone, rev: "HEAD" }] }, 'rev "HEAD" is not an object id'],
    [
      { clones: [{ ...clone, branch: "main" }] },
      'branch "main" does not fit branch',
    ],
    [
      {
        submodules: [
          {
            parent: "",
            name: "a=b",
            path: "p",
            mirror: "/m/p.git",
            sha: midSha,
          },
        ],
      },
      `submodule name "a=b" contains '='`,
    ],
    [
      {
        submodules: [
          {
            parent: "",
            name: "p",
            path: "../p",
            mirror: "/m/p.git",
            sha: midSha,
          },
        ],
      },
      `submodule path "../p" has a '.' or '..' segment`,
    ],
    [
      {
        submodules: [
          {
            parent: "-x",
            name: "p",
            path: "p",
            mirror: "/m/p.git",
            sha: midSha,
          },
        ],
      },
      `submodule parent "-x" has a segment starting with '-'`,
    ],
  ] as [Partial<Cloning>, string][])("%j is refused: %s", (over, why) => {
    expect(workspaceStepProblem(root, step(over))).toBe(why);
  });
});
