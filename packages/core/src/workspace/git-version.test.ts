import { describe, expect, test } from "vitest";
import {
  DEFAULT_GIT_PATCHED,
  gitVersionProblem,
  parseGitVersion,
} from "./git-version.js";

describe("the git floor for submodule workspaces (M3)", () => {
  test("parses Apple's, Debian's and a two-part version", () => {
    expect(parseGitVersion("git version 2.50.1 (Apple Git-155)")).toBe(
      "2.50.1",
    );
    expect(parseGitVersion("git version 2.39.5\n")).toBe("2.39.5");
    expect(parseGitVersion("git version 2.51")).toBe("2.51.0");
    expect(parseGitVersion("not git")).toBeNull();
  });

  test.each(["2.50.1", "2.49.1", "2.49.2", "2.43.7", "2.51.0", "3.0.0"])(
    "%s is accepted",
    (v) => {
      expect(gitVersionProblem(v, DEFAULT_GIT_PATCHED)).toBeNull();
    },
  );

  test("a listed series below its fixed patch is refused, naming the series floor", () => {
    expect(gitVersionProblem("2.49.0", DEFAULT_GIT_PATCHED)).toBe(
      "git 2.49.0 is not fixed for CVE-2024-32002 and CVE-2025-48384, so it may not check submodules out: the floor for its 2.49 series is 2.49.1",
    );
    expect(gitVersionProblem("2.50.0", DEFAULT_GIT_PATCHED)).toContain(
      "the floor for its 2.50 series is 2.50.1",
    );
  });

  test("an unlisted older series (Debian bookworm's 2.39.5) is refused: no whitelist", () => {
    expect(gitVersionProblem("2.39.5", DEFAULT_GIT_PATCHED)).toBe(
      "git 2.39.5 is not fixed for CVE-2024-32002 and CVE-2025-48384, so it may not check submodules out: the floor is 2.50.1 or a fixed release of an older series (2.43.7, 2.44.4, 2.45.4, 2.46.4, 2.47.3, 2.48.2, 2.49.1, 2.50.1)",
    );
  });
});
