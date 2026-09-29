import { describe, expect, test } from "vitest";
import { countSentinel, parseHeuristicFindings } from "./findings.js";
import {
  findingsSentinel,
  parityFindings,
  parityReport,
  worktreeRepos,
  type ParityFacts,
} from "./parity.js";

// The parity_check rules, table-driven: every finding and the clean case, for each workspace kind.

const facts = (o: Partial<ParityFacts> = {}): ParityFacts => ({
  kind: "multi",
  repos: [],
  worktrees: [],
  gitmodulePaths: null,
  gitlinks: [],
  ...o,
});

const summaries = (f: ParityFacts): string[] =>
  parityFindings(f).map((x) => x.summary);

/** A `multi` workspace: app (primary) and lib, each with its own worktree. */
const MULTI = facts({
  kind: "multi",
  repos: [
    { repoId: "app", submodulePath: null },
    { repoId: "lib", submodulePath: null },
  ],
  worktrees: [
    { repoId: "app", sha: "a".repeat(40), which: "head", inMirror: true },
    { repoId: "lib", sha: "b".repeat(40), which: "head", inMirror: true },
  ],
});

/** A `submodule` workspace: super → libs/mid → libs/mid/vendor/leaf. */
const SUBMODULE = facts({
  kind: "submodule",
  repos: [
    { repoId: "super", submodulePath: null },
    { repoId: "mid", submodulePath: "libs/mid" },
    { repoId: "leaf", submodulePath: "libs/mid/vendor/leaf" },
  ],
  worktrees: [
    { repoId: "super", sha: "c".repeat(40), which: "head", inMirror: true },
  ],
  gitmodulePaths: ["libs/mid", "libs/mid/vendor/leaf"],
  gitlinks: [
    {
      path: "libs/mid",
      sha: "d".repeat(40),
      repoId: "mid",
      inMirror: true,
    },
    {
      path: "libs/mid/vendor/leaf",
      sha: "e".repeat(40),
      repoId: "leaf",
      inMirror: true,
    },
  ],
});

test("a clean multi workspace and a clean submodule workspace have no findings", () => {
  expect(parityFindings(MULTI)).toEqual([]);
  expect(parityFindings(SUBMODULE)).toEqual([]);
});

test("a single workspace's one repo is the only one that needs a worktree", () => {
  const single = facts({
    kind: "single",
    repos: [{ repoId: "app", submodulePath: null }],
    worktrees: [
      { repoId: "app", sha: "a".repeat(40), which: "base", inMirror: true },
    ],
  });
  expect(worktreeRepos(single).map((r) => r.repoId)).toEqual(["app"]);
  expect(parityFindings(single)).toEqual([]);
});

test("a submodule workspace's children take no worktree of their own", () => {
  expect(worktreeRepos(SUBMODULE).map((r) => r.repoId)).toEqual(["super"]);
  // Every repo of a multi workspace does.
  expect(worktreeRepos(MULTI).map((r) => r.repoId)).toEqual(["app", "lib"]);
});

describe("rule 1: a worktree per repo, at a commit its mirror holds", () => {
  test("a repo with no worktree is a blocker naming the repo", () => {
    const f = facts({ ...MULTI, worktrees: MULTI.worktrees.slice(0, 1) });
    expect(summaries(f)).toEqual([
      "repo lib of this workspace has no active worktree on the ticket",
    ]);
    expect(parityFindings(f)[0]?.severity).toBe("blocker");
  });

  test("a worktree at a commit the mirror lacks is a blocker naming head or base", () => {
    const f = facts({
      ...MULTI,
      worktrees: [
        MULTI.worktrees[0] as (typeof MULTI.worktrees)[number],
        { repoId: "lib", sha: "b".repeat(40), which: "base", inMirror: false },
      ],
    });
    const [found] = parityFindings(f);
    expect(found?.summary).toBe(
      `repo lib's worktree is at ${"b".repeat(12)}, which its mirror does not hold`,
    );
    expect(found?.detail_md).toContain("base commit");
    expect(found?.category).toBe("parity");
  });

  test("a superproject with no worktree is a blocker, its submodules are not", () => {
    expect(summaries(facts({ ...SUBMODULE, worktrees: [] }))).toEqual([
      "repo super of this workspace has no active worktree on the ticket",
    ]);
  });
});

