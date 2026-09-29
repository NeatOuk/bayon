import { describe, expect, test } from "vitest";
import {
  classifyRemoteFailure,
  displayUrl,
  parseLsRemote,
  redactCredentials,
  repoReachText,
  repoTokenSecret,
  storeSecretCommand,
  type RepoCheckResult,
} from "./repo-reach.js";

const result = (r: Partial<RepoCheckResult>): RepoCheckResult => ({
  outcome: "missing",
  default_branch: null,
  base_found: null,
  token_secret: null,
  token_offered: false,
  detail: "",
  ...r,
});

const KEYCHAIN = { kind: "keychain", service: "foreman" } as const;

describe("classifyRemoteFailure: git's own words", () => {
  test.each([
    [
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      "missing",
    ],
    [
      "remote: Repository not found.\nfatal: repository 'https://github.com/a/b.git/' not found",
      "missing",
    ],
    [
      "remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/'",
      "missing",
    ],
    [
      "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
      "missing",
    ],
    [
      "fatal: '/x/nope.git' does not appear to be a git repository\nfatal: Could not read from remote repository.",
      "missing",
    ],
    [
      "No ED25519 host key is known for example.com and you have requested strict checking.\nHost key verification failed.\nfatal: Could not read from remote repository.",
      "host_key",
    ],
    [
      "ssh: Could not resolve hostname nowhere.invalid: nodename nor servname provided\nfatal: Could not read from remote repository.",
      "unreachable",
    ],
    [
      "fatal: unable to access 'https://nowhere.invalid/x.git/': Could not resolve host: nowhere.invalid",
      "unreachable",
    ],
    [
      "fatal: unable to access 'https://127.0.0.1:9/x.git/': Failed to connect to 127.0.0.1 port 9: Couldn't connect to server",
      "unreachable",
    ],
    ["fatal: protocol error: bad pack header", "failed"],
    // Review L2: a missing ssh or git helper is not the operator's URL or access, and blocks nothing.
    [
      "ssh: command not found\nfatal: Could not read from remote repository.",
      "failed",
    ],
    ["git-remote-https: not found", "failed"],
    [
      "fatal: unable to access 'https://h/x.git/': The requested URL returned error: 403",
      "missing",
    ],
    ["ERROR: Permission to acme/shop.git denied to bob.", "missing"],
  ])("%s → %s", (stderr, outcome) => {
    expect(classifyRemoteFailure(stderr)).toBe(outcome);
  });
});

describe("parseLsRemote", () => {
  test("HEAD's branch and every head, from --symref", () => {
    const sha = "6aa9316e00774a79e7547529d9ba1968a9f7bafd";
    expect(
      parseLsRemote(
        `ref: refs/heads/trunk\tHEAD\n${sha}\tHEAD\n${sha}\trefs/heads/dev\n${sha}\trefs/heads/trunk\n`,
      ),
    ).toEqual({ heads: ["dev", "trunk"], defaultBranch: "trunk" });
  });

  test("an empty repository has neither", () => {
    expect(parseLsRemote("")).toEqual({ heads: [], defaultBranch: null });
  });
});

describe("credentials never reach a message", () => {
  test("userinfo and every secret value are masked, and the text is capped from its end", () => {
    const text =
      "fatal: unable to access 'https://bob:ghp_abc123@github.com/a/b.git/': tok ghp_abc123 refused";
    const masked = redactCredentials(text, ["ghp_abc123"]);
    expect(masked).not.toContain("ghp_abc123");
    expect(masked).not.toContain("bob");
    expect(masked).toContain("https://github.com/a/b.git/");
    expect(redactCredentials("x".repeat(400), [], 50)).toHaveLength(50);
  });

  test("userinfo is cut up to the last @ of the authority, and an ssh password goes too (review L1)", () => {
    const masked = redactCredentials(
      "fatal: 'https://bob:p@ss@github.com/a/b.git' and ssh://git:hunter2@host.example/x.git",
    );
    expect(masked).toContain("'https://github.com/a/b.git'");
    expect(masked).toContain("ssh://git@host.example/x.git");
    expect(masked).not.toMatch(/p@ss|ss@|hunter2|bob/);
  });

  test("a URL shown in a sentence loses its userinfo; an ssh user stays", () => {
    expect(displayUrl("https://bob:s3cret@github.com/a/b.git")).toBe(
      "https://github.com/a/b.git",
    );
    expect(displayUrl("git@github.com:a/b.git")).toBe("git@github.com:a/b.git");
    const text = repoReachText(
      "https://bob:s3cret@example.com/a/b.git",
      result({ outcome: "unreachable" }),
      null,
    );
    expect(JSON.stringify(text)).not.toContain("s3cret");
  });
});

