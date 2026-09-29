// git.ts: the one source of SAFE_GIT and of git run as its own
// process group, shared by the supervisor's host git and the container executor's mirror push.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  GIT_ENV_FLOOR,
  GIT_TOKEN_ENV,
  gitSubcommand,
  gitTokenEnv,
  gitTokenFlags,
  runGitGroup,
  SAFE_GIT,
  safeGitArgs,
} from "./git.js";

const PATH = process.env["PATH"] ?? "/usr/bin:/bin";
const live = () => new AbortController().signal;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("safeGitArgs (M2)", () => {
  test("SAFE_GIT is no hook, no fsmonitor, no auto maintenance and no credential program", () => {
    expect(SAFE_GIT).toEqual([
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "maintenance.auto=false",
      "-c",
      "gc.auto=0",
      // An empty value resets the helper list and clears the askpass program: a repo-local one of
      // either runs a program on any authenticated transport, and no terminal-prompt setting
      // suppresses it (— mirror-exec.test.ts proves it against a real 401).
      "-c",
      "credential.helper=",
      "-c",
      "core.askpass=",
    ]);
  });

  test("a read past -C, -c and --git-dir= also takes --no-optional-locks; a write does not", () => {
    expect(gitSubcommand(["--git-dir=/m.git", "for-each-ref"])).toBe(
      "for-each-ref",
    );
    expect(safeGitArgs(["--git-dir=/m.git", "for-each-ref"])).toEqual([
      ...SAFE_GIT,
      "--no-optional-locks",
      "--git-dir=/m.git",
      "for-each-ref",
    ]);
    expect(
      safeGitArgs(["-C", "/m", "-c", "protocol.ext.allow=always", "push"]),
    ).toEqual([
      ...SAFE_GIT,
      "-C",
      "/m",
      "-c",
      "protocol.ext.allow=always",
      "push",
    ]);
    expect(gitSubcommand(["--git-dir=/m.git", "update-ref", "--stdin"])).toBe(
      "update-ref",
    );
    expect(gitSubcommand([])).toBe("");
  });
});

describe("runGitGroup", () => {
  test("real git, to its exit whatever its code: stdout, stderr, not killed", async () => {
    const version = await runGitGroup(["--version"], {
      what: "git --version",
      env: { PATH },
      signal: live(),
    });
    expect(version).toMatchObject({
      ok: true,
      value: {
        code: 0,
        killed: null,
        stdout: expect.stringMatching(/^git version /),
      },
    });
    const unknown = await runGitGroup(["no-such-subcommand"], {
      what: "git no-such-subcommand",
      env: { PATH },
      signal: live(),
      stdout: "ignore",
    });
    expect(unknown).toMatchObject({
      ok: true,
      value: {
        code: expect.any(Number),
        stdout: "",
        stderr: expect.stringContaining("no-such-subcommand"),
        killed: null,
      },
    });
    expect(unknown.ok && unknown.value.code).not.toBe(0);
  });

  test("an already-aborted signal kills the group at once", async () => {
    const ran = await runGitGroup(["--version"], {
      what: "git --version",
      env: { PATH },
      signal: AbortSignal.abort(),
    });
    expect(ran).toMatchObject({ ok: true, value: { killed: "aborted" } });
  });

  test("the env floor wins over a caller's env: no global config can be handed back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "frm-git-floor-"));
    dirs.push(dir);
    const global = join(dir, "gitconfig");
    // What a global config can carry (`url.*.insteadOf`, `core.sshCommand`, `filter.*`) is what
    // the floor exists to shut out; `user.name` only has to be readable to prove it was read.
    writeFileSync(global, "[user]\n\tname = handed-back\n");
    const ran = await runGitGroup(["config", "--get", "user.name"], {
      what: "git config",
      env: {
        PATH,
        ...GIT_ENV_FLOOR,
        // A caller trying (or forgetting) its way past the floor.
        GIT_CONFIG_GLOBAL: global,
        GIT_CONFIG_NOSYSTEM: "0",
        GIT_TERMINAL_PROMPT: "1",
      },
      signal: live(),
    });
    expect(ran).toMatchObject({ ok: true, value: { stdout: "" } });
    expect(ran.ok && ran.value.code).not.toBe(0);
    // A caller's own env that the floor does not own still wins.
    const withEnv = await runGitGroup(["config", "--get", "user.name"], {
      what: "git config",
      env: { PATH, GIT_CONFIG_GLOBAL: global, GIT_AUTHOR_NAME: "fixture" },
      signal: live(),
    });
    expect(withEnv).toMatchObject({ ok: true, value: { stdout: "" } });
  });

  test("a git that cannot start is spawn_failed", async () => {
    const ran = await runGitGroup(["--version"], {
      what: "git --version",
      env: { PATH: "/nonexistent" },
      signal: live(),
    });
    expect(ran).toMatchObject({
      ok: false,
      error: {
        class: "spawn_failed",
        message: expect.stringContaining("git --version: cannot run git"),
      },
    });
  });
});

describe("the token helper answers only its own forge host", () => {
  const TOKEN = "ghp_helper_standin_7a1c";
  /** `git credential fill` for `request`, through SAFE_GIT and the helper, the token in env only. */
  const fill = (request: string, env: Readonly<Record<string, string>>) =>
    spawnSync("git", safeGitArgs([...gitTokenFlags(), "credential", "fill"]), {
      input: request,
      encoding: "utf8",
      env: { PATH, ...env, ...GIT_ENV_FLOOR },
    });
  const asking = (protocol: string, host: string) =>
    `protocol=${protocol}\nhost=${host}\npath=acme/private.git\n\n`;

  test("its own host over https gets the token", () => {
    const r = fill(
      asking("https", "github.com"),
      gitTokenEnv(TOKEN, "github.com"),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`password=${TOKEN}`);
    expect(r.stdout).toContain("username=x-access-token");
  });

  test.each([
    ["another host", "https", "evil.example"],
    ["a host that only ends like it", "https", "notgithub.com"],
    ["plain http to its host", "http", "github.com"],
  ])("%s gets no password, and git asks nobody", (_, protocol, host) => {
    const r = fill(asking(protocol, host), gitTokenEnv(TOKEN, "github.com"));
    expect(r.stdout).not.toContain(TOKEN);
    expect(r.stderr).not.toContain(TOKEN);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("terminal prompts disabled");
  });

  test("no host in its env answers nobody", () => {
    const r = fill(asking("https", "github.com"), { [GIT_TOKEN_ENV]: TOKEN });
    expect(r.stdout).not.toContain(TOKEN);
    expect(r.status).not.toBe(0);
  });

  test("the helper text in argv never holds the token or the host", () => {
    const flags = gitTokenFlags().join(" ");
    expect(flags).not.toContain(TOKEN);
    expect(flags).not.toContain("github.com");
  });
});
