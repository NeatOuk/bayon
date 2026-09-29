// The push into a docker host's mirror, through the loopback: the local
// `git push` over git's ext:: transport, and the fixed receive-pack script on the far end, into a
// real bare repository under a stand-in remote_root. an earlier change: git carries SAFE_GIT on both ends
// and runs as its own process group, so a stop or a deadline kills every helper git started.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "@bayon/core";
import { afterAll, describe, expect, test, vi } from "vitest";
import { SAFE_GIT } from "../git.js";
import { LoopbackTransport } from "./loopback.js";
import { extUrl, pushMirror } from "./mirror.js";
import { CONTAINER_PATHS, layoutOf } from "./route.js";
import { RemoteScripts } from "./scripts.js";
import type { ProgramSpec } from "./transport.js";

const PATH = process.env["PATH"] ?? "/usr/bin:/bin";
const base = realpathSync(mkdtempSync(join(tmpdir(), "frm-mirror-")));
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

const work = join(base, "work");
mkdirSync(work);
git(work, "init", "-q", "-b", "main");
writeFileSync(join(work, "a.txt"), "one\n");
git(work, "add", "a.txt");
git(work, "commit", "-q", "-m", "one");
const local = join(base, "local.git");
git(base, "clone", "-q", "--bare", work, local);

const MAIN = "+refs/heads/main:refs/heads/main";
const WAIT = { timeout: 10_000, interval: 10 };
const transport = new LoopbackTransport({ PATH, HOME: base });
const scriptsFor = (root: string) =>
  new RemoteScripts(
    "ctr-loop",
    layoutOf(root),
    CONTAINER_PATHS,
    "a".repeat(64),
  );

async function push(
  root: string,
  name: string,
  refspecs: readonly string[],
  localMirror = local,
) {
  const program = await transport.program(
    scriptsFor(root).receivePack(name),
    AbortSignal.timeout(20_000),
  );
  try {
    await pushMirror({
      localMirror,
      refspecs,
      program,
      path: PATH,
      signal: AbortSignal.timeout(20_000),
      what: "test push",
    });
  } finally {
    program.release();
  }
}

/** A far end the fake gits below never start. No PATH of its own, so theirs comes first. */
const NOWHERE: ProgramSpec = {
  file: "/bin/sh",
  args: ["-c", "exit 0"],
  env: {},
  release: () => undefined,
};

const pushWith = (path: string, signal: AbortSignal) =>
  pushMirror({
    localMirror: local,
    refspecs: [MAIN],
    program: NOWHERE,
    path,
    signal,
    what: "test push",
  });

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A `git` first on PATH: it writes its argv, one per line, then runs `body`. */
function fakeGit(body: readonly string[]) {
  const dir = mkdtempSync(join(base, "bin-"));
  const argvFile = join(dir, "argv");
  writeFileSync(
    join(dir, "git"),
    ["#!/bin/sh", `printf '%s\\n' "$@" > '${argvFile}'`, ...body, ""].join(
      "\n",
    ),
    { mode: 0o755 },
  );
  return {
    dir,
    path: `${dir}:${PATH}`,
    argv: () => readFileSync(argvFile, "utf8").trimEnd().split("\n"),
  };
}

/**
 * A `git` whose transport never answers: it forks a helper that ignores SIGTERM and holds git's
 * stderr, writes the helper's pid, and waits. Only a SIGKILL of git's whole group ends the helper.
 */
function stuckGit() {
  const pidFile = join(base, `helper-${String(Math.random()).slice(2)}.pid`);
  const fake = fakeGit([
    `(trap '' TERM; exec sleep 60) & echo $! > '${pidFile}'`,
    "wait",
  ]);
  return {
    path: fake.path,
    helper: () =>
      vi.waitFor(() => {
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        expect(pid).toBeGreaterThan(1);
        return pid;
      }, WAIT),
  };
}

/** A hook that would refuse the push, and leave a mark that it ran. */
function refusingHook(repo: string, hook: string, mark: string): void {
  mkdirSync(join(repo, "hooks"), { recursive: true });
  writeFileSync(
    join(repo, "hooks", hook),
    ["#!/bin/sh", `echo ${hook} >> '${mark}'`, "exit 1", ""].join("\n"),
    { mode: 0o755 },
  );
}

