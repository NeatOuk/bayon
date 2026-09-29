import { describe, expect, test } from "vitest";
import {
  checkPushUrl,
  pushTargetOf,
  stripPushUrlCredentials,
} from "./push-url.js";

// A push target's shape (migration 039): the three spellings forgeRemote reads, and never a
// credential that could be a secret (§14).

const refused = (url: string) => {
  const r = checkPushUrl(url);
  expect(r.ok, url).toBe(false);
  return r.ok ? "" : r.error.message;
};

describe("checkPushUrl", () => {
  test.each([
    "https://forge.example/owner/repo.git",
    "https://forge.example:8443/group/sub/repo",
    "HTTPS://Forge.Example/owner/repo",
    "ssh://git@forge.example/owner/repo.git",
    "ssh://git@forge.example:2222/owner/repo.git",
    "ssh://forge.example/srv/repo.git",
    "git@forge.example:owner/repo.git",
    "deploy@forge.example:/srv/git/repo.git",
    "ssh://git@[::1]:22/owner/repo.git",
  ])("accepts %s", (url) => {
    expect(checkPushUrl(url)).toEqual({ ok: true, value: url });
  });

  test("trims what it accepts", () => {
    expect(checkPushUrl("  git@forge.example:o/r.git \n")).toEqual({
      ok: true,
      value: "git@forge.example:o/r.git",
    });
  });

  test.each([
    "http://forge.example/owner/repo.git",
    "file:///srv/repo.git",
    "/Users/someone/src/repo",
    "../repo",
    "forge.example/owner/repo",
    "https://forge.example",
    "https://forge.example/",
    "https:///owner/repo",
    "https://bad_host!/owner/repo",
    "git@bad_host!:owner/repo",
    "ext::sh -c touch% /tmp/x",
    "http://user@forge.example:owner/repo",
  ])("refuses %s with one sentence naming the shapes", (url) => {
    expect(refused(url)).toMatch(
      /must be an https:\/\/, ssh:\/\/ or git@host:path URL\.$/,
    );
  });

  test.each([
    "https://user@forge.example/owner/repo.git",
    "https://user:secret@forge.example/owner/repo.git",
    "https://a-token@forge.example/owner/repo.git",
    "ssh://git:secret@forge.example/owner/repo.git",
    "ssh://:secret@forge.example/owner/repo.git",
    "git:secret@forge.example:owner/repo.git",
  ])("refuses credentials in %s, without echoing them", (url) => {
    const message = refused(url);
    expect(message).toMatch(/must not carry credentials/);
    expect(message).not.toContain("secret@");
    expect(message).not.toContain("a-token");
  });

  test("refuses a blank and an oversized target", () => {
    expect(refused("   ")).toMatch(/cannot be empty/);
    expect(refused(`https://forge.example/${"a".repeat(2_000)}`)).toMatch(
      /at most 2000 characters/,
    );
  });
});

describe("checkPushUrl refuses an ssh login or path that ssh would read as an option", () => {
  test.each([
    "ssh://-oProxyCommand=touch x;true@example.com/o/r.git",
    "-oProxyCommand=touch x;true@example.com:o/r.git",
    "ssh://-oProxyCommand=x@example.com/o/r.git",
    "-oProxyCommand=x@example.com:o/r.git",
    "ssh://@forge.example/owner/repo",
    "ssh://git%20x@forge.example/owner/repo",
    "gi$t@forge.example:o/r.git",
  ])("%s", (url) => {
    expect(refused(url)).toMatch(
      /ssh login that is not a plain name|must be an https:\/\/, ssh:\/\/ or git@host:path URL/,
    );
  });

  test("an scp-like path starting with '-' is refused", () => {
    expect(refused("git@example.com:-oProxyCommand=x")).toMatch(
      /must be an https:\/\/, ssh:\/\/ or git@host:path URL/,
    );
  });

  test.each([
    "git@h.example:o/r.git",
    "deploy_bot.1@h.example:o/r.git",
    "_x@h.example:o/r",
  ])("a plain login is fine: %s", (url) => {
    expect(checkPushUrl(url).ok).toBe(true);
  });
});

describe("stripPushUrlCredentials", () => {
  test.each([
    [
      "https://user:secret@forge.example/owner/repo.git",
      "https://forge.example/owner/repo.git",
    ],
    [
      "https://a-token@forge.example:8443/owner/repo.git",
      "https://forge.example:8443/owner/repo.git",
    ],
    [
      "ssh://git:secret@forge.example/owner/repo.git",
      "ssh://git@forge.example/owner/repo.git",
    ],
    [
      "ssh://:secret@forge.example/owner/repo.git",
      "ssh://forge.example/owner/repo.git",
    ],
    [
      "git:secret@forge.example:owner/repo.git",
      "git@forge.example:owner/repo.git",
    ],
    // Schemes it will refuse lose theirs too, so a warning may name them.
    ["http://user:secret@forge.example/o/r", "http://forge.example/o/r"],
    ["file://user:secret@host/x", "file://host/x"],
    // A password holding `@`: the host is what follows the LAST one.
    [
      "https://user:p@ss@forge.example/owner/repo.git",
      "https://forge.example/owner/repo.git",
    ],
  ])("%s → %s", (given, want) => {
    const out = stripPushUrlCredentials(given);
    expect(out).toEqual({ url: want, stripped: true });
    expect(out.url).not.toContain("secret");
  });

  test.each([
    "https://forge.example/owner/repo.git",
    "ssh://git@forge.example/owner/repo.git",
    "git@forge.example:owner/repo.git",
    "/Users/someone/src/repo",
    "http://forge.example/owner/repo.git",
  ])("leaves %s exactly as it was", (url) => {
    expect(stripPushUrlCredentials(url)).toEqual({ url, stripped: false });
  });

  test("trims", () => {
    expect(stripPushUrlCredentials(" git@h:o/r ")).toEqual({
      url: "git@h:o/r",
      stripped: false,
    });
  });
});

describe("pushTargetOf", () => {
  test("the push target wins; blank or null falls back to the origin", () => {
    expect(pushTargetOf({ push_url: "git@h:o/r", origin_url: "/src/r" })).toBe(
      "git@h:o/r",
    );
    expect(pushTargetOf({ push_url: null, origin_url: "/src/r" })).toBe(
      "/src/r",
    );
    expect(pushTargetOf({ push_url: "  ", origin_url: "/src/r" })).toBe(
      "/src/r",
    );
    expect(pushTargetOf({ push_url: null, origin_url: null })).toBeNull();
  });
});
