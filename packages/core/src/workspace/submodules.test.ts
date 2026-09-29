import { describe, expect, test } from "vitest";
import {
  SubmoduleShas,
  childrenOf,
  parseGitlinks,
  parseGitmodules,
  submoduleNameProblem,
  type SubmoduleNode,
} from "./submodules.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SUPER = "c".repeat(40);

/** `git config --null --get-regexp` output for these key/value pairs. */
const config = (...pairs: [string, string][]): string =>
  pairs.map(([k, v]) => `${k}\n${v}\0`).join("");

describe("parseGitmodules", () => {
  test("entries with a path, by path; the name may hold dots; url optional", () => {
    const r = parseGitmodules(
      config(
        ["submodule.libs/mid.path", "libs/mid"],
        ["submodule.libs/mid.url", "../mid"],
        ["submodule.v1.2.path", "vendor/v1.2"],
        ["submodule.nopath.url", "../x"],
      ),
    );
    expect(r).toEqual({
      ok: true,
      value: [
        { name: "libs/mid", path: "libs/mid", url: "../mid" },
        { name: "v1.2", path: "vendor/v1.2", url: null },
      ],
    });
  });

  test("an empty output is no submodules", () => {
    expect(parseGitmodules("")).toEqual({ ok: true, value: [] });
  });

  test.each([
    ["-evil", "starts with '-'"],
    ["a=b", "contains '='"],
    ["a\\b", "contains a backslash"],
    ["a/../b", "has a '..' segment"],
    ["a\rb", "contains a control character"],
  ])("name %j is refused: %s", (name, why) => {
    expect(submoduleNameProblem(name)).toBe(why);
    const r = parseGitmodules(config([`submodule.${name}.path`, "x"]));
    expect(r.ok).toBe(false);
  });

  test("a bad path and a path named twice are refused (L1)", () => {
    const bad = parseGitmodules(config(["submodule.x.path", "../up"]));
    expect(!bad.ok && bad.error.message).toBe(
      `.gitmodules: submodule "x": path "../up" has a '.' or '..' segment`,
    );
    const twice = parseGitmodules(
      config(["submodule.a.path", "p"], ["submodule.b.path", "p"]),
    );
    expect(!twice.ok && twice.error.message).toBe(
      '.gitmodules: path "p" is named by two submodules',
    );
  });

  test("an update=!command is refused (a program to run); a strategy like rebase is not", () => {
    const command = parseGitmodules(
      config(
        ["submodule.libs/mid.path", "libs/mid"],
        ["submodule.libs/mid.update", " !touch /tmp/pwned"],
      ),
    );
    expect(!command.ok && command.error.message).toBe(
      '.gitmodules: submodule "libs/mid" has update=!command, a program to run: refused',
    );
    const rebase = parseGitmodules(
      config(
        ["submodule.libs/mid.path", "libs/mid"],
        ["submodule.libs/mid.update", "rebase"],
      ),
    );
    expect(rebase.ok).toBe(true);
  });
});

test("parseGitlinks keeps mode 160000 records only", () => {
  const out = [
    `100644 blob ${SHA_B}\tREADME.md`,
    `160000 commit ${SHA_A}\tlibs/mid`,
    `040000 tree ${SHA_B}\tlibs`,
    "",
  ].join("\0");
  expect([...parseGitlinks(out)]).toEqual([["libs/mid", SHA_A]]);
});

describe("childrenOf", () => {
  const node = (over: Partial<SubmoduleNode> = {}): SubmoduleNode => ({
    prefix: "",
    repoId: "super",
    sha: SUPER,
    entries: [{ name: "mid", path: "libs/mid", url: "../mid" }],
    gitlinks: new Map([["libs/mid", SHA_A]]),
    ...over,
  });

  test("each entry matched to its declared repo by path, nested paths from the superproject root", () => {
    expect(childrenOf(node(), [{ repoId: "mid", path: "libs/mid" }])).toEqual({
      ok: true,
      value: [
        {
          path: "libs/mid",
          parent: "",
          rel: "libs/mid",
          name: "mid",
          repoId: "mid",
          sha: SHA_A,
          url: "../mid",
        },
      ],
    });
    const nested = childrenOf(
      node({
        prefix: "libs/mid",
        repoId: "mid",
        entries: [{ name: "leaf", path: "vendor/leaf", url: null }],
        gitlinks: new Map([["vendor/leaf", SHA_B]]),
      }),
      [{ repoId: "leaf", path: "libs/mid/vendor/leaf" }],
    );
    expect(nested.ok && nested.value[0]).toMatchObject({
      path: "libs/mid/vendor/leaf",
      parent: "libs/mid",
      rel: "vendor/leaf",
    });
  });

  test("an unknown submodule is refused, never mirrored (§3.2)", () => {
    const r = childrenOf(node(), []);
    expect(!r.ok && r.error.message).toBe(
      `submodule "libs/mid" (url "../mid") of repo super at ${SUPER.slice(0, 12)} is not a repo of this workspace: add a repos row and a workspace_repos row with submodule_path "libs/mid"`,
    );
    expect(!r.ok && r.error.class).toBe("validation");
  });

  test("an entry without a gitlink, and a gitlink without an entry, are refused", () => {
    const noLink = childrenOf(node({ gitlinks: new Map() }), [
      { repoId: "mid", path: "libs/mid" },
    ]);
    expect(!noLink.ok && noLink.error.message).toContain(
      'names "libs/mid", but the tree has no gitlink there',
    );
    const noEntry = childrenOf(node({ entries: [] }), []);
    expect(!noEntry.ok && noEntry.error.message).toContain(
      'the gitlink at "libs/mid" has no .gitmodules entry',
    );
  });
});

test("SubmoduleShas holds the start SHAs and the git that made them", () => {
  const value = {
    v: 1,
    git: "2.50.1",
    shas: [{ path: "libs/mid", repo_id: "mid", sha: SHA_A }],
  };
  expect(SubmoduleShas.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
  expect(
    SubmoduleShas.safeParse({
      ...value,
      shas: [{ ...value.shas[0], sha: "x" }],
    }).success,
  ).toBe(false);
});