describe("the push into a docker host's mirror", { timeout: 30_000 }, () => {
  test("ext:: escapes each argument's % and spaces", () => {
    expect(
      extUrl(["ssh", "-o", "UserKnownHostsFile=/a b/k", "--", "echo 50% done"]),
    ).toBe("ext::ssh -o UserKnownHostsFile=/a% b/k -- echo% 50%%% done");
  });

  test("creates the bare mirror on the far end, then takes the base and a pinned gate ref", async () => {
    const root = join(base, "remote");
    mkdirSync(root);
    const sha = git(local, "rev-parse", "refs/heads/main");
    await push(root, "repo_1", [MAIN, `+${sha}:refs/frm/gate/gate_1`]);
    const mirror = scriptsFor(root).mirrorPath("repo_1");
    expect(git(mirror, "rev-parse", "--is-bare-repository")).toBe("true");
    expect(git(mirror, "rev-parse", "refs/heads/main")).toBe(sha);
    expect(git(mirror, "rev-parse", "refs/frm/gate/gate_1")).toBe(sha);
    // A later push sends only what moved.
    writeFileSync(join(work, "a.txt"), "two\n");
    git(work, "commit", "-q", "-am", "two");
    git(local, "fetch", "-q", work, "+refs/heads/main:refs/heads/main");
    await push(root, "repo_1", [MAIN]);
    expect(git(mirror, "rev-parse", "refs/heads/main")).toBe(
      git(local, "rev-parse", "refs/heads/main"),
    );
  });

  test("refuses a mirror directory that is a symlink out of remote_root, and writes nothing there", async () => {
    const root = join(base, "bent");
    const elsewhere = join(base, "elsewhere");
    mkdirSync(root);
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, "mirror"));
    await expect(push(root, "repo_1", [MAIN])).rejects.toMatchObject({
      class: "spawn_failed",
      message: expect.stringContaining("refused"),
    });
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(existsSync(join(elsewhere, "repo_1.git"))).toBe(false);
  });

  test("refuses deletions, ranges and bare names before any git runs", async () => {
    const program = await transport.program(
      "exit 0",
      AbortSignal.timeout(5_000),
    );
    for (const refspec of [
      ":refs/heads/main",
      "refs/heads/a..b:refs/heads/x",
      "main:main",
    ]) {
      await expect(
        pushMirror({
          localMirror: local,
          refspecs: [refspec],
          program,
          path: PATH,
          signal: AbortSignal.timeout(5_000),
          what: "test push",
        }),
      ).rejects.toMatchObject({ class: "validation" });
    }
  });

  test("an aborted deadline is a timeout", async () => {
    const program = await transport.program(
      "exit 0",
      AbortSignal.timeout(5_000),
    );
    await expect(
      pushMirror({
        localMirror: local,
        refspecs: [MAIN],
        program,
        path: PATH,
        signal: AbortSignal.abort(),
        what: "test push",
      }),
    ).rejects.toMatchObject({ class: "timeout" });
  });
});

describe(
  "pushMirror runs git safely, as its own process group",
  { timeout: 30_000 },
  () => {
    test("git's argv carries SAFE_GIT before everything: no hook, no fsmonitor", async () => {
      const fake = fakeGit(["exit 0"]);
      await pushWith(fake.path, new AbortController().signal);
      expect(fake.argv()).toEqual([
        ...SAFE_GIT,
        "-C",
        local,
        "-c",
        "protocol.ext.allow=always",
        "push",
        "--quiet",
        extUrl([NOWHERE.file, ...NOWHERE.args]),
        MAIN,
      ]);
    });

    test("a pre-push hook in the supervisor's mirror never runs", async () => {
      const hooked = join(base, "hooked-local.git");
      git(base, "clone", "-q", "--bare", work, hooked);
      const mark = join(base, "local-hook-ran");
      refusingHook(hooked, "pre-push", mark);
      const root = join(base, "hooked-local-remote");
      mkdirSync(root);
      await push(root, "repo_1", [MAIN], hooked);
      expect(existsSync(mark)).toBe(false);
      expect(
        git(
          scriptsFor(root).mirrorPath("repo_1"),
          "rev-parse",
          "refs/heads/main",
        ),
      ).toBe(git(hooked, "rev-parse", "refs/heads/main"));
    });

    test("the far end's receive-pack runs no hook of the docker host's mirror", async () => {
      const root = join(base, "hooked-remote");
      const far = scriptsFor(root).mirrorPath("repo_1");
      mkdirSync(join(root, "mirror"), { recursive: true });
      git(base, "init", "-q", "--bare", far);
      const mark = join(base, "remote-hook-ran");
      for (const hook of ["pre-receive", "update", "reference-transaction"]) {
        refusingHook(far, hook, mark);
      }
      // ssh forwards none of git's environment: drop the -c the local push exports, so only the
      // far end's own flags stand between receive-pack and the hooks.
      const program: ProgramSpec = {
        file: "/usr/bin/env",
        args: [
          "-u",
          "GIT_CONFIG_PARAMETERS",
          "/bin/sh",
          "-c",
          scriptsFor(root).receivePack("repo_1"),
        ],
        env: { PATH, HOME: base },
        release: () => undefined,
      };
      await pushMirror({
        localMirror: local,
        refspecs: [MAIN],
        program,
        path: PATH,
        signal: AbortSignal.timeout(20_000),
        what: "test push",
      });
      expect(existsSync(mark)).toBe(false);
      expect(git(far, "rev-parse", "refs/heads/main")).toBe(
        git(local, "rev-parse", "refs/heads/main"),
      );
    });

    test("a stop kills git's whole group: the helper that ignores SIGTERM dies with git", async () => {
      const fake = stuckGit();
      const stop = new AbortController();
      const pushed = pushWith(fake.path, stop.signal);
      const helper = await fake.helper();
      expect(isAlive(helper)).toBe(true);
      stop.abort();
      await expect(pushed).rejects.toMatchObject({ class: "timeout" });
      await vi.waitFor(() => expect(isAlive(helper)).toBe(false), WAIT);
    });

    test("a deadline that passes kills the whole group too: `timeout`, the helper dead", async () => {
      const fake = stuckGit();
      const clock = new FakeClock(0);
      const deadline = new AbortController();
      void clock.after(1_000).then(() => deadline.abort());
      const pushed = pushWith(fake.path, deadline.signal);
      const helper = await fake.helper();
      expect(isAlive(helper)).toBe(true);
      await clock.advance(1_000);
      await expect(pushed).rejects.toMatchObject({
        class: "timeout",
        retryable: true,
      });
      await vi.waitFor(() => expect(isAlive(helper)).toBe(false), WAIT);
    });
  },
);
