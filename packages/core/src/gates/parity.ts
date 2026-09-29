import type { WorkspaceKind } from "../workspace/layout.js";
import type { ReviewFinding } from "./findings.js";

// The `parity_check` gate's rules (§10.3, §3.1), pure: facts in, findings out. The supervisor's
// job (apps/supervisor/src/jobs/parity-check.ts) gathers the facts from the database and the
// supervisor's own mirrors; every judgement is here, where it is table-testable.
//
// SCOPE (and the one thing to read before extending this file). §10.3 names the gate's
// subject "multi-repo/submodule consistency, dual-remote parity". **Only the first half is checked
// here.** `repos` carries exactly one `origin_url`: there is no second remote in the schema, in
// `frm config apply`, or in the deploy files, so there is nothing to compare a remote against.
// Adding one is a migration and an operator flow — a later ticket, not this one. Until it lands,
// "dual-remote parity" is an aspiration in the spec's prose, not a rule this gate enforces, and a
// passing `parity_check` says nothing about a second remote.
//
// Three rules, all deterministic and all computable from the database and the mirrors alone:
//
//   1. every repo of the workspace that takes a worktree of its own has an active one, at a commit
//      its mirror holds;
//   2. every gitlink in the superproject's tree names a repo the workspace declares, at a commit
//      that repo's mirror holds;
//   3. `.gitmodules` and `workspace_repos.submodule_path` name the same set of paths.
//
// §3.1's fourth candidate — "every repo in `ticket_repos` has passing `code_review` evidence this
// round" — stays **out of scope**. It was vacuous while nothing wrote `ticket_repos`; an earlier change gave
// that table a writer, and with it `pass_review` now asks `gatePassed` for a passing `code_review`
// per `ticket_repos` entry directly (requirements.ts), which is §3.1's sentence enforced on the edge
// that needs it. Restating it as a parity rule would decide the same question twice, in a gate whose
// subject is the workspace rather than any repo's diff — so it stays where it is unless a later
// ticket finds a case the edge cannot see.

/** A `workspace_repos` row joined with its repo, as the rules read it. */
export interface ParityRepo {
  readonly repoId: string;
  /** `workspace_repos.submodule_path`: null for the primary and for a sibling worktree. */
  readonly submodulePath: string | null;
}

/** What the ticket's worktree of one repo looks like, or that there is none. */
export interface ParityWorktree {
  readonly repoId: string;
  /**
   * The commit the rule checks: `worktrees.head_sha`, or `base_sha` when the head has not been
   * recorded yet. `which` says which, so a finding names the sha it actually looked for.
   */
  readonly sha: string;
  readonly which: "head" | "base";
  /** Whether the repo's mirror holds `sha`. */
  readonly inMirror: boolean;
}

/** One gitlink of the superproject's tree at the pinned commit, resolved against the declaration. */
export interface ParityGitlink {
  /** From the superproject's root. */
  readonly path: string;
  readonly sha: string;
  /** The repo whose `submodule_path` is `path`, or null when the workspace declares none. */
  readonly repoId: string | null;
  /** Whether that repo's mirror holds `sha`; false when `repoId` is null. */
  readonly inMirror: boolean;
}

export interface ParityFacts {
  readonly kind: WorkspaceKind;
  readonly repos: readonly ParityRepo[];
  /** One entry per repo that has an active or idle worktree of this ticket. */
  readonly worktrees: readonly ParityWorktree[];
  /**
   * Every `.gitmodules` path in the submodule tree, from the superproject's root, parents and
   * children alike. Null for a workspace with no submodules: rule 3 then has nothing to compare.
   */
  readonly gitmodulePaths: readonly string[] | null;
  /** Every gitlink of the tree, from the superproject's root. */
  readonly gitlinks: readonly ParityGitlink[];
}

const CATEGORY = "parity";

const blocker = (
  summary: string,
  detail: string | null = null,
): ReviewFinding =>
  ({
    severity: "blocker",
    summary,
    file: null,
    line: null,
    category: CATEGORY,
    detail_md: detail,
  }) satisfies ReviewFinding;

const short = (sha: string): string => sha.slice(0, 12);

/**
 * The repos that take a worktree of their own: every repo of a `single` or `multi` workspace, and a
 * `submodule` workspace's superproject alone — its submodules are checked out inside the
 * superproject's worktree, so they never get a `worktrees` row.
 */
export const worktreeRepos = (f: ParityFacts): readonly ParityRepo[] =>
  f.kind === "submodule"
    ? f.repos.filter((r) => r.submodulePath === null)
    : f.repos;

