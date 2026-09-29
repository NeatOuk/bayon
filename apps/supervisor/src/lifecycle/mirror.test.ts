// A repo's mirror on first use against real git: a refused row runs no git; a failed,
// timed-out or stopped clone leaves nothing at mirror_path or beside it; a later call clones.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FakeClock } from "@bayon/core";
import { SAFE_GIT } from "@bayon/executors";
import { afterAll, describe, expect, test, vi } from "vitest";
import type { Log } from "./context.js";
import {
  ensureMirror,
  mirrorPathProblem,
  originUrlProblem,
  type MirrorCtx,
  type MirrorRepo,
} from "./mirror.js";
import { DEFAULT_SETTINGS } from "./settings.js";

const T0 = 1_700_000_000_000;
const GIT_TIMEOUT_MS = 30_000;
/** How long a fake git may take to start under a loaded, parallel test run. */
const WAIT = { timeout: 10_000, interval: 10 };
const PATH = process.env["PATH"] ?? "/usr/bin:/bin";
const root = mkdtempSync(join(tmpdir(), "frm-mirror-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const realGit = execFileSync("sh", ["-c", "command -v git"], {
  encoding: "utf8",
}).trim();
const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

const listed = (dir: string): string[] =>
  git(dir, "config", "--local", "--list")
    .split("\n")
    .filter((l) => l !== "");
/** What a fresh `git init --bare` writes here: platform-dependent, so read, never assumed. */
const PRISTINE = ((): ReadonlySet<string> => {
  const dir = join(root, "pristine.git");
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "--bare", "--template=", dir);
  return new Set(listed(dir));
})();
/** A mirror's own config, minus every line a pristine bare repository also has. */
const ownKeys = (dir: string): string[] =>
  listed(dir).filter((line) => !PRISTINE.has(line));

let worlds = 0;
/** A fresh directory with an origin holding one commit on main; its mirror is not made. */
function world() {
  worlds += 1;
  const dir = join(root, `w${String(worlds)}`);
  const origin = join(dir, "origin");
  mkdirSync(origin, { recursive: true });
  git(origin, "init", "-q", "-b", "main");
  writeFileSync(join(origin, "README.md"), "hello\n");
  git(origin, "add", ".");
  git(origin, "commit", "-q", "-m", "one");
  const mirror = join(dir, "mirrors", "repo.git");
  return { dir, origin, mirror, head: git(origin, "rev-parse", "HEAD") };
}

/** A `git` first on PATH that logs every call; a clone runs `onClone` (sh), else the real git. */
function fakeGit(dir: string, onClone = `exec '${realGit}' "$@"`) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(bin, "calls.log");
  const script = [
    "#!/bin/sh",
    `echo "$*" >> '${log}'`,
    `case " $* " in *" clone "*) ${onClone} ;; esac`,
    `exec '${realGit}' "$@"`,
    "",
  ].join("\n");
  writeFileSync(join(bin, "git"), script, { mode: 0o755 });
  return {
    path: `${bin}:${PATH}`,
    calls: (): string[] =>
      existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
  };
}

/**
 * A clone whose transport helper never answers, as over a dead network: the fake git forks a
 * `sleep` that holds its stderr, writes its pid, and waits for it (review HIGH: the whole group
 * must die, or the helper outlives the kill and the clone never settles).
 */
function stuckClone(dir: string) {
  const pidFile = join(dir, "helper.pid");
  const fake = fakeGit(dir, `sleep 60 & echo $! > '${pidFile}'; wait`);
  const helper = (): Promise<number> =>
    vi.waitFor(() => {
      expect(existsSync(pidFile)).toBe(true);
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      expect(pid).toBeGreaterThan(1);
      return pid;
    }, WAIT);
  return { ...fake, helper };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // ESRCH: gone
  }
}

const logged: string[] = [];
const loggedWith: object[] = [];
const line = (obj: object, msg: string): void => {
  logged.push(msg);
  loggedWith.push(obj);
};
const log: Log = { info: line, warn: line, error: line };

