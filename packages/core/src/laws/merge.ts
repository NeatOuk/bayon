import type { DeliveryFact, MergeFacts } from "./types.js";

// What a merged pull request settles, pure over the ticket's `deliveries` rows and its
// project's `close_on_merge`. `prs_merged` (the law), `machineStep` (which names `merge_close`) and
// `nextStep` (which says the ticket waits for a merge) all read these, so none can disagree.

/** The delivery states that still owe something: a request under review, or a delivery that broke. */
const OUTSTANDING: ReadonlySet<string> = new Set(["pr_open", "failed"]);

/** A delivery row that carries a pull request. */
export type PullRequestRow = DeliveryFact & { readonly prUrl: string };

const hasPr = (d: DeliveryFact): d is PullRequestRow => d.prUrl !== null;

/** The rows that carry a pull request. */
export const pullRequestsOf = (facts: MergeFacts): readonly PullRequestRow[] =>
  facts.deliveries.filter(hasPr);

/**
 * Null when the merge closes the ticket, else why not. It holds when the project closes on merge,
 * the ticket has at least one pull request, every one of them merged, and no row is still open or
 * failed. A row pushed with no request (a host with no forge) does not hold it back; a request
 * closed without merging does — it is a pull request that did not merge.
 */
export function unmergedReason(facts: MergeFacts): string | null {
  if (!facts.closeOnMerge) {
    return "this project does not close a ticket when its pull requests merge";
  }
  const prs = pullRequestsOf(facts);
  if (prs.length === 0) return "the ticket has no pull request";
  const outstanding = facts.deliveries.filter((d) => OUTSTANDING.has(d.state));
  if (outstanding.length > 0) {
    return `${outstanding.length} delivery row(s) still ${[...new Set(outstanding.map((d) => d.state))].join(", ")}: ${outstanding.map((d) => d.repoId).join(", ")}`;
  }
  const unmerged = prs.filter((d) => d.state !== "merged");
  return unmerged.length === 0
    ? null
    : `${unmerged.length} pull request(s) not merged: ${unmerged.map((d) => `${d.repoId} (${d.state})`).join(", ")}`;
}

/**
 * The ticket waits on its pull requests alone: the project closes on merge, it has at least one,
 * and every one is still open. What nextStep says "Waiting for the PR to be merged" on.
 */
export function awaitingMerge(facts: MergeFacts): readonly string[] {
  if (!facts.closeOnMerge) return [];
  const prs = pullRequestsOf(facts);
  return prs.length > 0 && prs.every((d) => d.state === "pr_open")
    ? prs.map((d) => d.prUrl)
    : [];
}
