// Where a commit lives in a mirror: on the base ref, on another shared ref
// (refs/heads, refs/tags, refs/frm), or nowhere a removal leaves behind. No other refs/remotes/*
// counts (L2): a fetch force-moves them. `rev-list --not --all` is never used (g10).
import type { SweepDeps } from "./deps.js";
import { sweepGitRun } from "./git.js";
import { go, stop, type Step } from "./step.js";

export interface Reach {
  readonly onBase: boolean;
  readonly onShared: boolean;
}

export async function reach(
  deps: SweepDeps,
  repo: string,
  sha: string,
  baseRef: string,
  signal: AbortSignal,
): Promise<Step<Reach>> {
  const ancestor = await sweepGitRun(
    deps,
    ["-C", repo, "merge-base", "--is-ancestor", sha, baseRef],
    signal,
  );
  if (!ancestor.ok) return stop("unverifiable", ancestor.error.message);
  // 1: not an ancestor; any other exit (no such ref or object) proves nothing either.
  if (ancestor.value.code === 0) return go({ onBase: true, onShared: true });
  const refs = await sweepGitRun(
    deps,
    [
      "-C",
      repo,
      "for-each-ref",
      "--contains",
      sha,
      "--count=1",
      "--format=%(refname)",
      "refs/heads",
      "refs/tags",
      "refs/frm",
    ],
    signal,
  );
  if (!refs.ok) return stop("unverifiable", refs.error.message);
  // Exit 129 is a commit this mirror does not hold (g10): on no ref at all.
  const onShared = refs.value.code === 0 && refs.value.stdout.trim() !== "";
  return go({ onBase: false, onShared });
}

/** The SHA a ref names in `repo`, or null when it names nothing. */
export async function shaOf(
  deps: SweepDeps,
  repo: string,
  ref: string,
  signal: AbortSignal,
): Promise<Step<string | null>> {
  const ran = await sweepGitRun(
    deps,
    ["-C", repo, "rev-parse", "--verify", "-q", `${ref}^{commit}`],
    signal,
  );
  if (!ran.ok) return stop("unverifiable", ran.error.message);
  return go(ran.value.code === 0 ? ran.value.stdout.trim() : null);
}

/** Whether `repo` holds the commit `sha` (NEW-6's `cat-file -e`). */
export async function holds(
  deps: SweepDeps,
  repo: string,
  sha: string,
  signal: AbortSignal,
): Promise<Step<boolean>> {
  const ran = await sweepGitRun(
    deps,
    ["-C", repo, "cat-file", "-e", `${sha}^{commit}`],
    signal,
  );
  if (!ran.ok) return stop("unverifiable", ran.error.message);
  return go(ran.value.code === 0);
}