describe("rule 2: every gitlink is a declared repo's commit, in its mirror", () => {
  test("a gitlink no repo declares is a blocker", () => {
    const f = facts({
      ...SUBMODULE,
      gitlinks: [
        ...SUBMODULE.gitlinks,
        {
          path: "vendor/stray",
          sha: "f".repeat(40),
          repoId: null,
          inMirror: false,
        },
      ],
      gitmodulePaths: [...(SUBMODULE.gitmodulePaths ?? []), "vendor/stray"],
    });
    expect(summaries(f)).toEqual([
      'the gitlink at "vendor/stray" is not a repo of this workspace',
      '.gitmodules names "vendor/stray", which no repo of this workspace declares',
    ]);
  });

  test("a gitlink the child's mirror does not hold is a blocker", () => {
    const f = facts({
      ...SUBMODULE,
      gitlinks: [
        {
          path: "libs/mid",
          sha: "d".repeat(40),
          repoId: "mid",
          inMirror: false,
        },
        SUBMODULE.gitlinks[1] as (typeof SUBMODULE.gitlinks)[number],
      ],
    });
    expect(summaries(f)).toEqual([
      `submodule commit ${"d".repeat(12)} at "libs/mid" is not in repo mid's mirror`,
    ]);
  });
});

describe("rule 3: .gitmodules and workspace_repos.submodule_path agree", () => {
  test("a path only .gitmodules names is a blocker", () => {
    const f = facts({
      ...SUBMODULE,
      gitmodulePaths: [...(SUBMODULE.gitmodulePaths ?? []), "libs/extra"],
    });
    expect(summaries(f)).toEqual([
      '.gitmodules names "libs/extra", which no repo of this workspace declares',
    ]);
  });

  test("a path only workspace_repos declares is a blocker naming the repo", () => {
    const f = facts({ ...SUBMODULE, gitmodulePaths: ["libs/mid"] });
    expect(summaries(f)).toEqual([
      'repo leaf declares submodule_path "libs/mid/vendor/leaf", which .gitmodules does not name',
    ]);
  });

  test("a workspace whose .gitmodules was never read compares nothing", () => {
    const f = facts({
      ...SUBMODULE,
      gitmodulePaths: null,
      gitlinks: [],
    });
    expect(parityFindings(f)).toEqual([]);
  });
});

describe("the report the script emits", () => {
  test("a clean run: an empty findings list and FINDINGS: 0, read back as none", () => {
    const text = parityReport([]);
    expect(countSentinel(text)).toBe(0);
    expect(parseHeuristicFindings(text).findings).toEqual([]);
    expect(text.trimEnd().endsWith(findingsSentinel(0))).toBe(true);
  });

  test("findings survive the round trip whole: severity, category and detail", () => {
    const found = parityFindings(facts({ ...SUBMODULE, worktrees: [] }));
    const text = parityReport(found);
    expect(countSentinel(text)).toBe(found.length);
    // The count the sentinel declares is exactly what the parser reads back: what collect() checks.
    expect(parseHeuristicFindings(text).findings).toEqual(found);
  });

  test("every rule's findings round trip together", () => {
    const found = parityFindings(
      facts({
        ...SUBMODULE,
        worktrees: [],
        gitmodulePaths: ["libs/mid", "libs/extra"],
        gitlinks: [
          {
            path: "libs/mid",
            sha: "d".repeat(40),
            repoId: "mid",
            inMirror: false,
          },
          {
            path: "vendor/stray",
            sha: "f".repeat(40),
            repoId: null,
            inMirror: false,
          },
        ],
      }),
    );
    expect(found).toHaveLength(5);
    expect(found.every((f) => f.severity === "blocker")).toBe(true);
    const text = parityReport(found);
    expect(countSentinel(text)).toBe(5);
    expect(parseHeuristicFindings(text).findings).toEqual(found);
  });
});
