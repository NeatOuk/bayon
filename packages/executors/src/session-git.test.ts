// SESSION_GIT_ENV against real git. Every claim is a differential: one hostile host,
// planted once, then the same git run as a session's model runs it — with nothing of ours on its
// argv — first without the floor (the plant is real: each thing acts) and then with it (none does).
// A test of the env's keys alone would pass against a floor git does not read the way we think.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitIdentityEnv } from "@bayon/core";
import { afterAll, describe, expect, test } from "vitest";
import {
  GIT_ENV_FLOOR,
  SAFE_GIT,
  SESSION_GIT_ENV,
  gitTokenEnv,
  gitTokenFlags,
  safeGitArgs,
} from "./git.js";

const PATH = process.env["PATH"] ?? "/usr/bin:/bin";
const root = realpathSync(mkdtempSync(join(tmpdir(), "frm-session-git-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The install's agent identity, as buildEnv puts it in every session. */
const AGENT = gitIdentityEnv({
  name: "Bayon Agent",
  email: "agent@bayon.invalid",
});
/** What a planted credential helper hands out. */
const STOLEN = "operator-forge-credential";
const FORGE = "https://forge.invalid/";
const REDIRECT = "file:///redirected/";

/** A program that leaves `marker` behind and, asked for a credential, answers with STOLEN. */
function program(path: string, marker: string): string {
  writeFileSync(
    path,
    `#!/bin/sh\ntouch "${marker}"\n[ "$1" = get ] && printf 'username=operator\\npassword=${STOLEN}\\n'\nexit 0\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

interface Host {
  /** The session's inherited env without the floor: the planted HOME and system file, the identity. */
  readonly env: Readonly<Record<string, string>>;
  readonly marker: (name: string) => string;
  readonly dir: string;
}

/**
 * A host whose git config would act on the model's behalf. `~/.gitconfig` names a credential
 * helper, an `insteadOf` and a hooks path; the system file (GIT_CONFIG_SYSTEM, standing in for the
 * one a platform git ships with a keychain helper in it) names a helper of its own.
 */
function hostileHost(): Host {
  const dir = mkdtempSync(join(root, "host-"));
  const home = join(dir, "home");
  const markers = join(dir, "markers");
  const hooks = join(dir, "hooks");
  for (const d of [home, markers, hooks]) mkdirSync(d);
  const marker = (name: string) => join(markers, name);
  for (const hook of ["pre-commit", "post-commit"]) {
    program(join(hooks, hook), marker(`global-${hook}`));
  }
  writeFileSync(
    join(home, ".gitconfig"),
    [
      "[credential]",
      `\thelper = ${program(join(dir, "global-helper"), marker("global-helper"))}`,
      `[url "${REDIRECT}"]`,
      `\tinsteadOf = ${FORGE}`,
      "[core]",
      `\thooksPath = ${hooks}`,
      "",
    ].join("\n"),
  );
  const system = join(dir, "system-gitconfig");
  writeFileSync(
    system,
    `[credential]\n\thelper = ${program(join(dir, "system-helper"), marker("system-helper"))}\n`,
  );
  return {
    env: { PATH, HOME: home, GIT_CONFIG_SYSTEM: system, ...AGENT },
    marker,
    dir,
  };
}

/** Plain git, as the model types it: no flag of ours, only the env it inherited. */
const git = (
  env: Readonly<Record<string, string>>,
  cwd: string,
  args: readonly string[],
  input?: string,
) =>
  spawnSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
  });

const ASK = `protocol=https\nhost=forge.invalid\npath=acme/private.git\n\n`;

/** A repository with one file staged, ready for the model's commit. */
function repo(h: Host, name: string): string {
  const dir = join(h.dir, name);
  mkdirSync(dir);
  expect(git(h.env, dir, ["init", "-q", "-b", "main"]).status).toBe(0);
  writeFileSync(join(dir, "a.txt"), "a\n");
  return dir;
}

describe("the planted host acts on git without the floor: the plant is real", () => {
  const h = hostileHost();

  test("its helpers answer a credential request with the operator's credential", () => {
    const r = git(h.env, h.dir, ["credential", "fill"], ASK);
    expect(r.stdout).toContain(`password=${STOLEN}`);
    expect(existsSync(h.marker("system-helper"))).toBe(true);
    expect(
      git(h.env, h.dir, ["config", "--get", "credential.helper"]).stdout.trim(),
    ).toBe(join(h.dir, "global-helper"));
  });

  test("its insteadOf redirects the forge", () => {
    const r = git(h.env, h.dir, ["ls-remote", "--get-url", `${FORGE}x.git`]);
    expect(r.stdout.trim()).toBe(`${REDIRECT}x.git`);
  });

  test("its hooks run on a commit", () => {
    const dir = repo(h, "plain");
    expect(git(h.env, dir, ["add", "a.txt"]).status).toBe(0);
    expect(git(h.env, dir, ["commit", "-q", "-m", "x"]).status).toBe(0);
    expect(existsSync(h.marker("global-pre-commit"))).toBe(true);
  });
});

describe("under SESSION_GIT_ENV none of it acts, and the model's work still does", () => {
  const h = hostileHost();
  const env = { ...h.env, ...SESSION_GIT_ENV };

  test("no helper runs: the credential request fails fast, asking nobody", () => {
    const r = git(env, h.dir, ["credential", "fill"], ASK);
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain(STOLEN);
    expect(r.stderr).toContain("terminal prompts disabled");
    expect(existsSync(h.marker("system-helper"))).toBe(false);
    expect(existsSync(h.marker("global-helper"))).toBe(false);
    expect(
      git(env, h.dir, ["config", "--get", "credential.helper"]).stdout.trim(),
    ).toBe("");
  });

  test("no insteadOf: the forge's URL is the forge's", () => {
    const r = git(env, h.dir, ["ls-remote", "--get-url", `${FORGE}x.git`]);
    expect(r.stdout.trim()).toBe(`${FORGE}x.git`);
  });

  test("status, add, commit, log and branch work, as the agent, and no hook runs", () => {
    const dir = repo(h, "work");
    for (const args of [
      ["status", "--short"],
      ["add", "a.txt"],
      ["commit", "-q", "-m", "the agent's commit"],
      ["branch", "agent/x"],
      ["diff", "HEAD"],
    ]) {
      const r = git(env, dir, args);
      expect(r.status, `${args.join(" ")}: ${r.stderr}`).toBe(0);
    }
    const who = git(env, dir, ["log", "-1", "--format=%an <%ae>|%cn <%ce>"]);
    expect(who.stdout.trim()).toBe(
      "Bayon Agent <agent@bayon.invalid>|Bayon Agent <agent@bayon.invalid>",
    );
    expect(existsSync(h.marker("global-pre-commit"))).toBe(false);
    expect(existsSync(h.marker("global-post-commit"))).toBe(false);
  });
});

describe("a repository's own config cannot hand a pinned key back", () => {
  // What an agent could write into the worktree's (or the shared mirror's) config file itself:
  // `git config` is denied to every session, but the file is only a file.
  const LOCAL = ["local-hook", "git-hook", "fsmonitor", "local-helper"];

  /** A repo whose own config names a hooks path, an fsmonitor and a helper, plus a .git/hooks hook. */
  function plantedRepo(h: Host): string {
    const dir = repo(h, "local");
    const hooks = join(dir, "own-hooks");
    mkdirSync(hooks);
    program(join(hooks, "pre-commit"), h.marker("local-hook"));
    program(join(dir, ".git", "hooks", "pre-commit"), h.marker("git-hook"));
    for (const [key, value] of [
      ["core.hooksPath", hooks],
      ["core.fsmonitor", program(join(h.dir, "fsm"), h.marker("fsmonitor"))],
      [
        "credential.helper",
        program(join(h.dir, "local-helper"), h.marker("local-helper")),
      ],
    ] as const) {
      expect(git(h.env, dir, ["config", key, value]).status).toBe(0);
    }
    return dir;
  }

  /** status, add, commit and a credential request, as the model runs them under `env`. */
  function work(env: Readonly<Record<string, string>>, dir: string): string {
    expect(git(env, dir, ["status", "--short"]).status).toBe(0);
    expect(git(env, dir, ["add", "a.txt"]).status).toBe(0);
    expect(git(env, dir, ["commit", "-q", "-m", "x"]).status).toBe(0);
    return git(env, dir, ["credential", "fill"], ASK).stdout;
  }

  test("under GIT_ENV_FLOOR alone, the repo's hooks path, fsmonitor and helper each run", () => {
    // System and global config shut out, as the supervisor's own git had it before the pairs: what
    // is left is the repository's own file, which only the pairs outrank.
    const h = hostileHost();
    const answered = work({ ...h.env, ...GIT_ENV_FLOOR }, plantedRepo(h));
    expect(answered).toContain(STOLEN);
    for (const name of ["local-hook", "fsmonitor", "local-helper"]) {
      expect(existsSync(h.marker(name)), name).toBe(true);
    }
  });

  test("with it, none does: the floor is git's command scope, above every file", () => {
    const h = hostileHost();
    const answered = work({ ...h.env, ...SESSION_GIT_ENV }, plantedRepo(h));
    expect(answered).not.toContain(STOLEN);
    for (const name of LOCAL) {
      expect(existsSync(h.marker(name)), name).toBe(false);
    }
  });
});

describe("the floor's shape", () => {
  test("it is GIT_ENV_FLOOR and SAFE_GIT's pairs, derived, nothing else", () => {
    expect(SESSION_GIT_ENV).toEqual({
      ...GIT_ENV_FLOOR,
      GIT_CONFIG_COUNT: "6",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/dev/null",
      GIT_CONFIG_KEY_1: "core.fsmonitor",
      GIT_CONFIG_VALUE_1: "false",
      GIT_CONFIG_KEY_2: "maintenance.auto",
      GIT_CONFIG_VALUE_2: "false",
      GIT_CONFIG_KEY_3: "gc.auto",
      GIT_CONFIG_VALUE_3: "0",
      GIT_CONFIG_KEY_4: "credential.helper",
      GIT_CONFIG_VALUE_4: "",
      GIT_CONFIG_KEY_5: "core.askpass",
      GIT_CONFIG_VALUE_5: "",
    });
    const count = Number(SESSION_GIT_ENV["GIT_CONFIG_COUNT"]);
    expect(count * 2).toBe(SAFE_GIT.length);
    for (let i = 0; i < count; i += 1) {
      expect(
        `${SESSION_GIT_ENV[`GIT_CONFIG_KEY_${i}`]}=${SESSION_GIT_ENV[`GIT_CONFIG_VALUE_${i}`]}`,
      ).toBe(SAFE_GIT[2 * i + 1]);
    }
  });

  test("a -c on git's command line still wins, so the supervisor's own flags work under it", () => {
    // A job's process inherits a session's env and runs our git with gitTokenFlags after SAFE_GIT.
    const token = "ghp_floor_standin_91d2";
    const r = spawnSync(
      "git",
      safeGitArgs([...gitTokenFlags(), "credential", "fill"]),
      {
        input: ASK,
        encoding: "utf8",
        env: {
          PATH,
          ...SESSION_GIT_ENV,
          ...gitTokenEnv(token, "forge.invalid"),
        },
      },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`password=${token}`);
  });
});
