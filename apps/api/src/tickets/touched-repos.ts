import {
  locateWorktree,
  type GitRunner,
  type GitWorktree,
} from "./git-facts.js";

// Which repos a ticket touches (§3.1), gathered before the `code_review` transition's
// transaction exactly as the diff facts are: `git rev-list` on local worktrees only, argv and no
// shell, under a timeout.
//
// WHY THE API AND WHY HERE. `ticket_repos` is the API's table (Invariant 5), and the moment a
// ticket becomes multi-repo in any way the server can see is the moment a round of reviews opens on
// it. Until this landed nothing wrote the table at all, so H3 (`gates/subject.ts`) refused every
// repo-less diff gate whose worktrees spanned repos and a multi-repo ticket could never leave
// `code_review`.

/** A worktree as this scan reads it: the diff facts' shape, plus the repo the row names. */
export type RepoWorktree = GitWorktree & { readonly repo_id: string };

export interface TouchedReposInput {
  /** The ticket's worktrees, as `listTicketWorktrees` returns them. */
  readonly worktrees: readonly RepoWorktree[];
  readonly timeoutMs: number;
  /** `<FRM_HOME>/work`; null leaves every worktree unreadable, and so counted. */
  readonly workRoot: string | null;
}

const SHA = /^[0-9a-f]{7,64}$/;

/**
 * Whether `w` has commits of its own since its base. A worktree this host cannot read — a builder
 * on a container, a path outside the work root, a git that failed — counts as **touched**: §3.1
 * would rather open a gate on a repo that turns out untouched than let a touched one through
 * unreviewed, and the alternative is a silent hole exactly where the executor is not local.
 */
async function hasCommits(
  w: RepoWorktree,
  input: TouchedReposInput,
  run: GitRunner,
): Promise<boolean> {
  if (!SHA.test(w.base_sha)) return true;
  const where = await locateWorktree(w, input.workRoot);
  if (!where.ok) return true;
  const counted = await run(
    where.root,
    ["rev-list", "--count", `${w.base_sha}..HEAD`],
    input.timeoutMs,
  );
  if (!counted.ok) return true;
  const n = Number.parseInt(counted.stdout.trim(), 10);
  return Number.isNaN(n) ? true : n > 0;
}

/**
 * The repos of the ticket's active worktrees that have commits to review, sorted; `[]` when the
 * worktrees do not span more than one repo.
 *
 * The one-repo case writes nothing on purpose. An empty `ticket_repos` is what the laws document as
 * "one repo-less gate" (`core/laws/rounds.ts`), it is the shape every single-repo ticket in the
 * fleet already has, and H3 never fires for it — so recording a row there would re-shape every
 * gate in the fleet for no gain. Spanning repos is precisely H3's own trigger, which makes this
 * writer's scope and that refusal's the same condition.
 */
export async function touchedRepos(
  input: TouchedReposInput,
  run: GitRunner,
): Promise<readonly string[]> {
  const active = input.worktrees.filter((w) => w.state === "active");
  if (new Set(active.map((w) => w.repo_id)).size < 2) return [];
  let touched: readonly string[] = [];
  for (const w of active) {
    if (touched.includes(w.repo_id)) continue;
    if (await hasCommits(w, input, run)) touched = [...touched, w.repo_id];
  }
  return touched.toSorted();
}
