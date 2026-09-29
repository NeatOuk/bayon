// What a hostile mirror config actually *does*, against real git. Every test
// here is a differential: two mirrors planted identically, one put through hardenMirrorConfig and
// one not, and then the thing the attack would achieve — a marker file, a credential handed out, a
// commit fetched from the wrong host. A test of the key table would pass against a table that is
// still one name short, which is exactly how `include.path`, the credential family and
// `remote.origin.url` got past the first cut of this module.
import { execFile as execFileCb, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "@bayon/core";
import { SAFE_GIT } from "@bayon/executors";
import { afterAll, describe, expect, test } from "vitest";
import { hardenMirrorConfig, type MirrorConfigCtx } from "./mirror-config.js";
import { DEFAULT_SETTINGS } from "./settings.js";

const execFile = promisify(execFileCb);

const T0 = 1_700_000_000_000;
const PATH = process.env["PATH"] ?? "/usr/bin:/bin";
const root = mkdtempSync(join(tmpdir(), "frm-mirror-exec-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ctx: MirrorConfigCtx = {
  settings: { ...DEFAULT_SETTINGS, "workspace.git_timeout_ms": 30_000 },
  clock: new FakeClock(T0),
  path: PATH,
};
const live = (): AbortSignal => new AbortController().signal;

/**
 * git as an **agent** once ran it: the environment floor and nothing else. No SAFE_GIT, because a
 * builder granted `git commit` or `git rebase` (command-policy.ts) types plain git, and the
 * mirror's config is the config of every worktree cut from it. A session's env now also carries
 * SAFE_GIT's pairs (SESSION_GIT_ENV), which outrank this file for the keys they pin;
 * these differentials keep the file itself honest, for every key they do not pin and for any git
 * that does not inherit a session's env.
 */
const agentEnv = (): Record<string, string> => ({
  PATH,
  HOME: join(root, "no-such-home"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@e",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@e",
});

const agentGit = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: agentEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/**
 * The same, but **asynchronous** and tolerating a non-zero exit. Asynchronous because the 401
 * server below lives in this process: a blocking execFileSync would hold the event loop and the
 * answer git is waiting for would never be sent. A fetch against a 401 is expected to fail, and
 * the command's exit is not the claim — what it ran on the way is.
 */
async function tryAgentGit(cwd: string, ...args: string[]): Promise<void> {
  try {
    await execFile("git", args, {
      cwd,
      env: agentEnv(),
      timeout: 30_000,
    });
  } catch {
    // Expected: 401, or the kill at the timeout.
  }
}

/** A script that touches `marker` and then behaves like `cat`, for a filter driver. */
function markerScript(name: string, marker: string): string {
  const path = join(root, name);
  writeFileSync(path, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
  return path;
}

let origins = 0;
/** An origin with one commit on main, and `.gitattributes` putting every path through filter `p`. */
function origin(attributes: boolean): { path: string; head: string } {
  origins += 1;
  const path = join(root, `origin${String(origins)}`);
  mkdirSync(path, { recursive: true });
  agentGit(path, "init", "-q", "-b", "main");
  writeFileSync(join(path, "README.md"), "hello\n");
  if (attributes) writeFileSync(join(path, ".gitattributes"), "* filter=p\n");
  agentGit(path, "add", ".");
  agentGit(path, "commit", "-q", "-m", "one");
  return { path, head: agentGit(path, "rev-parse", "HEAD") };
}

let clones = 0;
/** A bare clone of `from`, planted by `plant`, named for the test. */
function planted(from: string, plant: (mirror: string) => void): string {
  clones += 1;
  const mirror = join(root, `m${String(clones)}.git`);
  agentGit(root, "clone", "-q", "--bare", from, mirror);
  plant(mirror);
  return mirror;
}

describe("a planted mirror, hardened and not", { timeout: 60_000 }, () => {
  test("CRITICAL: a filter driver reached through include.path runs on checkout until the pass removes it", async () => {
    const src = origin(true);
    // The config holds **only** `include.path`. `git config --local --list` — what this module read
    // before the review — does not print one key of the included file, so the plan was empty and
    // every later pass called the mirror already hardened. The checkout honours it all the same.
    const plant = (mirror: string, marker: string): void => {
      const included = join(mirror, "planted.cfg");
      writeFileSync(
        included,
        `[filter "p"]\n\tsmudge = ${markerScript(`smudge-${marker.split("/").pop() ?? ""}.sh`, marker)}\n\tclean = cat\n`,
      );
      agentGit(mirror, "config", "--local", "include.path", included);
      // The other half, and deliberately left in place by the pass: `info/attributes` is shared
      // with every worktree too, and inert once no config can define the driver it names.
      mkdirSync(join(mirror, "info"), { recursive: true });
      writeFileSync(join(mirror, "info", "attributes"), "* filter=p\n");
    };
    const leftMark = join(root, "inc-left-ran");
    const rightMark = join(root, "inc-right-ran");
    const left = planted(src.path, (m) => plant(m, leftMark));
    const right = planted(src.path, (m) => plant(m, rightMark));

    const hardened = await hardenMirrorConfig(
      ctx,
      right,
      { originUrl: src.path },
      live(),
    );
    expect(hardened).toMatchObject({ ok: true });
    expect(hardened.ok && hardened.value.map((c) => c.key)).toContain(
      "include.path",
    );

    agentGit(left, "worktree", "add", "-q", join(root, "inc-left-wt"), "main");
    agentGit(
      right,
      "worktree",
      "add",
      "-q",
      join(root, "inc-right-wt"),
      "main",
    );
    expect(existsSync(leftMark)).toBe(true);
    expect(existsSync(rightMark)).toBe(false);
  });

  test("CRITICAL: an include git cannot be talked out of fails the pass rather than passing it", async () => {
    const src = origin(false);
    // A config git resolves but will not let us write through: a file that includes itself. Every
    // `git config` on this mirror exits 128 with "exceeded maximum include depth". The claim is
    // only that the answer is an error — a mirror we cannot disarm is not one to cut a worktree
    // from, and the shape a hostile include takes is not ours to enumerate.
    const mirror = planted(src.path, (m) => {
      const self = join(m, "self.cfg");
      writeFileSync(
        self,
        `[filter "p"]\n\tsmudge = /bin/cat\n[include]\n\tpath = ${self}\n`,
      );
      agentGit(m, "config", "--local", "include.path", self);
    });
    expect(
      await hardenMirrorConfig(ctx, mirror, { originUrl: null }, live()),
    ).toMatchObject({ ok: false, error: { class: "spawn_failed" } });
  });

  test("CRITICAL: a driver in a linked worktree's config.worktree is removed too", async () => {
    const src = origin(true);
    const marker = join(root, "wtcfg-ran");
    const mirror = planted(src.path, () => undefined);
    // `extensions.worktreeConfig` is the key a mirror-config test used to assert was safe. With it
    // on, this file is read for that one worktree — and an agent can write *another* session's,
    // because the whole `worktrees/` tree sits under the shared mirror. core.bare has to move with
    // it, or every linked worktree reads the bare flag too (sweep-hiders.test.ts says the same).
    agentGit(mirror, "config", "--local", "core.repositoryformatversion", "1");
    agentGit(mirror, "config", "--local", "extensions.worktreeConfig", "true");
    agentGit(mirror, "config", "--local", "--unset", "core.bare");
    writeFileSync(join(mirror, "config.worktree"), "[core]\n\tbare = true\n");
    const wt = join(root, "wtcfg-wt");
    agentGit(mirror, "worktree", "add", "-q", wt, "main");
    writeFileSync(
      join(mirror, "worktrees", "wtcfg-wt", "config.worktree"),
      `[filter "p"]\n\tsmudge = ${markerScript("smudge-wtcfg.sh", marker)}\n\tclean = cat\n`,
    );
    // Planted and live: a checkout in that worktree runs it, with nothing in the shared config.
    writeFileSync(join(wt, "README.md"), "changed\n");
    agentGit(wt, "checkout", "-q", "--", "README.md");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    expect(
      await hardenMirrorConfig(ctx, mirror, { originUrl: src.path }, live()),
    ).toMatchObject({ ok: true });
    writeFileSync(join(wt, "README.md"), "changed again\n");
    agentGit(wt, "checkout", "-q", "--", "README.md");
    expect(existsSync(marker)).toBe(false);
    // And the main worktree's own file kept the key it is there for.
    expect(agentGit(mirror, "rev-parse", "--is-bare-repository")).toBe("true");
  });

  test("HIGH: a credential helper runs on a fetch until the pass removes it", async () => {
    const { url, close } = await unauthorized();
    try {
      const src = origin(false);
      const plant = (mirror: string, marker: string): void => {
        const helper = join(root, `helper-${marker.split("/").pop() ?? ""}.sh`);
        writeFileSync(
          helper,
          `#!/bin/sh\ntouch '${marker}'\necho username=u\necho password=p\n`,
          { mode: 0o755 },
        );
        agentGit(
          mirror,
          "config",
          "--local",
          "credential.helper",
          `!${helper}`,
        );
        agentGit(mirror, "config", "--local", "remote.origin.url", url);
      };
      const leftMark = join(root, "cred-left-ran");
      const rightMark = join(root, "cred-right-ran");
      const left = planted(src.path, (m) => plant(m, leftMark));
      const right = planted(src.path, (m) => plant(m, rightMark));

      expect(
        await hardenMirrorConfig(ctx, right, { originUrl: url }, live()),
      ).toMatchObject({ ok: true });

      await tryAgentGit(left, "fetch", "origin", "+refs/heads/main:refs/x");
      await tryAgentGit(right, "fetch", "origin", "+refs/heads/main:refs/x");
      expect(existsSync(leftMark)).toBe(true);
      expect(existsSync(rightMark)).toBe(false);

      // And the git *we* run does not need the pass to have happened: SAFE_GIT resets the helper
      // list and the askpass program on every call, so the fetch call sites that harden nothing
      // (a gate's subject pin) cannot run one either.
      rmSync(leftMark);
      const floor = {
        PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      };
      try {
        await execFile(
          "git",
          [
            ...SAFE_GIT,
            "-C",
            left,
            "fetch",
            "origin",
            "+refs/heads/main:refs/x",
          ],
          { env: floor, timeout: 30_000 },
        );
      } catch {
        // 401 again: the exit is not the claim.
      }
      expect(existsSync(leftMark)).toBe(false);
    } finally {
      await close();
    }
  });

  test("HIGH: core.askpass is asked when no helper answers, until the pass removes it", async () => {
    const { url, close } = await unauthorized();
    try {
      const src = origin(false);
      const plant = (mirror: string, marker: string): void => {
        const ask = join(root, `ask-${marker.split("/").pop() ?? ""}.sh`);
        writeFileSync(ask, `#!/bin/sh\ntouch '${marker}'\necho u\n`, {
          mode: 0o755,
        });
        agentGit(mirror, "config", "--local", "core.askpass", ask);
        agentGit(mirror, "config", "--local", "remote.origin.url", url);
      };
      const leftMark = join(root, "ask-left-ran");
      const rightMark = join(root, "ask-right-ran");
      const left = planted(src.path, (m) => plant(m, leftMark));
      const right = planted(src.path, (m) => plant(m, rightMark));
      expect(
        await hardenMirrorConfig(ctx, right, { originUrl: url }, live()),
      ).toMatchObject({ ok: true });
      await tryAgentGit(left, "fetch", "origin", "+refs/heads/main:refs/x");
      await tryAgentGit(right, "fetch", "origin", "+refs/heads/main:refs/x");
      expect(existsSync(leftMark)).toBe(true);
      expect(existsSync(rightMark)).toBe(false);
    } finally {
      await close();
    }
  });

  test("HIGH: a repointed origin is reconciled against repos.origin_url, not merely read", async () => {
    const real = origin(false);
    const evil = origin(false);
    // The commit each host would hand back, so the assertion is which host answered and not which
    // string is in the file.
    writeFileSync(join(evil.path, "README.md"), "owned\n");
    agentGit(evil.path, "add", ".");
    agentGit(evil.path, "commit", "-q", "-m", "theirs");
    const evilHead = agentGit(evil.path, "rev-parse", "HEAD");
    expect(evilHead).not.toBe(real.head);

    const plant = (mirror: string): void => {
      agentGit(mirror, "config", "--local", "remote.origin.url", evil.path);
    };
    const left = planted(real.path, plant);
    const right = planted(real.path, plant);
    expect(
      await hardenMirrorConfig(ctx, right, { originUrl: real.path }, live()),
    ).toMatchObject({ ok: true });

    for (const m of [left, right]) {
      agentGit(
        m,
        "fetch",
        "origin",
        "+refs/heads/main:refs/remotes/origin/main",
      );
    }
    expect(agentGit(left, "rev-parse", "refs/remotes/origin/main")).toBe(
      evilHead,
    );
    expect(agentGit(right, "rev-parse", "refs/remotes/origin/main")).toBe(
      real.head,
    );
  });

  test("HIGH: a push URL and a second remote go with it", async () => {
    const src = origin(false);
    const mirror = planted(src.path, (m) => {
      agentGit(
        m,
        "config",
        "--local",
        "remote.origin.pushurl",
        "https://evil.example/",
      );
      agentGit(
        m,
        "config",
        "--local",
        "remote.evil.url",
        "https://evil.example/",
      );
      agentGit(m, "config", "--local", "remote.origin.uploadpack", "/bin/sh");
    });
    expect(
      await hardenMirrorConfig(ctx, mirror, { originUrl: src.path }, live()),
    ).toMatchObject({ ok: true });
    expect(
      agentGit(mirror, "config", "--local", "--list", "--includes")
        .split("\n")
        .filter((l) => l.startsWith("remote."))
        .sort(),
    ).toEqual([
      `remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*`,
      `remote.origin.url=${src.path}`,
    ]);
  });
});

/** A server that answers 401 to everything: enough to make git ask for a credential. */
async function unauthorized(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="x"',
      "Content-Length": "0",
    });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}/x.git`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
