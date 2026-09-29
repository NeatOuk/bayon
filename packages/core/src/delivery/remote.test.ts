import { describe, expect, test } from "vitest";
import {
  FORGE_TOKEN_SECRETS,
  forgeRemote,
  forgeTokenSecret,
  isHttpsUrl,
  remoteHost,
} from "./remote.js";

// an earlier change spike §1.4: the forge kind comes from a remote's host and from nothing else. The
// fixtures here are deliberately anonymous — `owner/repo` — because a control plane that knows one
// organisation's name is no longer generic.

const OWNER = "an-owner";
const REPO = "a-repo";

describe("forgeRemote over the spellings an operator pastes", () => {
  test.each([
    ["https", `https://github.com/${OWNER}/${REPO}.git`],
    ["https, no .git", `https://github.com/${OWNER}/${REPO}`],
    ["https, trailing slash", `https://github.com/${OWNER}/${REPO}/`],
    ["scp-like ssh", `git@github.com:${OWNER}/${REPO}.git`],
    ["ssh:// URL", `ssh://git@github.com/${OWNER}/${REPO}.git`],
    ["host cased oddly", `https://GitHub.com/${OWNER}/${REPO}.git`],
    ["padded", `  https://github.com/${OWNER}/${REPO}.git  `],
  ])("%s", (_what, url) => {
    expect(forgeRemote(url)).toEqual({
      kind: "github",
      host: "github.com",
      owner: OWNER,
      repo: REPO,
      apiBase: "https://api.github.com",
    });
  });
});

describe("no kind", () => {
  test.each([
    [
      "an unsupported host, https",
      `https://git.example.org/${OWNER}/${REPO}.git`,
    ],
    ["an unsupported host, ssh", `git@git.example.org:${OWNER}/${REPO}.git`],
    ["a bare path (a test's local remote)", "/srv/mirrors/a-repo.git"],
    ["a file:// URL", "file:///srv/mirrors/a-repo.git"],
    ["plain http", `http://github.com/${OWNER}/${REPO}.git`],
    ["a program transport", "ext::sh -c payload"],
    ["one segment", "https://github.com/one-segment"],
    ["three segments", `https://github.com/${OWNER}/a/b`],
    ["empty", ""],
    ["whitespace", "   "],
  ])("%s has none", (_what, url) => {
    expect(forgeRemote(url)).toBeNull();
  });
});

test("a subgroup host that is not a known forge stays unknown", () => {
  expect(forgeRemote("https://github.com.evil.example/a/b")).toBeNull();
});

test("the token's name is the kind's, never a project's", () => {
  expect(forgeTokenSecret("github")).toBe("FORGE_TOKEN_GITHUB");
  expect(FORGE_TOKEN_SECRETS).toEqual(["FORGE_TOKEN_GITHUB"]);
});

test("only an https URL may be offered a token", () => {
  expect(isHttpsUrl(`https://github.com/${OWNER}/${REPO}.git`)).toBe(true);
  expect(isHttpsUrl(`git@github.com:${OWNER}/${REPO}.git`)).toBe(false);
  expect(isHttpsUrl(`http://github.com/${OWNER}/${REPO}.git`)).toBe(false);
  expect(isHttpsUrl("/srv/mirrors/a-repo.git")).toBe(false);
});

test("remoteHost keeps the host and never the URL", () => {
  expect(remoteHost(`https://git.example.org/${OWNER}/${REPO}.git`)).toBe(
    "git.example.org",
  );
  expect(remoteHost(`git@git.example.org:${OWNER}/${REPO}.git`)).toBe(
    "git.example.org",
  );
  expect(remoteHost("/srv/mirrors/a-repo.git")).toBeNull();
  expect(remoteHost("")).toBeNull();
});
