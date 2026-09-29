// `repo.check`: the supervisor reads a repo URL the way its mirror clone will — SAFE_GIT,
// batch-mode ssh, the forge token only under delivery's rule and only in git's env — and says what
// it found. No network: a local bare repository over file://, the stand-in forge for a private
// https repository, and a fake git for a host that never answers or echoes a credential.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock, forgeTokenSecret, type RepoCheckResult } from "@bayon/core";
import { afterAll, describe, expect, test, vi } from "vitest";
import type { Log } from "./context.js";
import type { RemotePolicy } from "./remote-policy.js";
import {
  REPO_CHECKS_BUSY,
  UNKNOWN_HOST_DETAIL,
  repoCheckHandler,
  type RepoCheckCtx,
} from "./repo-read.js";
import { envSecrets } from "./secrets.js";
import { DEFAULT_SETTINGS } from "./settings.js";
import { FORGE_URL, standInForge } from "./testing/forge-remote.js";
import { tempHome } from "./testing/fixtures.js";

const TOKEN = "ghp_standin_tok_7a2e41b0";
const SECRET = { [`FRM_SECRET_${forgeTokenSecret("github")}`]: TOKEN };
const CMD = { id: "C1", attempts: 1 };

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

/** A home with a source repo on `trunk` (plus `dev`) and its bare clone. */
function world() {
  const home = tempHome("frm-repo-check-");
  cleanups.push(() => void home.cleanup());
  const src = join(home.path, "src");
  mkdirSync(src);
  git(src, "init", "-q", "-b", "trunk");
  writeFileSync(join(src, "README.md"), "hello\n");
  git(src, "add", ".");
  git(src, "commit", "-q", "-m", "one");
  git(src, "branch", "dev");
  const bare = join(home.path, "bare.git");
  git(home.path, "clone", "-q", "--bare", src, bare);
  return { home: home.path, src, bare };
}

