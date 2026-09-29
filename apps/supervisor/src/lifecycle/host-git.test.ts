// host-git.ts: git on this host is its own process group, and
// a stop or workspace.git_timeout_ms kills the whole group, so a stuck transport helper dies with
// git; every call carries SAFE_GIT, and reads --no-optional-locks (M2).
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "@bayon/core";
import { afterAll, describe, expect, test, vi } from "vitest";
import {
  gitSubcommand,
  hostGit,
  hostGitRun,
  SAFE_GIT,
  safeGitArgs,
  type HostGitCtx,
} from "./host-git.js";
import { DEFAULT_SETTINGS } from "./settings.js";

// Real git and a stuck transport helper: more than the default 5 s on a loaded host. It must also
// stay above WAIT below — at 5 s the test died before waitFor's own 10 s budget could report what
// never happened, so a genuine hang and a busy machine looked identical.
vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const PATH = process.env["PATH"] ?? "/usr/bin:/bin";
const WAIT = { timeout: 10_000, interval: 10 };
const LIMIT_MS = 1_000;

const ctxOf = (path: string, clock = new FakeClock(0)): HostGitCtx => ({
  settings: { ...DEFAULT_SETTINGS, "workspace.git_timeout_ms": LIMIT_MS },
  clock,
  path,
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A `git` whose transport never answers: it forks a helper that holds its stderr, writes the
 * helper's pid, and waits for it. Only a kill of the whole group ends the helper.
 */
function stuckGit(): { readonly path: string; helper(): Promise<number> } {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "frm-hg-")));
  dirs.push(bin);
  const pidFile = join(bin, "helper.pid");
  writeFileSync(
    join(bin, "git"),
    ["#!/bin/sh", `sleep 60 & echo $! > '${pidFile}'`, "wait", ""].join("\n"),
    { mode: 0o755 },
  );
  return {
    path: `${bin}:${PATH}`,
    helper: () =>
      vi.waitFor(() => {
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        expect(pid).toBeGreaterThan(1);
        return pid;
      }, WAIT),
  };
}

describe("safeGitArgs (M2)", () => {
  test("every call has no hooks and no fsmonitor; a read also --no-optional-locks, past -C and -c", () => {
    expect(safeGitArgs(["-C", "/m", "rev-parse", "HEAD"])).toEqual([
      ...SAFE_GIT,
      "--no-optional-locks",
      "-C",
      "/m",
      "rev-parse",
      "HEAD",
    ]);
    expect(safeGitArgs(["-C", "/m", "fetch", "origin"])).toEqual([
      ...SAFE_GIT,
      "-C",
      "/m",
      "fetch",
      "origin",
    ]);
    expect(
      gitSubcommand(["-C", "/w", "-c", "protocol.allow=never", "submodule"]),
    ).toBe("submodule");
  });
});

describe("hostGit kills its whole process group (ticket comment)", () => {
  test("a stop is `interrupted`, and the stuck helper dies with git", async () => {
    const fake = stuckGit();
    const stop = new AbortController();
    const ran = hostGit(
      ctxOf(fake.path),
      "/nowhere",
      ["fetch", "origin"],
      stop.signal,
    );
    const helper = await fake.helper();
    expect(isAlive(helper)).toBe(true);
    stop.abort();
    expect(await ran).toMatchObject({
      ok: false,
      error: { class: "interrupted", message: "git fetch was stopped" },
    });
    await vi.waitFor(() => expect(isAlive(helper)).toBe(false), WAIT);
  });

  test("workspace.git_timeout_ms is `timeout`, and the stuck helper is killed too", async () => {
    const fake = stuckGit();
    const clock = new FakeClock(0);
    const ran = hostGit(
      ctxOf(fake.path, clock),
      "/nowhere",
      ["fetch", "origin"],
      new AbortController().signal,
    );
    const helper = await fake.helper();
    await clock.advance(LIMIT_MS);
    expect(await ran).toMatchObject({
      ok: false,
      error: {
        class: "timeout",
        message: expect.stringContaining("workspace.git_timeout_ms"),
      },
    });
    await vi.waitFor(() => expect(isAlive(helper)).toBe(false), WAIT);
  });

  test("real git: stdout on exit 0, `spawn_failed` with stderr's tail otherwise", async () => {
    const ctx = ctxOf(PATH);
    const version = await hostGitRun(ctx, ["--version"], {
      what: "git --version",
      signal: new AbortController().signal,
    });
    expect(version.ok && version.value.stdout).toMatch(/^git version /);
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "frm-hg-repo-")));
    dirs.push(repo);
    expect(
      await hostGit(ctx, repo, ["init", "-q"], new AbortController().signal),
    ).toEqual({ ok: true, value: "" });
    const missing = await hostGit(
      ctx,
      repo,
      ["rev-parse", "--verify", "nope^{commit}"],
      new AbortController().signal,
    );
    expect(missing).toMatchObject({
      ok: false,
      error: {
        class: "spawn_failed",
        message: expect.stringContaining("git rev-parse failed"),
      },
    });
  });
});
