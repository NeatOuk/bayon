// module-gitdir.ts: the gitdir git gives each submodule of a linked worktree,
// computed rather than discovered. The layout itself — `<parent gitdir>/modules/<path under the
// parent>`, nested — is asserted against real git in workspace-multi.test.ts; this is the shape.
import { describe, expect, test } from "vitest";
import { moduleGitDirs } from "./module-gitdir.js";

const SUPER = "/frm/mirrors/super.git/worktrees/wt-1";

describe("moduleGitDirs", () => {
  test("a submodule's gitdir is under the superproject's modules/, a nested one under its parent's", () => {
    expect([
      ...moduleGitDirs(SUPER, [
        "libs/mid",
        "libs/mid/vendor/leaf",
        "tools/other",
      ]),
    ]).toEqual([
      ["libs/mid", `${SUPER}/modules/libs/mid`],
      ["tools/other", `${SUPER}/modules/tools/other`],
      ["libs/mid/vendor/leaf", `${SUPER}/modules/libs/mid/modules/vendor/leaf`],
    ]);
  });

  test("the nearest declared parent wins, whatever order the rows arrive in", () => {
    const deep = moduleGitDirs(SUPER, ["a/b/c/d", "a/b/c", "a", "a/b/c/d/e"]);
    expect(deep.get("a/b/c/d/e")).toBe(
      `${SUPER}/modules/a/modules/b/c/modules/d/modules/e`,
    );
    // `a/b` is not declared, so `a/b/c` hangs off `a` with `b/c` as its path there.
    expect(deep.get("a/b/c")).toBe(`${SUPER}/modules/a/modules/b/c`);
  });

  test("a path that is not one inside the superproject gets no gitdir: a caller must skip, not guess", () => {
    const dirs = moduleGitDirs(SUPER, [
      "",
      ".",
      "..",
      "libs/../../etc",
      "/abs/path",
      "libs//mid",
      "ok",
    ]);
    expect([...dirs.keys()]).toEqual(["ok"]);
  });
});