const ctxOf = (path: string, clock = new FakeClock(T0)): MirrorCtx => ({
  settings: { ...DEFAULT_SETTINGS, "workspace.git_timeout_ms": GIT_TIMEOUT_MS },
  clock,
  path,
  log,
});
const repoOf = (origin: string | null, mirror: string): MirrorRepo => ({
  id: "repo_1",
  origin_url: origin,
  mirror_path: mirror,
});
const live = (): AbortSignal => new AbortController().signal;
/** Temp clones left beside the mirror. */
const leftovers = (mirror: string): string[] =>
  existsSync(dirname(mirror))
    ? readdirSync(dirname(mirror)).filter((n) => n.includes(".clone-"))
    : [];

test("what a repo row may name: absolute paths; URLs and paths without a leading '-'", () => {
  expect(mirrorPathProblem("/srv/mirrors/repo.git")).toBeNull();
  expect(mirrorPathProblem("-repo.git")).toBe("starts with '-'");
  expect(mirrorPathProblem("mirrors/repo.git")).toBe("is not an absolute path");
  for (const url of [
    "https://github.com/o/r.git",
    "git@github.com:o/r.git",
    "ssh://git@host/o/r.git",
    "/srv/src/r",
  ]) {
    expect(originUrlProblem(url)).toBeNull();
  }
  expect(originUrlProblem("--upload-pack=touch /tmp/x")).toBe(
    "starts with '-'",
  );
  expect(originUrlProblem("  ")).toBe("is empty");
  expect(originUrlProblem("ext::sh -c touch% /tmp/x")).toBe(
    "names a program transport",
  );
  expect(originUrlProblem("FD::3")).toBe("names a program transport");
});

