import { err, ok, type Result } from "@bayon/core";
import { all, execute, qb, type Internals } from "../connection.js";
import { failure } from "../errors.js";

// The API's `ticket_repos` writer (§3.1, per design note). Which repos a
// ticket touches is decided by the caller — the API, outside the transaction, from the worktrees'
// git — and recorded here inside the `code_review` transition's own transaction, before the round
// it opens reads the table.
//
// The table is the **union across rounds**: rows are inserted, never removed. A repo reviewed in
// round 1 keeps its gate in round 2 even when that round's fix touched only one of them (§3.1: the
// ticket cannot pass code_review until every touched repo has gate evidence), and a worktree
// created between the scan and this write is picked up by the next round rather than lost.

/**
 * Records `repoIds` as the ticket's repos, ignoring the ones already there. Returns the ids
 * actually inserted, newest first in the order given.
 *
 * A repo id that names no `repos` row is refused rather than inserted: the FK would fail the whole
 * transition anyway, and `internal` says whose bug it is.
 */
export function recordTicketReposIn(
  ix: Internals,
  ticketId: string,
  repoIds: readonly string[],
): Result<string[]> {
  if (repoIds.length === 0) return ok([]);
  const known = new Set(
    all(
      ix,
      qb
        .selectFrom("repos")
        .select("id")
        .where("id", "in", [...repoIds]),
    ).map((r) => r.id),
  );
  const unknown = repoIds.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    return err(
      failure(
        "internal",
        `ticket ${ticketId}: unknown repo(s) ${unknown.join(", ")}`,
      ),
    );
  }
  const already = new Set(
    all(
      ix,
      qb
        .selectFrom("ticket_repos")
        .select("repo_id")
        .where("ticket_id", "=", ticketId),
    ).map((r) => r.repo_id),
  );
  const fresh = repoIds.filter((id) => !already.has(id));
  for (const repo_id of fresh) {
    execute(
      ix,
      qb
        .insertInto("ticket_repos")
        .values({ ticket_id: ticketId, repo_id })
        .onConflict((oc) => oc.columns(["ticket_id", "repo_id"]).doNothing()),
    );
  }
  return ok(fresh);
}
