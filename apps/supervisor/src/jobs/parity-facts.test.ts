// The parity job's gathering, against real git and a real database: the mirrors are
// bare clones of real source repos, so what a mirror holds is a fact of git, not of a stub. The
// rules themselves are core's (packages/core/src/gates/parity.test.ts); this file pins the walk and
// the row reads that feed them.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, parityFindings } from "@bayon/core";
import {
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
} from "@bayon/db/testing";
import type { Db } from "@bayon/db";
import { afterAll, beforeEach, expect, test } from "vitest";
import {
  git,
  mirrorOf,
  multiRows,
  submoduleRows,
} from "../lifecycle/testing/multi-world.js";
import { gatherParity, hostMirrorGit } from "./parity-facts.js";

const TICKET = "ticket-1";
const SESSION = "S-parity";
const homes: string[] = [];
const closers: (() => void)[] = [];
afterAll(() => {
  for (const c of closers) c();
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

let db: Db;
let home: string;
beforeEach(async () => {
  const t = unwrap(await tempDb(new FakeClock(1)));
  closers.push(t.cleanup);
  db = t.db;
  unwrap(await seedSpine(db, 1)); // the runner, executor, agent and run class a session needs
  home = join(
    tmpdir(),
    `frm-parity-${String(closers.length)}-${String(Date.now())}`,
  );
  mkdirSync(home, { recursive: true });
  homes.push(home);
});

/** A bare mirror of `src` at the path the repos rows name. */
function mirror(id: string, src: string): void {
  execFileSync("git", ["clone", "--mirror", "-q", src, mirrorOf(home, id)], {
    env: { ...process.env, GIT_ALLOW_PROTOCOL: "file" },
  });
}

/** An empty bare repository where a mirror should be: it holds nothing. */
function emptyMirror(id: string): void {
  const path = mirrorOf(home, id);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", path]);
}

const head = (src: string): string => git(src, "rev-parse", "HEAD");

interface Worktree {
  readonly repo: string;
  readonly base: string;
  readonly state?: "active" | "idle" | "removed" | "merged";
}

/**
 * The ticket's worktree rows, plus the job's own session. `head_sha` is **null**, which is the only
 * shape production ever has: the column has no writer anywhere in the repo (001_spine.sql declares
 * it nullable, schema-columns.ts types it for inserts, and every insertWorktree call site sets
 * base_sha alone). A test that seeded a head here would be checking a row shape that never occurs,
 * and would pass whether or not the job reads the gate's pin (H1).
 */
const sessionAndWorktrees = (worktrees: readonly Worktree[]) => ({
  sessions: [
    {
      ...newSessionInput(),
      id: SESSION,
      ticket_id: TICKET,
      workspace_id: "ws",
      state: "running" as const,
      created_at: 1,
    },
  ],
  worktrees: worktrees.map((w, n) => ({
    id: `wt-${String(n)}`,
    session_root: join(home, "work", SESSION),
    workspace_id: "ws",
    repo_id: w.repo,
    path: join(home, "work", SESSION, w.repo),
    branch: `frm/${SESSION}`,
    base_sha: w.base,
    head_sha: null,
    ticket_id: TICKET,
    session_id: null,
    state: w.state ?? "active",
    created_at: 1,
  })),
});

/** `pinned` is what the gate engine hands the job: the repo it pinned and that repo's head. */
const gather = (pinned: { readonly repoId: string; readonly sha: string }) =>
  gatherParity({
    db,
    git: hostMirrorGit(),
    sessionId: SESSION,
    pinned,
    signal: new AbortController().signal,
  });

/** One commit on `src`, so a mirror taken before it does not hold it. */
const commit = (src: string, message: string): string => {
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", message], {
    cwd: src,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  return head(src);
};

test("a clean multi workspace: every repo's worktree, and nothing to walk", async () => {
  const { sources, rows } = multiRows(home);
  mirror("app", sources.app);
  mirror("lib", sources.lib);
  unwrap(
    await seedRows(db, {
      ...rows,
      ...sessionAndWorktrees([
        { repo: "app", base: head(sources.app) },
        { repo: "lib", base: head(sources.lib) },
      ]),
    }),
  );
  const g = unwrap(await gather({ repoId: "app", sha: head(sources.app) }));
  expect(g.facts.kind).toBe("multi");
  expect(g.facts.worktrees).toEqual([
    { repoId: "app", sha: head(sources.app), which: "head", inMirror: true },
    // Not the pinned repo and no head_sha to read: its base is what is checked, and so it says.
    { repoId: "lib", sha: head(sources.lib), which: "base", inMirror: true },
  ]);
  // A multi workspace has no submodule tree: nothing walked, so rule 3 compares nothing.
  expect(g.facts.gitmodulePaths).toBeNull();
  expect(g.facts.gitlinks).toEqual([]);
  expect([...g.findings, ...parityFindings(g.facts)]).toEqual([]);
});

test("a dep repo with no worktree is reported, and the rest still read", async () => {
  const { sources, rows } = multiRows(home);
  mirror("app", sources.app);
  mirror("lib", sources.lib);
  unwrap(
    await seedRows(db, {
      ...rows,
      ...sessionAndWorktrees([{ repo: "app", base: head(sources.app) }]),
    }),
  );
  const g = unwrap(await gather({ repoId: "app", sha: head(sources.app) }));
  expect(g.facts.worktrees.map((w) => w.repoId)).toEqual(["app"]);
  expect(parityFindings(g.facts).map((f) => f.summary)).toEqual([
    "repo lib of this workspace has no active worktree on the ticket",
  ]);
});

test("a worktree that has been cleaned up is not a worktree (§9.2)", async () => {
  const { sources, rows } = multiRows(home);
  mirror("app", sources.app);
  mirror("lib", sources.lib);
  unwrap(
    await seedRows(db, {
      ...rows,
      ...sessionAndWorktrees([
        { repo: "app", base: head(sources.app) },
        { repo: "lib", base: head(sources.lib), state: "removed" },
      ]),
    }),
  );
  const g = unwrap(await gather({ repoId: "app", sha: head(sources.app) }));
  expect(g.facts.worktrees.map((w) => w.repoId)).toEqual(["app"]);
  expect(parityFindings(g.facts).map((f) => f.summary)).toEqual([
    "repo lib of this workspace has no active worktree on the ticket",
  ]);
});

test("rule 1 checks the pinned commit, not the row's base (H1)", async () => {
  const { sources, rows } = multiRows(home);
  mirror("app", sources.app);
  mirror("lib", sources.lib);
  // The ticket's work: a commit made after the mirror was taken, so the mirror has never seen it.
  // This is exactly what rule 1 exists to catch, and exactly what a walk from `base_sha` misses —
  // the base came out of the mirror, so it is always there and the rule is always vacuous.
  const base = head(sources.app);
  const worked = commit(sources.app, "the ticket's work");
  unwrap(
    await seedRows(db, {
      ...rows,
      ...sessionAndWorktrees([
        { repo: "app", base },
        { repo: "lib", base: head(sources.lib) },
      ]),
    }),
  );
  const g = unwrap(await gather({ repoId: "app", sha: worked }));
  expect(g.facts.worktrees).toEqual([
    { repoId: "app", sha: worked, which: "head", inMirror: false },
    { repoId: "lib", sha: head(sources.lib), which: "base", inMirror: true },
  ]);
  expect(parityFindings(g.facts).map((f) => f.summary)).toEqual([
    `repo app's worktree is at ${worked.slice(0, 12)}, which its mirror does not hold`,
  ]);
});

test("a clean submodule workspace: the whole tree walked from the mirrors", async () => {
  const { sources, rows } = submoduleRows(home);
  mirror("super", sources.sup);
  mirror("mid", sources.mid);
  mirror("leaf", sources.leaf);
  unwrap(
    await seedRows(db, {
      ...rows,
      ...sessionAndWorktrees([{ repo: "super", base: head(sources.sup) }]),
    }),
  );
  const g = unwrap(await gather({ repoId: "super", sha: head(sources.sup) }));
  expect(g.facts.kind).toBe("submodule");
  // Only the superproject takes a worktree row; its children live inside it.
  expect(g.facts.worktrees.map((w) => w.repoId)).toEqual(["super"]);
  expect(g.facts.gitmodulePaths).toEqual(["libs/mid", "libs/mid/vendor/leaf"]);
  expect(g.facts.gitlinks).toEqual([
    {
      path: "libs/mid",
      sha: head(sources.mid),
      repoId: "mid",
      inMirror: true,
    },
    {
      path: "libs/mid/vendor/leaf",
      sha: head(sources.leaf),
      repoId: "leaf",
      inMirror: true,
    },
  ]);
  expect([...g.findings, ...parityFindings(g.facts)]).toEqual([]);
});

test("rules 2 and 3 walk from the pinned commit, not from the base (H1)", async () => {
  const { sources, rows } = submoduleRows(home);
  // The base: the tree as the ticket found it, declarations and .gitmodules in agreement.
  const base = head(sources.sup);
  // The ticket's work: .gitmodules now names a path the workspace does not declare, and stops
  // naming one it does. A walk from `base` sees the old, agreeing tree and reports nothing at all.
  writeFileSync(
    join(sources.sup, ".gitmodules"),
    readFileSync(join(sources.sup, ".gitmodules"), "utf8").replace(
      /libs\/mid/g,
      "libs/moved",
    ),
  );
  git(sources.sup, "commit", "-q", "-am", "move the submodule declaration");
  const worked = head(sources.sup);
  mirror("super", sources.sup); // taken after the work: the mirror holds both commits
  mirror("mid", sources.mid);
  mirror("leaf", sources.leaf);
  unwrap(
    await seedRows(db, {
      ...rows,
      ...sessionAndWorktrees([{ repo: "super", base }]),
    }),
  );
  const g = unwrap(await gather({ repoId: "super", sha: worked }));
  // The gitlink is still at libs/mid (only the declaration moved), so the walk still descends.
  // From `base` this reads ["libs/mid", "libs/mid/vendor/leaf"] and every rule is silent.
  expect(g.facts.gitmodulePaths).toEqual([
    "libs/moved",
    "libs/mid/vendor/leaf",
  ]);
  expect(
    [...g.findings, ...parityFindings(g.facts)].map((f) => f.summary),
  ).toEqual([
    '.gitmodules names "libs/moved", which no repo of this workspace declares',
    'repo mid is declared as the submodule at "libs/mid", which .gitmodules does not name',
  ]);
  expect(g.facts.worktrees).toEqual([
    { repoId: "super", sha: worked, which: "head", inMirror: true },
  ]);
});

test("an undeclared nested submodule: the gitlink and the declaration both reported", async () => {
  const { sources, rows } = submoduleRows(home, { declareLeaf: false });
  mirror("super", sources.sup);
  mirror("mid", sources.mid);
  mirror("leaf", sources.leaf);
  unwrap(
    await seedRows(db, {
      ...rows,
      ...sessionAndWorktrees([{ repo: "super", base: head(sources.sup) }]),
    }),
  );
  const g = unwrap(await gather({ repoId: "super", sha: head(sources.sup) }));
  // The tree was read whole (leaf simply has no repo row), so rule 3 still compares.
  expect(g.facts.gitmodulePaths).toEqual(["libs/mid", "libs/mid/vendor/leaf"]);
  expect(
    [...g.findings, ...parityFindings(g.facts)].map((f) => f.summary),
  ).toEqual([
    'the gitlink at "libs/mid/vendor/leaf" is not a repo of this workspace',
    '.gitmodules names "libs/mid/vendor/leaf", which no repo of this workspace declares',
  ]);
});

test("a child mirror that never got the gitlink: reported, and the declarations not compared", async () => {
  const { sources, rows } = submoduleRows(home);
  mirror("super", sources.sup);
  mirror("mid", sources.mid);
  mirror("leaf", sources.leaf);
  emptyMirror("mid"); // the commit the superproject points at was never published
  unwrap(
    await seedRows(db, {
      ...rows,
      ...sessionAndWorktrees([{ repo: "super", base: head(sources.sup) }]),
    }),
  );
  const g = unwrap(await gather({ repoId: "super", sha: head(sources.sup) }));
  expect(g.facts.gitlinks).toEqual([
    {
      path: "libs/mid",
      sha: head(sources.mid),
      repoId: "mid",
      inMirror: false,
    },
  ]);
  // Half a tree's .gitmodules against the whole declaration would report leaf as drifted; it is not.
  expect(g.facts.gitmodulePaths).toBeNull();
  expect(
    [...g.findings, ...parityFindings(g.facts)].map((f) => f.summary),
  ).toEqual([
    `submodule commit ${head(sources.mid).slice(0, 12)} at "libs/mid" is not in repo mid's mirror`,
  ]);
});

test("the superproject's own commit missing from its mirror: no walk at all", async () => {
  const { sources, rows } = submoduleRows(home);
  mirror("super", sources.sup);
  mirror("mid", sources.mid);
  mirror("leaf", sources.leaf);
  emptyMirror("super");
  unwrap(
    await seedRows(db, {
      ...rows,
      ...sessionAndWorktrees([{ repo: "super", base: head(sources.sup) }]),
    }),
  );
  const g = unwrap(await gather({ repoId: "super", sha: head(sources.sup) }));
  expect(g.facts.gitlinks).toEqual([]);
  expect(g.facts.gitmodulePaths).toBeNull();
  expect(parityFindings(g.facts).map((f) => f.summary)).toEqual([
    `repo super's worktree is at ${head(sources.sup).slice(0, 12)}, which its mirror does not hold`,
  ]);
});

test("a session with no ticket is an error, not a finding", async () => {
  const { sources, rows } = multiRows(home);
  mirror("app", sources.app);
  mirror("lib", sources.lib);
  unwrap(
    await seedRows(db, {
      ...rows,
      sessions: [
        {
          ...newSessionInput(),
          id: SESSION,
          ticket_id: null,
          state: "running" as const,
          created_at: 1,
        },
      ],
    }),
  );
  const g = await gather({ repoId: "app", sha: head(sources.app) });
  expect(g.ok).toBe(false);
  if (!g.ok) expect(g.error.message).toContain("works no ticket");
});