describe("repoReachText: what happened, then what to do", () => {
  const GH = "https://github.com/acme/private.git";

  test("found names the default branch", () => {
    expect(
      repoReachText(
        GH,
        result({ outcome: "found", default_branch: "main" }),
        null,
      ).message,
    ).toBe(`Found ${GH}. Its default branch is main.`);
  });

  test("missing on a forge with no token names the secret and the command that stores it", () => {
    const text = repoReachText(
      GH,
      result({ token_secret: "FORGE_TOKEN_GITHUB" }),
      KEYCHAIN,
    );
    expect(text.message).toContain("does not exist, or it is private");
    expect(text.message).toContain("FORGE_TOKEN_GITHUB");
    expect(text.command).toBe(
      "security add-generic-password -U -s foreman -a FORGE_TOKEN_GITHUB -w",
    );
  });

  test("missing with the token offered says the token has no access", () => {
    const text = repoReachText(
      GH,
      result({ token_secret: "FORGE_TOKEN_GITHUB", token_offered: true }),
      { kind: "file", service: null },
    );
    expect(text.message).toContain("with the token in FORGE_TOKEN_GITHUB");
    expect(text.command).toContain(
      "secrets.sh put <deployment> supervisor FORGE_TOKEN_GITHUB",
    );
  });

  test("missing with no store hint says where without a command", () => {
    const text = repoReachText(
      GH,
      result({ token_secret: "FORGE_TOKEN_GITHUB" }),
      null,
    );
    expect(text.message).toContain("in the host secret store");
    expect(text.command).toBeNull();
  });

  test("missing over ssh points at the key", () => {
    expect(
      repoReachText("git@github.com:acme/private.git", result({}), null)
        .message,
    ).toContain("ssh key has no access");
  });

  test("an unknown host key gives the keyscan line, with its port", () => {
    expect(
      repoReachText(
        "ssh://git@git.example.com:2222/a/b.git",
        result({ outcome: "host_key" }),
        null,
      ).command,
    ).toBe("ssh-keyscan -p 2222 git.example.com >> ~/.ssh/known_hosts");
    expect(
      repoReachText(
        "git@github.com:a/b.git",
        result({ outcome: "host_key" }),
        null,
      ).command,
    ).toBe("ssh-keyscan github.com >> ~/.ssh/known_hosts");
  });

  test("unreachable and timeout name the host", () => {
    expect(
      repoReachText(GH, result({ outcome: "unreachable" }), null).message,
    ).toContain("Bayon cannot reach github.com");
    expect(
      repoReachText(GH, result({ outcome: "timeout" }), null).message,
    ).toContain("github.com did not answer within 20 s");
  });

  test("anything else quotes git", () => {
    expect(
      repoReachText(GH, result({ outcome: "failed", detail: "bad pack" }), null)
        .message,
    ).toBe(`git could not read ${GH}. git said: bad pack`);
  });
});

test("the token secret follows delivery's rule: https on a forge only", () => {
  expect(repoTokenSecret("https://github.com/a/b.git")).toBe(
    "FORGE_TOKEN_GITHUB",
  );
  expect(repoTokenSecret("git@github.com:a/b.git")).toBeNull();
  expect(repoTokenSecret("https://git.example.com/a/b.git")).toBeNull();
  expect(storeSecretCommand("X", null)).toBeNull();
});
