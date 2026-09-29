// A clone or fetch that failed, in plain words: the class and retryability unwind reads,
// and a message that names the fix and never a credential.
import { describe, expect, test } from "vitest";
import { NO_GIT_AUTH } from "../forge/credential.js";
import { repoReadFailure, RepoReadCause } from "./repo-failure.js";

const TOKEN = "ghp_secret_value_1";
const AUTH = {
  flags: ["-c", "credential.helper=!f"],
  env: { FRM_FORGE_TOKEN: TOKEN, FRM_FORGE_HOST: "github.com" },
};
const base = {
  repoId: "shop",
  url: "https://github.com/acme/shop.git",
  auth: NO_GIT_AUTH,
  code: 128,
  what: "git clone --bare of repo shop",
};

describe("repoReadFailure", () => {
  test("not found or no access: repo_unreachable, not retryable, the secret named", () => {
    const e = repoReadFailure({
      ...base,
      stderr:
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    });
    expect(e).toMatchObject({ class: "repo_unreachable", retryable: false });
    expect(e.message).toContain(
      "store a token that can read it as FORGE_TOKEN_GITHUB",
    );
    expect(RepoReadCause.parse(e.cause)).toEqual({
      repo_id: "shop",
      outcome: "missing",
      branch: null,
    });
  });

  test("with a token offered, its value never reaches the message", () => {
    const e = repoReadFailure({
      ...base,
      auth: AUTH,
      stderr: `remote: Repository not found. token ${TOKEN}\nfatal: repository 'https://x:${TOKEN}@github.com/acme/shop.git/' not found`,
    });
    expect(e.message).toContain("with the token in FORGE_TOKEN_GITHUB");
    expect(e.message).not.toContain(TOKEN);
  });

  test("an unknown host key gives the keyscan command", () => {
    const e = repoReadFailure({
      ...base,
      url: "git@git.example.com:acme/shop.git",
      stderr: "Host key verification failed.",
    });
    expect(e.class).toBe("repo_unreachable");
    expect(e.message).toContain(
      "Run: ssh-keyscan git.example.com >> ~/.ssh/known_hosts",
    );
  });

  test("a host that cannot be reached is retryable", () => {
    const e = repoReadFailure({
      ...base,
      stderr: "fatal: unable to access: Could not resolve host: github.com",
    });
    expect(e).toMatchObject({ class: "repo_unreachable", retryable: true });
  });

  test("a base branch the remote does not have, on a fetch", () => {
    const e = repoReadFailure({
      ...base,
      what: "git fetch",
      branch: "main",
      stderr: "fatal: couldn't find remote ref refs/heads/main",
    });
    expect(e).toMatchObject({ class: "repo_unreachable", retryable: false });
    expect(e.message).toContain("has no branch main");
    expect(RepoReadCause.parse(e.cause).outcome).toBe("no_branch");
  });

  test("anything else stays spawn_failed, git's words redacted", () => {
    const e = repoReadFailure({
      ...base,
      auth: AUTH,
      stderr: `fatal: bad pack header ${TOKEN}`,
    });
    expect(e.class).toBe("spawn_failed");
    expect(e.message).toBe(
      "git clone --bare of repo shop failed: fatal: bad pack header ***",
    );
  });
});
