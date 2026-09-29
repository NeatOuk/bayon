// The hardened repo-local config of a mirror, against real git: the claim is what
// ends up written in `<mirror>/config`, which a mock could not tell us.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "@bayon/core";
import { afterAll, describe, expect, test } from "vitest";
import {
  hardenMirrorConfig,
  MIRROR_FETCH_REFSPEC,
  parseConfigList,
  plannedMirrorConfig,
  unsafeMirrorKey,
  type ConfigEntry,
  type MirrorConfigCtx,
} from "./mirror-config.js";
import { redactedConfigKey } from "@bayon/core";
import { DEFAULT_SETTINGS } from "./settings.js";

const T0 = 1_700_000_000_000;
const PATH = process.env["PATH"] ?? "/usr/bin:/bin";
const root = mkdtempSync(join(tmpdir(), "frm-mirror-config-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ctx: MirrorConfigCtx = {
  settings: { ...DEFAULT_SETTINGS, "workspace.git_timeout_ms": 30_000 },
  clock: new FakeClock(T0),
  path: PATH,
};
const live = (): AbortSignal => new AbortController().signal;
/** A repo row with no origin_url: the mirror's remote is left as it stands, and given no refspec. */
const NO_ORIGIN = { originUrl: null } as const;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let repos = 0;
/** A real bare repository, with `extra` written into its own config. */
function bare(extra: readonly (readonly [string, string])[] = []): string {
  repos += 1;
  const dir = join(root, `r${String(repos)}`);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet", "--bare", "--template=", dir);
  for (const [key, value] of extra) git(dir, "config", "--local", key, value);
  return dir;
}

const listed = (dir: string): string[] =>
  git(dir, "config", "--local", "--list")
    .split("\n")
    .filter((line) => line !== "");

/** What a fresh `git init --bare` writes here: platform-dependent, so read, never assumed. */
const PRISTINE = new Set(listed(bare()));

/** Its repo-local config, minus every line a pristine bare repository also has. */
const ownKeys = (dir: string): string[] =>
  listed(dir).filter((line) => !PRISTINE.has(line));

describe("which repo-local keys a mirror may not keep", () => {
  test("every key that runs a program or redirects a remote, whatever its case or subsection", () => {
    for (const key of [
      "filter.lfs.clean",
      "filter.lfs.smudge",
      "filter.x.process",
      "url.https://evil.example/.insteadof",
      "url.https://Evil.Example/.pushinsteadof",
      "core.sshcommand",
      "core.gitproxy",
      "core.alternaterefscommand",
      "diff.external",
      "diff.pdf.textconv",
      "diff.pdf.command",
      "uploadpack.packobjectshook",
      "remote.origin.uploadpack",
      "remote.other.receivepack",
      "remote.origin.proxy",
      // The review of an earlier change. An include names another file whose keys git honours in full and
      // a --local listing never shows; the credential family and an askpass run a program on any
      // authenticated transport; the http family decides where an https fetch really goes; the
      // hook path and the merge driver run in the *agent's* git, which carries no -c of ours.
      "include.path",
      "includeIf.gitdir:/srv/.path",
      "credential.helper",
      "credential.https://github.com.helper",
      "core.askpass",
      "core.pager",
      "core.editor",
      "core.hookspath",
      "core.fsmonitor",
      "http.proxy",
      "http.https://evil.example.proxy",
      "http.sslverify",
      "merge.p.driver",
      "mergetool.p.cmd",
      "difftool.p.cmd",
      "pager.log",
      "alias.x",
      "sequence.editor",
      "gpg.program",
      "protocol.ext.allow",
      // The remote section is an allowlist: only origin's URL and the fetch refspec survive.
      "remote.origin.pushurl",
      "remote.origin.mirror",
      "remote.origin.tagopt",
      "remote.evil.url",
    ]) {
      expect(unsafeMirrorKey(key)).toBe(true);
    }
  });

  test("what a mirror legitimately holds is left alone", () => {
    for (const key of [
      "core.bare",
      "core.repositoryformatversion",
      "gc.worktreepruneexpire",
      "remote.origin.url",
      "remote.origin.fetch",
      "submodule.lib.url",
      // Not refused: unsetting it can move core.bare out from under a mirror that already has a
      // config.worktree. The per-worktree files are hardened by name instead (mirror-config.ts).
      "extensions.worktreeconfig",
      "status.showuntrackedfiles",
      "filterbranch.keep", // a section merely starting with one of the names
      "urls.x.y",
      "includes.x.y",
      "diff.renames",
      "merge.ff",
    ]) {
      expect(unsafeMirrorKey(key)).toBe(false);
    }
  });

  test("a logged key keeps its section and its final key, and loses the middle", () => {
    // The base of a url.<base>.insteadOf is commonly spelled with a token in it (Invariant 11).
    expect(
      redactedConfigKey(
        "url.https://x-access-token:s3cret@github.com/.insteadof",
      ),
    ).toBe("url.*.insteadof");
    expect(redactedConfigKey("core.sshcommand")).toBe("core.sshcommand");
    expect(redactedConfigKey("include.path")).toBe("include.path");
    expect(redactedConfigKey("bare")).toBe("bare");
  });
});

test("git's -z listing: NUL between entries, newline between key and value; a valueless key", () => {
  expect(
    parseConfigList("core.bare\ntrue\0filter.x.smudge\nsed -e s/a/b/\0gc.x\0"),
  ).toEqual([
    { key: "core.bare", value: "true" },
    { key: "filter.x.smudge", value: "sed -e s/a/b/" },
    { key: "gc.x", value: "" },
  ]);
  expect(parseConfigList("")).toEqual([]);
});

describe("the plan", () => {
  const hardened: readonly ConfigEntry[] = [
    { key: "core.bare", value: "true" },
    { key: "gc.worktreepruneexpire", value: "never" },
  ];

  test("unsets every unsafe key by git's own spelling, then sets what is missing", () => {
    expect(
      plannedMirrorConfig(
        [
          { key: "core.bare", value: "true" },
          { key: "filter.p.smudge", value: "sh -c 'touch /tmp/frm-pwned'" },
          { key: "filter.p.clean", value: "cat" },
          { key: "url.https://Evil.example/.insteadof", value: "https://gh/" },
          { key: "core.sshcommand", value: "sh -c 'touch /tmp/frm-pwned'" },
          { key: "submodule.lib.url", value: "/srv/lib" },
        ],
        NO_ORIGIN,
      ),
    ).toEqual([
      { op: "unset", key: "core.sshcommand" },
      { op: "unset", key: "filter.p.clean" },
      { op: "unset", key: "filter.p.smudge" },
      { op: "unset", key: "url.https://Evil.example/.insteadof" },
      { op: "set", key: "gc.worktreePruneExpire", value: "never" },
    ]);
  });

  test("an already hardened config plans nothing: the second pass writes nothing at all", () => {
    expect(plannedMirrorConfig(hardened, NO_ORIGIN)).toEqual([]);
    expect(
      plannedMirrorConfig(
        [
          ...hardened,
          { key: "remote.origin.url", value: "/srv/src/r" },
          { key: "remote.origin.fetch", value: MIRROR_FETCH_REFSPEC },
        ],
        { originUrl: "/srv/src/r" },
      ),
    ).toEqual([]);
  });

  test("a mirror clone's own defaults go: the destructive push flag, the refspec, the tag option", () => {
    expect(
      plannedMirrorConfig(
        [
          { key: "remote.origin.url", value: "/srv/src/r" },
          { key: "remote.origin.tagopt", value: "--no-tags" },
          { key: "remote.origin.fetch", value: "+refs/*:refs/*" },
          { key: "remote.origin.mirror", value: "true" },
          { key: "gc.worktreepruneexpire", value: "never" },
        ],
        { originUrl: "/srv/src/r" },
      ),
    ).toEqual([
      { op: "unset", key: "remote.origin.mirror" },
      { op: "unset", key: "remote.origin.tagopt" },
      { op: "set", key: "remote.origin.fetch", value: MIRROR_FETCH_REFSPEC },
    ]);
  });

  test("a mirror with no origin is given no refspec: there is no remote to fetch from", () => {
    expect(
      plannedMirrorConfig([{ key: "core.bare", value: "true" }], NO_ORIGIN),
    ).toEqual([{ op: "set", key: "gc.worktreePruneExpire", value: "never" }]);
  });

  test("a key held twice, or held with the wrong value, is replaced once", () => {
    expect(
      plannedMirrorConfig(
        [
          { key: "gc.worktreepruneexpire", value: "never" },
          { key: "gc.worktreepruneexpire", value: "3.months.ago" },
        ],
        NO_ORIGIN,
      ),
    ).toEqual([{ op: "set", key: "gc.worktreePruneExpire", value: "never" }]);
    expect(plannedMirrorConfig([], NO_ORIGIN)).toEqual([
      { op: "set", key: "gc.worktreePruneExpire", value: "never" },
    ]);
  });
});

describe("hardenMirrorConfig on real git", { timeout: 30_000 }, () => {
  test("the config it writes, in full; and a second pass changes nothing", async () => {
    const dir = bare([
      ["filter.p.smudge", "sh -c 'touch /tmp/frm-pwned'"],
      ["filter.p.clean", "cat"],
      ["url.https://evil.example/.insteadOf", "https://github.com/"],
      ["core.sshCommand", "sh -c 'touch /tmp/frm-pwned'"],
      ["uploadpack.packObjectsHook", "/tmp/frm-pwned"],
      ["submodule.lib.url", "/srv/lib"],
    ]);
    const first = await hardenMirrorConfig(ctx, dir, NO_ORIGIN, live());
    expect(first).toEqual({
      ok: true,
      value: [
        { op: "unset", key: "core.sshcommand" },
        { op: "unset", key: "filter.p.clean" },
        { op: "unset", key: "filter.p.smudge" },
        { op: "unset", key: "uploadpack.packobjectshook" },
        { op: "unset", key: "url.https://evil.example/.insteadof" },
        { op: "set", key: "gc.worktreePruneExpire", value: "never" },
      ],
    });
    // The written file itself, not the fact that a write was attempted.
    expect(ownKeys(dir)).toEqual([
      "submodule.lib.url=/srv/lib",
      "gc.worktreepruneexpire=never",
    ]);
    expect(await hardenMirrorConfig(ctx, dir, NO_ORIGIN, live())).toEqual({
      ok: true,
      value: [],
    });
    expect(ownKeys(dir)).toEqual([
      "submodule.lib.url=/srv/lib",
      "gc.worktreepruneexpire=never",
    ]);
  });

  test("a key held twice is removed in full, and a wrong value replaced, not appended", async () => {
    const dir = bare([
      ["gc.worktreePruneExpire", "3.months.ago"],
      ["diff.external", "/tmp/frm-pwned"],
    ]);
    git(dir, "config", "--local", "--add", "filter.p.smudge", "one");
    git(dir, "config", "--local", "--add", "filter.p.smudge", "two");
    expect(await hardenMirrorConfig(ctx, dir, NO_ORIGIN, live())).toMatchObject(
      {
        ok: true,
      },
    );
    expect(ownKeys(dir)).toEqual(["gc.worktreepruneexpire=never"]);
  });

  test("a mirror clone and a bare clone end the pass with the same config", async () => {
    const src = join(root, "src");
    mkdirSync(src, { recursive: true });
    git(src, "init", "--quiet", "-b", "main", src);
    writeFileSync(join(src, "README.md"), "hello\n");
    git(
      src,
      "-c",
      "user.email=t@e",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "one",
    );
    const mirrored = join(root, "mirrored.git");
    const bared = join(root, "bared.git");
    git(root, "clone", "--quiet", "--mirror", src, mirrored);
    git(root, "clone", "--quiet", "--bare", src, bared);
    // Before the pass they differ in exactly the three keys a mirror clone writes.
    expect(ownKeys(mirrored)).not.toEqual(ownKeys(bared));
    for (const dir of [mirrored, bared]) {
      expect(
        await hardenMirrorConfig(ctx, dir, { originUrl: src }, live()),
      ).toMatchObject({
        ok: true,
      });
    }
    const expected = [
      `remote.origin.url=${src}`,
      `remote.origin.fetch=${MIRROR_FETCH_REFSPEC}`,
      "gc.worktreepruneexpire=never",
    ];
    expect(ownKeys(mirrored)).toEqual(expected);
    expect(ownKeys(bared)).toEqual(expected);
  });

  test("a repository whose config holds nothing is hardened like any other", async () => {
    const dir = bare();
    writeFileSync(join(dir, "config"), "");
    expect(await hardenMirrorConfig(ctx, dir, NO_ORIGIN, live())).toEqual({
      ok: true,
      value: [{ op: "set", key: "gc.worktreePruneExpire", value: "never" }],
    });
    expect(listed(dir)).toEqual(["gc.worktreepruneexpire=never"]);
  });

  test("a directory that is not a repository fails on the read, before any write", async () => {
    const dir = join(root, "not-a-repo");
    mkdirSync(dir, { recursive: true });
    const failed = await hardenMirrorConfig(ctx, dir, NO_ORIGIN, live());
    expect(failed).toMatchObject({
      ok: false,
      // failedGit's shape — the read refused, not a write that refused after it.
      error: {
        class: "spawn_failed",
        message: expect.stringMatching(
          /^hardening the config of mirror .*not-a-repo failed: /,
        ),
      },
    });
    expect(existsSync(join(dir, "config"))).toBe(false);
  });

  test("a stop is interrupted, even with nothing left to write", async () => {
    const dir = bare();
    expect(await hardenMirrorConfig(ctx, dir, NO_ORIGIN, live())).toMatchObject(
      {
        ok: true,
      },
    );
    const stop = new AbortController();
    stop.abort();
    expect(
      await hardenMirrorConfig(ctx, dir, NO_ORIGIN, stop.signal),
    ).toMatchObject({
      ok: false,
      error: { class: "interrupted" },
    });
  });
});
