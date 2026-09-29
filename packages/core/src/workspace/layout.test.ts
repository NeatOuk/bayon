import { describe, expect, test } from "vitest";
import {
  relPathProblem,
  submodulePathProblem,
  workspaceLayout,
  type LayoutRow,
} from "./layout.js";

const row = (id: string, over: Partial<LayoutRow> = {}): LayoutRow => ({
  id,
  rel_path: id,
  role: "dep",
  submodule_path: null,
  has_submodules: 0,
  ...over,
});

const message = (r: ReturnType<typeof workspaceLayout>): string =>
  r.ok ? "(ok)" : r.error.message;

describe("relPathProblem and submodulePathProblem (L1)", () => {
  test.each([
    ["", "is empty"],
    ["/abs", "is absolute"],
    ["a\\b", "contains a backslash"],
    ["a\nb", "contains a control character"],
    ["a//b", "has an empty segment"],
    ["a/", "has an empty segment"],
    ["./a", "has a '.' or '..' segment"],
    ["a/../b", "has a '.' or '..' segment"],
  ])("rel_path %j %s", (path, why) => {
    expect(relPathProblem(path)).toBe(why);
  });

  test("a clean relative path passes", () => {
    expect(relPathProblem("libs/mid")).toBeNull();
    expect(submodulePathProblem("libs/mid/vendor/leaf")).toBeNull();
  });

  test.each([
    ["libs/.git", "has a .git segment"],
    ["libs/.GiT/x", "has a .git segment"],
    ["libs/-x", "has a segment starting with '-'"],
    ["libs/a b", 'has a segment outside [A-Za-z0-9._@+-]: "a b"'],
    ["libs/$x", 'has a segment outside [A-Za-z0-9._@+-]: "$x"'],
    ["../x", "has a '.' or '..' segment"],
  ])("submodule_path %j %s", (path, why) => {
    expect(submodulePathProblem(path)).toBe(why);
  });
});