/** A git first on PATH that runs `body` (sh) for every call. */
function fakeGit(dir: string, body: string): string {
  const bin = join(dir, "fake-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "git"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`;
}

/** Production's transports plus `file`, for the local bare repository: tests only (review M1). */
const TEST_POLICY: RemotePolicy = {
  protocols: ["https", "ssh", "file"],
  allowedHosts: () => Promise.resolve([]),
  resolve: () => Promise.resolve([]),
};

function harness(
  o: {
    path?: string;
    secrets?: Record<string, string>;
    remote?: Partial<RemotePolicy>;
    signal?: AbortSignal;
  } = {},
) {
  const logged: object[] = [];
  const log: Log = {
    info: (obj) => logged.push(obj),
    warn: (obj) => logged.push(obj),
    error: (obj) => logged.push(obj),
  };
  const clock = new FakeClock(1_700_000_000_000);
  const ctx: RepoCheckCtx = {
    settings: DEFAULT_SETTINGS,
    clock,
    path: o.path ?? process.env["PATH"] ?? "/usr/bin:/bin",
    log,
    secrets: envSecrets(o.secrets ?? {}),
    remote: { ...TEST_POLICY, ...o.remote },
  };
  const handler = repoCheckHandler(ctx, o.signal);
  const check = async (url: string, base?: string) => {
    const r = await handler.handle(
      { url, ...(base === undefined ? {} : { base }) },
      CMD,
    );
    if (!r.ok) throw new Error(r.error.message);
    return r.value as RepoCheckResult;
  };
  const attempt = (url: string) => handler.handle({ url }, CMD);
  return { check, attempt, clock, logged, handler };
}

describe("repo.check", { timeout: 30_000 }, () => {
  test("a reachable repository is found, with its default branch and whether the base is on it", async () => {
    const w = world();
    const h = harness();
    expect(h.handler).toMatchObject({
      type: "repo.check",
      background: true,
      idempotent: true,
    });
    const url = `file://${w.bare}`;
    expect(await h.check(url, "dev")).toEqual({
      outcome: "found",
      default_branch: "trunk",
      base_found: true,
      token_secret: null,
      token_offered: false,
      detail: "",
    });
    expect(await h.check(url, "main")).toMatchObject({
      outcome: "found",
      base_found: false,
    });
    expect(await h.check(url)).toMatchObject({ base_found: null });
  });

  test("a repository that is not there is missing, and git's words say so", async () => {
    const w = world();
    const r = await harness().check(`file://${join(w.home, "nope.git")}`);
    expect(r.outcome).toBe("missing");
    expect(r.detail).toContain("does not appear to be a git repository");
  });

  test("a private https repository with no token in the store is missing, and names the secret to store", async () => {
    const w = world();
    const forge = standInForge({ dir: w.home, source: w.src, token: TOKEN });
    const r = await harness({ path: forge.path }).check(FORGE_URL);
    expect(r).toMatchObject({
      outcome: "missing",
      token_secret: "FORGE_TOKEN_GITHUB",
      token_offered: false,
    });
    // It never asked anybody: the forge was called once, with no token in its env.
    expect(forge.calls().map((c) => c.tokenInEnv)).toEqual([false]);
  });

  test("with the token in the store it is found; the token is in git's env only, never in argv, a result or a log", async () => {
    const w = world();
    const forge = standInForge({ dir: w.home, source: w.src, token: TOKEN });
    const h = harness({ path: forge.path, secrets: SECRET });
    const r = await h.check(FORGE_URL, "trunk");
    expect(r).toMatchObject({
      outcome: "found",
      default_branch: "trunk",
      base_found: true,
      token_offered: true,
    });
    const calls = forge.calls();
    expect(calls.map((c) => c.tokenInEnv)).toEqual([true]);
    for (const c of calls) expect(c.args.join(" ")).not.toContain(TOKEN);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(JSON.stringify(h.logged)).not.toContain(TOKEN);
  });

  test("a credential git echoes is masked: the token's value and a URL's userinfo", async () => {
    const w = world();
    const path = fakeGit(
      w.home,
      `echo "fatal: Authentication failed for '$*' token=$FRM_FORGE_TOKEN" >&2; exit 128`,
    );
    const h = harness({ path, secrets: SECRET });
    const withToken = await h.check(FORGE_URL);
    expect(withToken).toMatchObject({
      outcome: "missing",
      token_offered: true,
    });
    expect(withToken.detail).toContain("token=***");
    expect(JSON.stringify(withToken)).not.toContain(TOKEN);
    // A URL that carries a credential never reaches git at all (review M3), nor any message.
    const withUserinfo = await h.attempt(
      "https://bob:s3cret-pw@git.example.com/a/b.git",
    );
    expect(withUserinfo).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
    expect(JSON.stringify(withUserinfo)).not.toContain("s3cret-pw");
    expect(JSON.stringify(h.logged)).not.toMatch(/s3cret-pw|ghp_standin/);
  });

  test("an ssh host key nobody trusted yet, and a host that does not resolve, are told apart", async () => {
    const w = world();
    const hostKey = harness({
      path: fakeGit(
        w.home,
        `echo "No ED25519 host key is known for git.example.com and you have requested strict checking." >&2; echo "Host key verification failed." >&2; exit 128`,
      ),
    });
    expect((await hostKey.check("git@git.example.com:a/b.git")).outcome).toBe(
      "host_key",
    );
    const dns = harness({
      path: fakeGit(
        join(w.home, "dns"),
        `echo "ssh: Could not resolve hostname git.example.com: nodename nor servname provided" >&2; exit 128`,
      ),
    });
    expect((await dns.check("git@git.example.com:a/b.git")).outcome).toBe(
      "unreachable",
    );
  });

  test("ssh is run in batch mode with strict host keys, as the clone runs it", async () => {
    const w = world();
    const h = harness({
      path: fakeGit(w.home, `echo "ssh=$GIT_SSH_COMMAND" >&2; exit 128`),
    });
    const r = await h.check("git@github.com:acme/private.git");
    expect(r.detail).toContain("BatchMode=yes");
    expect(r.detail).toContain("StrictHostKeyChecking=yes");
  });

  test("a host that never answers is a timeout at REPO_CHECK_LIMIT_MS, and the git is killed", async () => {
    const w = world();
    const h = harness({ path: fakeGit(w.home, "exec sleep 60") });
    const pending = h.check("https://git.example.com/a/b.git");
    await vi.waitFor(async () => {
      await h.clock.advance(20_000);
      const settled = await Promise.race([
        pending.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 20)),
      ]);
      expect(settled).toBe(true);
    });
    expect(await pending).toMatchObject({ outcome: "timeout", detail: "" });
  });

  test("a URL the clone would refuse is refused before any git runs", async () => {
    const r = await harness().handler.handle({ url: "ext::sh -c id" }, CMD);
    expect(r).toMatchObject({ ok: false, error: { class: "validation" } });
  });

  test("git may use only https and ssh: every other transport is shut for the call (review M1)", async () => {
    const w = world();
    const h = harness({
      path: fakeGit(w.home, `echo "args: $*" >&2; exit 128`),
      remote: { protocols: ["https", "ssh"] },
    });
    const r = await h.check(FORGE_URL);
    expect(r.detail).toContain(
      "-c protocol.allow=never -c protocol.https.allow=always -c protocol.ssh.allow=always",
    );
    // Without `file` in the list, a file:// URL is refused before git runs.
    expect(await h.attempt(`file://${w.bare}`)).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
  });

  test("private, loopback, link-local and metadata hosts are refused before git runs (review M2)", async () => {
    const w = world();
    const calls = join(w.home, "calls");
    const path = fakeGit(w.home, `echo x >> '${calls}'; exit 128`);
    const refused = async (
      url: string,
      remote: Partial<RemotePolicy> = {},
    ): Promise<string> => {
      const r = await harness({ path, remote }).attempt(url);
      if (r.ok) throw new Error(`${url} was not refused`);
      expect(r.error.class).toBe("validation");
      return r.error.message;
    };
    expect(await refused("https://10.0.0.5/a/b.git")).toContain(
      "pnpm frm settings set projects.private_repo_hosts 10.0.0.5 --yes",
    );
    expect(await refused("git@localhost:a/b.git")).toContain(
      "this machine itself",
    );
    expect(await refused("http://github.com/a/b.git")).toContain("plain http");
    // Allowed, the private host is read; link-local never is, and neither is a public name that
    // resolves to the metadata address.
    expect(
      await refused("https://169.254.169.254/x.git", {
        allowedHosts: () => Promise.resolve(["169.254.169.254"]),
      }),
    ).toContain("link-local or cloud metadata");
    expect(
      await refused("https://evil.example/x.git", {
        resolve: () => Promise.resolve(["169.254.169.254"]),
      }),
    ).toContain("link-local");
    expect(existsSync(calls)).toBe(false);
    const allowed = await harness({
      path,
      remote: { allowedHosts: () => Promise.resolve(["10.0.0.5"]) },
    }).attempt("https://10.0.0.5/a/b.git");
    expect(allowed.ok).toBe(true);
    expect(existsSync(calls)).toBe(true);
  });

  test("a failure git does not name, on a host that is no known forge, says nothing of the host's own words (review M2)", async () => {
    const w = world();
    const h = harness({
      path: fakeGit(
        w.home,
        `echo "internal-service-banner v1.2" >&2; exit 128`,
      ),
    });
    const r = await h.check("https://git.example.com/a/b.git");
    expect(r.outcome).toBe("failed");
    expect(r.detail).toBe(UNKNOWN_HOST_DETAIL);
    expect(JSON.stringify(h.logged)).toContain("internal-service-banner");
    // A forge keeps git's words: they are the forge's, and useful.
    const forge = await h.check(FORGE_URL);
    expect(forge.detail).toContain("internal-service-banner");
  });

  test("at most three checks run at once; the fourth is refused at once, retryable, in plain words (review H1)", async () => {
    const w = world();
    const stop = new AbortController();
    const h = harness({
      path: fakeGit(w.home, "exec sleep 60"),
      signal: stop.signal,
    });
    const running = [1, 2, 3].map((n) =>
      h.attempt(`https://git${n}.example.com/a/b.git`),
    );
    const fourth = await h.attempt("https://git4.example.com/a/b.git");
    expect(fourth).toEqual({
      ok: false,
      error: {
        class: "admission_refused",
        message: REPO_CHECKS_BUSY,
        retryable: true,
      },
    });
    // The supervisor's shutdown stops the checks in flight (review L3), and frees their places.
    stop.abort();
    for (const r of await Promise.all(running)) {
      expect(r).toMatchObject({ ok: false, error: { class: "interrupted" } });
    }
    // Their places are free again: the next check runs (and, the lifecycle stopping, stops).
    expect(await h.attempt(FORGE_URL)).toMatchObject({
      ok: false,
      error: { class: "interrupted" },
    });
  });
});