describe("ensureMirror on real git", { timeout: 30_000 }, () => {
  test("first use clones a --bare of origin_url; the next call finds it and only reads its config", async () => {
    const w = world();
    const fake = fakeGit(w.dir);
    const ctx = ctxOf(fake.path);
    expect(await ensureMirror(ctx, repoOf(w.origin, w.mirror), live())).toEqual(
      { ok: true, value: "cloned" },
    );
    expect(git(w.mirror, "rev-parse", "refs/heads/main")).toBe(w.head);
    const [clone, ...more] = fake.calls();
    // SAFE_GIT first: no hook or fsmonitor ever runs in the supervisor.
    expect(clone).toMatch(
      new RegExp(
        `^${SAFE_GIT.join(" ")} clone --bare --quiet -- ${w.origin} \\S+\\.clone-\\w+$`,
      ),
    );
    // Then the hardening pass on the clone, still in its temp directory: a read with
    // includes off, one write per key the clone did not carry, and the read that is the actual
    // guarantee — with includes **on**, because a `--local` listing does not show one key of a
    // file an `include.path` names (CRITICAL).
    expect(more).toEqual([
      expect.stringMatching(
        /\.clone-\w+ config --local --list -z --no-includes$/,
      ),
      expect.stringMatching(
        /\.clone-\w+ config --local --replace-all gc\.worktreePruneExpire never$/,
      ),
      expect.stringMatching(
        /\.clone-\w+ config --local --replace-all remote\.origin\.fetch \+refs\/heads\/\*:refs\/remotes\/origin\/\*$/,
      ),
      expect.stringMatching(/\.clone-\w+ config --local --list -z --includes$/),
    ]);
    expect(await ensureMirror(ctx, repoOf(w.origin, w.mirror), live())).toEqual(
      { ok: true, value: "present" },
    );
    // A hardened mirror is read twice and left alone: no write at all.
    const safe = `${SAFE_GIT.join(" ")} --no-optional-locks -C ${w.mirror} config --local --list -z`;
    expect(fake.calls().slice(5)).toEqual([
      `${safe} --no-includes`,
      `${safe} --includes`,
    ]);
    expect(leftovers(w.mirror)).toEqual([]);
  });

  test("a new mirror carries the hardened repo-local config, and using it again writes nothing", async () => {
    const w = world();
    const ctx = ctxOf(PATH);
    expect(await ensureMirror(ctx, repoOf(w.origin, w.mirror), live())).toEqual(
      { ok: true, value: "cloned" },
    );
    // The config the mirror actually carries, not the fact that a write was attempted.
    // No `mirror = true`, no `+refs/*:refs/*`: a plain fetch or push in this directory is not
    // destructive, and the refspec is the one Bayon's own fetches use.
    expect(ownKeys(w.mirror)).toEqual([
      `remote.origin.url=${w.origin}`,
      "remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*",
      "gc.worktreepruneexpire=never",
    ]);
    const before = readFileSync(join(w.mirror, "config"), "utf8");
    expect(await ensureMirror(ctx, repoOf(w.origin, w.mirror), live())).toEqual(
      { ok: true, value: "present" },
    );
    expect(readFileSync(join(w.mirror, "config"), "utf8")).toBe(before);
  });

  test("a mirror already on disk is brought up to it, and the smudge driver it carried never runs", async () => {
    const w = world();
    writeFileSync(join(w.origin, ".gitattributes"), "* filter=p\n");
    git(w.origin, "add", ".");
    git(w.origin, "commit", "-q", "-m", "attributes");
    // Two mirrors of the same origin, each cloned before an earlier change and each carrying a hostile
    // repo-local config: a smudge driver runs on checkout in every worktree cut from the mirror.
    const plant = (mirror: string, marker: string): void => {
      git(w.dir, "clone", "-q", "--mirror", w.origin, mirror);
      git(
        mirror,
        "config",
        "--local",
        "filter.p.smudge",
        `sh -c 'touch ${marker}; cat'`,
      );
      git(mirror, "config", "--local", "core.sshCommand", "sh -c 'true'");
      // A url.<base>.insteadOf whose base carries a credential: the common spelling of a GitHub
      // token in a config, and the one place a key is worth redacting in a log (Invariant 11).
      git(
        mirror,
        "config",
        "--local",
        "url.https://x-access-token:s3cret@github.com/.insteadOf",
        "https://github.com/",
      );
    };
    const left = join(w.dir, "left.git");
    const right = join(w.dir, "right.git");
    const leftMark = join(w.dir, "left-ran");
    const rightMark = join(w.dir, "right-ran");
    plant(left, leftMark);
    plant(right, rightMark);

    expect(
      await ensureMirror(ctxOf(PATH), repoOf(w.origin, right), live()),
    ).toEqual({ ok: true, value: "present" });
    // A mirror cloned before an earlier change ends up with the config one cloned after it has.
    expect(ownKeys(right)).toEqual([
      `remote.origin.url=${w.origin}`,
      "remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*",
      "gc.worktreepruneexpire=never",
    ]);
    expect(logged).toContain("mirror config hardened");
    // The line names what changed with the subsection redacted: no value is ever logged, and for
    // this key the value's secret sits in the key itself (review, LOW-4).
    const line = loggedWith[logged.lastIndexOf("mirror config hardened")];
    expect(line).toMatchObject({
      changes: expect.arrayContaining(["url.*.insteadof", "core.sshcommand"]),
    });
    expect(JSON.stringify(line)).not.toContain("s3cret");

    // The driver is not theory: the mirror that did not go through the pass still runs it.
    git(left, "worktree", "add", "-q", join(w.dir, "left-wt"), "main");
    git(right, "worktree", "add", "-q", join(w.dir, "right-wt"), "main");
    expect(existsSync(leftMark)).toBe(true);
    expect(existsSync(rightMark)).toBe(false);
  });

  test("a URL or path starting with '-', a program transport, a relative path, a file or no origin: validation, no git", async () => {
    const w = world();
    const fake = fakeGit(w.dir);
    const file = join(w.dir, "file.git");
    writeFileSync(file, "not a mirror\n");
    const cases: readonly [string | null, string, string][] = [
      [
        "--upload-pack=touch /tmp/frm-pwned",
        w.mirror,
        `origin_url "--upload-pack=touch /tmp/frm-pwned" starts with '-'`,
      ],
      ["-uevil", w.mirror, `origin_url "-uevil" starts with '-'`],
      [
        "ext::sh -c touch% /tmp/frm-pwned",
        w.mirror,
        "names a program transport",
      ],
      [w.origin, "-mirror.git", `mirror_path "-mirror.git" starts with '-'`],
      [w.origin, "mirrors/repo.git", "is not an absolute path"],
      [w.origin, file, `mirror_path ${file} is not a directory`],
      [null, w.mirror, "no origin_url to clone it from"],
    ];
    for (const [origin, mirror, why] of cases) {
      expect(
        await ensureMirror(ctxOf(fake.path), repoOf(origin, mirror), live()),
      ).toEqual({
        ok: false,
        error: expect.objectContaining({
          class: "validation",
          message: expect.stringContaining(why),
        }),
      });
    }
    expect(fake.calls()).toEqual([]);
    expect(existsSync(dirname(w.mirror))).toBe(false);
  });

  test("a failed clone leaves nothing a later call would trust; that call clones cleanly", async () => {
    const w = world();
    const gone = join(w.dir, "no-such-origin");
    expect(
      await ensureMirror(ctxOf(PATH), repoOf(gone, w.mirror), live()),
    ).toMatchObject({
      ok: false,
      error: {
        class: "spawn_failed",
        message: expect.stringContaining(
          "git clone --bare of repo repo_1 failed",
        ),
      },
    });
    expect(existsSync(w.mirror)).toBe(false);
    expect(leftovers(w.mirror)).toEqual([]);
    // A clone that wrote every object and then failed: its directory is removed, not moved in.
    const fake = fakeGit(w.dir, `'${realGit}' "$@"; exit 1`);
    expect(
      await ensureMirror(ctxOf(fake.path), repoOf(w.origin, w.mirror), live()),
    ).toMatchObject({ ok: false, error: { class: "spawn_failed" } });
    expect(fake.calls()).toHaveLength(1);
    expect(existsSync(w.mirror)).toBe(false);
    expect(leftovers(w.mirror)).toEqual([]);
    expect(
      await ensureMirror(ctxOf(PATH), repoOf(w.origin, w.mirror), live()),
    ).toEqual({ ok: true, value: "cloned" });
    expect(git(w.mirror, "rev-parse", "refs/heads/main")).toBe(w.head);
  });

  test("a clone that never answers is killed at workspace.git_timeout_ms, helpers and all: timeout, nothing left", async () => {
    const w = world();
    const fake = stuckClone(w.dir);
    const clock = new FakeClock(T0);
    const pending = ensureMirror(
      ctxOf(fake.path, clock),
      repoOf(w.origin, w.mirror),
      live(),
    );
    const helper = await fake.helper();
    await clock.advance(GIT_TIMEOUT_MS);
    expect(await pending).toMatchObject({
      ok: false,
      error: {
        class: "timeout",
        message: expect.stringContaining("workspace.git_timeout_ms"),
      },
    });
    await vi.waitFor(() => expect(isAlive(helper)).toBe(false), WAIT);
    expect(existsSync(w.mirror)).toBe(false);
    expect(leftovers(w.mirror)).toEqual([]);
  });

  test("a stop during the clone is interrupted, helpers and all, nothing left", async () => {
    const w = world();
    const fake = stuckClone(w.dir);
    const stop = new AbortController();
    const pending = ensureMirror(
      ctxOf(fake.path),
      repoOf(w.origin, w.mirror),
      stop.signal,
    );
    const helper = await fake.helper();
    stop.abort();
    expect(await pending).toMatchObject({
      ok: false,
      error: { class: "interrupted" },
    });
    await vi.waitFor(() => expect(isAlive(helper)).toBe(false), WAIT);
    expect(existsSync(w.mirror)).toBe(false);
    expect(leftovers(w.mirror)).toEqual([]);
  });
});