describe("workspaceLayout", () => {
  test("single: its one repo is the primary, whatever its role", () => {
    const r = workspaceLayout("single", [row("app")]);
    expect(r.ok && r.value.primary.id).toBe("app");
    expect(r.ok && r.value.extras).toEqual([]);
  });

  test("single refuses two repos, a repo with submodules, a submodule_path", () => {
    expect(message(workspaceLayout("single", [row("a"), row("b")]))).toBe(
      "a single workspace has exactly one repo, not 2",
    );
    expect(
      message(workspaceLayout("single", [row("a", { has_submodules: 1 })])),
    ).toBe("repo a has submodules: its workspace's kind is submodule");
    expect(
      message(workspaceLayout("single", [row("a", { submodule_path: "x" })])),
    ).toBe("repo a: a single workspace has no submodule_path");
  });

  test("multi: one primary, the deps as extras sorted by rel_path", () => {
    const r = workspaceLayout("multi", [
      row("zlib", { rel_path: "z" }),
      row("app", { role: "primary" }),
      row("alib", { rel_path: "a" }),
    ]);
    expect(r.ok && r.value.primary.id).toBe("app");
    expect(r.ok && r.value.extras.map((e) => e.id)).toEqual(["alib", "zlib"]);
  });

  test("multi refuses no primary, two, no dep, an odd role, nesting, submodules (Q4)", () => {
    expect(message(workspaceLayout("multi", [row("a"), row("b")]))).toBe(
      "a multi workspace has exactly one primary repo, not 0",
    );
    expect(
      message(
        workspaceLayout("multi", [
          row("a", { role: "primary" }),
          row("b", { role: "primary" }),
        ]),
      ),
    ).toBe("a multi workspace has exactly one primary repo, not 2");
    expect(
      message(workspaceLayout("multi", [row("a", { role: "primary" })])),
    ).toBe("a multi workspace has at least one dep repo");
    expect(
      message(
        workspaceLayout("multi", [
          row("a", { role: "primary" }),
          row("b", { role: "lib" }),
        ]),
      ),
    ).toBe('repo b: role "lib" is neither primary nor dep');
    expect(
      message(
        workspaceLayout("multi", [
          row("a", { role: "primary", rel_path: "app" }),
          row("b", { rel_path: "app/lib" }),
        ]),
      ),
    ).toBe(
      'repos a and b nest (rel_path "app" and "app/lib"): sibling worktrees must not',
    );
    expect(
      message(
        workspaceLayout("multi", [
          row("a", { role: "primary" }),
          row("b", { has_submodules: 1 }),
        ]),
      ),
    ).toBe("repo b has submodules: a multi workspace takes none in M4");
    expect(
      message(
        workspaceLayout("multi", [
          row("a", { role: "primary" }),
          row("b", { submodule_path: "b" }),
        ]),
      ),
    ).toBe("repo b: a multi workspace has no submodule_path");
  });

  test("any kind refuses a reserved or unclean rel_path, and no rows", () => {
    expect(message(workspaceLayout("multi", []))).toBe(
      "the workspace has no repos",
    );
    expect(
      message(workspaceLayout("single", [row("a", { rel_path: ".frm/x" })])),
    ).toBe(
      'repo a: rel_path ".frm/x" starts with .frm, which the session keeps for itself',
    );
    expect(
      message(workspaceLayout("single", [row("a", { rel_path: "../a" })])),
    ).toBe(`repo a: rel_path "../a" has a '.' or '..' segment`);
    expect(message(workspaceLayout("odd", [row("a")]))).toBe(
      'unknown workspace kind "odd"',
    );
  });

  const sub = (id: string, path: string, over: Partial<LayoutRow> = {}) =>
    row(id, { submodule_path: path, rel_path: `super/${path}`, ...over });
  const superRow = row("super", { role: "primary", has_submodules: 1 });

  test("submodule: the superproject and its declared submodules, nested ones in full, exempt from nesting", () => {
    const r = workspaceLayout("submodule", [
      sub("leaf", "libs/mid/vendor/leaf", { has_submodules: 0 }),
      superRow,
      sub("mid", "libs/mid", { has_submodules: 1 }),
    ]);
    expect(r.ok && r.value.primary.id).toBe("super");
    expect(r.ok && r.value.submodules.map((s) => s.id)).toEqual([
      "mid",
      "leaf",
    ]);
  });

  test("submodule refuses a primary without submodules, a missing, bad, repeated or misplaced submodule_path", () => {
    expect(
      message(
        workspaceLayout("submodule", [
          row("super", { role: "primary" }),
          sub("mid", "libs/mid"),
        ]),
      ),
    ).toBe(
      "repo super: the primary of a submodule workspace has has_submodules=1",
    );
    expect(message(workspaceLayout("submodule", [superRow, row("mid")]))).toBe(
      "repo mid: every other repo of a submodule workspace has a submodule_path",
    );
    expect(
      message(
        workspaceLayout("submodule", [superRow, sub("mid", "libs/.git")]),
      ),
    ).toBe('repo mid: rel_path "super/libs/.git" has a .git segment');
    expect(
      message(
        workspaceLayout("submodule", [
          superRow,
          sub("a", "libs/mid"),
          sub("b", "libs/mid"),
        ]),
      ),
    ).toBe('submodule_path "libs/mid" is declared twice');
    expect(
      message(
        workspaceLayout("submodule", [
          superRow,
          row("mid", { submodule_path: "libs/mid", rel_path: "mid" }),
        ]),
      ),
    ).toBe(
      'repo mid: rel_path "mid" must be "super/libs/mid" (the primary\'s rel_path joined with its submodule_path)',
    );
    expect(
      message(
        workspaceLayout("submodule", [
          row("super", {
            role: "primary",
            has_submodules: 1,
            submodule_path: "x",
          }),
        ]),
      ),
    ).toBe("repo super: the primary has no submodule_path");
  });
});
