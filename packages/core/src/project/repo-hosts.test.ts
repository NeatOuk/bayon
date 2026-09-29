import { describe, expect, test } from "vitest";
import {
  PrivateRepoHosts,
  addressKind,
  repoHostProblem,
} from "./repo-hosts.js";

describe("addressKind", () => {
  test.each([
    ["169.254.169.254", "link_local"],
    ["fe80::1", "link_local"],
    ["[fe80::1]", "link_local"],
    ["127.0.0.1", "loopback"],
    ["::1", "loopback"],
    ["localhost", "loopback"],
    ["10.1.2.3", "private"],
    ["172.16.0.9", "private"],
    ["172.32.0.9", "public"],
    ["192.168.1.10", "private"],
    ["100.64.0.1", "private"],
    ["fd12::1", "private"],
    ["::ffff:10.0.0.1", "private"],
    ["140.82.112.3", "public"],
    ["github.com", "public"],
  ])("%s is %s", (host, kind) => {
    expect(addressKind(host)).toBe(kind);
  });
});

describe("repoHostProblem", () => {
  test("a public host, literal or resolved, is fine", () => {
    expect(
      repoHostProblem("https://github.com/a/b.git", ["140.82.112.3"], []),
    ).toBeNull();
  });

  test("link-local and metadata are refused always, allowed list or not", () => {
    for (const url of [
      "https://169.254.169.254/latest/meta-data",
      "https://[fe80::1]/x.git",
      "https://metadata.google.internal/x.git",
      "https://2852039166/x.git",
    ]) {
      expect(repoHostProblem(url, [], ["169.254.169.254"])).toContain(
        "link-local or cloud metadata",
      );
    }
    // A public name that resolves there is refused too.
    expect(
      repoHostProblem("https://evil.example/x.git", ["169.254.169.254"], []),
    ).toContain("link-local");
  });

  test("loopback and private hosts need the host listed, and say how to list it", () => {
    const refused = repoHostProblem("git@git.lan:a/b.git", ["192.168.1.5"], []);
    expect(refused).toBe(
      "git.lan is on a private network, and Bayon reads a repository there only when you allow its host. If it is your own git server, add it from a terminal: pnpm frm settings set projects.private_repo_hosts git.lan --yes",
    );
    expect(
      repoHostProblem("git@git.lan:a/b.git", ["192.168.1.5"], ["git.lan"]),
    ).toBeNull();
    expect(repoHostProblem("https://127.0.0.1/x.git", [], [])).toContain(
      "this machine itself",
    );
    expect(
      repoHostProblem("https://127.0.0.1/x.git", [], ["127.0.0.1"]),
    ).toBeNull();
  });

  test("the setting's schema takes lower-case hosts only", () => {
    expect(PrivateRepoHosts.safeParse(["git.lan", "10.0.0.2"]).success).toBe(
      true,
    );
    expect(PrivateRepoHosts.safeParse(["https://git.lan"]).success).toBe(false);
    expect(PrivateRepoHosts.safeParse(["Git.Lan"]).success).toBe(false);
  });
});