/** Rule 1: every such repo has a worktree, at a commit its mirror holds. */
function worktreeFindings(f: ParityFacts): ReviewFinding[] {
  return worktreeRepos(f).flatMap((repo) => {
    const wt = f.worktrees.find((w) => w.repoId === repo.repoId);
    if (wt === undefined) {
      return [
        blocker(
          `repo ${repo.repoId} of this workspace has no active worktree on the ticket`,
          "Every repo of a multi-repo workspace is worked and reviewed in its own worktree; one with none was never touched, so nothing of it can have been reviewed (§3.1).",
        ),
      ];
    }
    return wt.inMirror
      ? []
      : [
          blocker(
            `repo ${repo.repoId}'s worktree is at ${short(wt.sha)}, which its mirror does not hold`,
            `The worktree's ${wt.which} commit is ${wt.sha}. A commit no mirror holds cannot be fetched, diffed or reviewed here; publish it to the repo's mirror before asking for review.`,
          ),
        ];
  });
}

/** Rule 2: every gitlink names a declared repo, at a commit that repo's mirror holds. */
function gitlinkFindings(f: ParityFacts): ReviewFinding[] {
  return f.gitlinks.flatMap((link) => {
    if (link.repoId === null) {
      return [
        blocker(
          `the gitlink at ${JSON.stringify(link.path)} is not a repo of this workspace`,
          `The superproject's tree records a submodule commit at ${JSON.stringify(link.path)}, but no workspace_repos row declares submodule_path ${JSON.stringify(link.path)}. Add the repos row and the workspace_repos row, or drop the submodule (§3.1).`,
        ),
      ];
    }
    return link.inMirror
      ? []
      : [
          blocker(
            `submodule commit ${short(link.sha)} at ${JSON.stringify(link.path)} is not in repo ${link.repoId}'s mirror`,
            `The gitlink is ${link.sha}. A gitlink the child's mirror does not hold leaves the superproject pointing at a commit nobody else can read (§3.3).`,
          ),
        ];
  });
}

/** Rule 3: `.gitmodules` and `workspace_repos.submodule_path` agree, both ways. */
function declarationFindings(f: ParityFacts): ReviewFinding[] {
  if (f.gitmodulePaths === null) return [];
  // Each declared path with the repo that declares it, so the second rule names that repo without
  // a lookup back into `repos` that could not fail.
  const declared = f.repos.flatMap((r) =>
    r.submodulePath === null
      ? []
      : [{ repoId: r.repoId, path: r.submodulePath }],
  );
  const inGit = new Set(f.gitmodulePaths);
  const inDb = new Set(declared.map((d) => d.path));
  return [
    ...f.gitmodulePaths
      .filter((path) => !inDb.has(path))
      .map((path) =>
        blocker(
          `.gitmodules names ${JSON.stringify(path)}, which no repo of this workspace declares`,
          "workspace_repos.submodule_path is the workspace's declaration of its submodules; a path only .gitmodules knows is materialized by nobody (§3.1).",
        ),
      ),
    ...declared
      .filter((d) => !inGit.has(d.path))
      .map((d) =>
        blocker(
          `repo ${d.repoId} declares submodule_path ${JSON.stringify(d.path)}, which .gitmodules does not name`,
          "The workspace declares a submodule the superproject's commit has no .gitmodules entry for: the declaration and the tree have drifted apart (§3.1).",
        ),
      ),
  ];
}

/**
 * Every parity finding, rule by rule, in a fixed order; `[]` is a clean workspace. Never throws and
 * never partially answers: the caller turns the whole list into the script's output.
 */
export function parityFindings(f: ParityFacts): ReviewFinding[] {
  return [
    ...worktreeFindings(f),
    ...gitlinkFindings(f),
    ...declarationFindings(f),
  ];
}

/** The sentinel a heuristic review's output ends in (C2), for the script job's last line. */
export const findingsSentinel = (count: number): string =>
  `FINDINGS: ${String(count)}`;

/**
 * The script job's whole answer, as one `assistant_text` record.
 *
 * `SCRIPT_CAPS.outputSchema` is false, so a script gate takes the heuristic path ():
 * `parseHeuristicFindings` reads an embedded `ReviewOutput` JSON when one validates, and
 * `collect()` then refuses the review unless the trailing `FINDINGS: <n>` line declares exactly as
 * many. Emitting the JSON rather than one tagged line per finding is what carries `category` and
 * `detail_md` through to the `findings` rows; the two halves agree by construction because both
 * come from the same list. The JSON is the only `{…}` in the text, so `jsonCandidates`' span from
 * the first `{` to the last `}` is exactly it.
 */
export function parityReport(findings: readonly ReviewFinding[]): string {
  const output = {
    summary:
      findings.length === 0
        ? "parity_check: the workspace's repos, worktrees and submodule declarations agree."
        : `parity_check: ${String(findings.length)} parity problem(s) in this workspace.`,
    findings: [...findings],
  };
  return [
    JSON.stringify(output, null, 2),
    "",
    findingsSentinel(findings.length),
  ].join("\n");
}
