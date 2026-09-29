// A project's push targets (migration 039): `repos.push_url` for each of its repos, read and — as
// one part of `PATCH /projects/:id` (project-settings.ts) — written. Where a repo's delivered work
// goes is `push_url ?? origin_url`; this module only holds the column, never decides a push.
//
// The shape rule is core's `checkPushUrl`, run here, in the writer, so every door gets the same
// one-sentence refusal and no URL carrying a credential ever reaches the table (§14).
import { checkPushUrl, err, ok, type Result } from "@bayon/core";
import { all, execute, qb, type Internals } from "../connection.js";
import { failure } from "../errors.js";

/** One repo's push target, as a patch asks for it: null clears it (back to its origin_url). */
export interface PushTargetPatch {
  readonly repo_id: string;
  readonly push_url: string | null;
}

/** One repo of a project and its push target, as the settings answer carries it. */
export interface PushTarget {
  readonly repo_id: string;
  /** Its path in the superproject; null for the primary or a lone repo. */
  readonly submodule_path: string | null;
  readonly push_url: string | null;
}

/** The changes a patch makes, checked: what to write, and what the audit row says. */
export interface PushTargetPlan {
  readonly changes: readonly PushTargetPatch[];
  /** Every repo's target once the changes are written, primary first, then by submodule path. */
  readonly after: readonly PushTarget[];
}

/** `workspaceId`'s repos and their push targets, primary first, then by submodule path. */
export function pushTargetsIn(
  ix: Internals,
  workspaceId: string,
): PushTarget[] {
  return all(
    ix,
    qb
      .selectFrom("workspace_repos as wr")
      .innerJoin("repos as r", "r.id", "wr.repo_id")
      .select([
        "r.id as repo_id",
        "wr.submodule_path as submodule_path",
        "r.push_url as push_url",
      ])
      .where("wr.workspace_id", "=", workspaceId),
  ).toSorted(
    (a, b) =>
      (a.submodule_path === null ? 0 : 1) -
        (b.submodule_path === null ? 0 : 1) ||
      (a.submodule_path ?? "").localeCompare(b.submodule_path ?? "") ||
      a.repo_id.localeCompare(b.repo_id),
  );
}

/** A blank target is a cleared one; anything else must pass core's shape rule. */
function normalised(entry: PushTargetPatch): Result<PushTargetPatch> {
  if (entry.push_url === null || entry.push_url.trim() === "") {
    return ok({ repo_id: entry.repo_id, push_url: null });
  }
  const checked = checkPushUrl(entry.push_url);
  if (!checked.ok) {
    return err(
      failure("validation", `repo ${entry.repo_id}: ${checked.error.message}`),
    );
  }
  return ok({ repo_id: entry.repo_id, push_url: checked.value });
}

/**
 * What `patch` would change in `workspaceId`'s push targets, checked and written nowhere. Refused
 * (`validation`), for the whole patch: a repo that is not one of this project's, a repo named twice,
 * and a target core's shape rule refuses. A target equal to the one stored is not a change.
 */
export function planPushTargets(
  ix: Internals,
  workspaceId: string,
  patch: readonly PushTargetPatch[],
): Result<PushTargetPlan> {
  const current = pushTargetsIn(ix, workspaceId);
  const byId = new Map(current.map((t) => [t.repo_id, t]));
  const seen = new Set<string>();
  const changes: PushTargetPatch[] = [];
  for (const entry of patch) {
    const known = byId.get(entry.repo_id);
    if (known === undefined) {
      return err(
        failure(
          "validation",
          `repo ${entry.repo_id} is not one of project ${workspaceId}'s repos.`,
        ),
      );
    }
    if (seen.has(entry.repo_id)) {
      return err(
        failure("validation", `repo ${entry.repo_id} is named twice.`),
      );
    }
    seen.add(entry.repo_id);
    const next = normalised(entry);
    if (!next.ok) return next;
    if (next.value.push_url !== known.push_url) changes.push(next.value);
  }
  const changed = new Map(changes.map((c) => [c.repo_id, c.push_url]));
  return ok({
    changes,
    after: current.map((t) =>
      changed.has(t.repo_id)
        ? { ...t, push_url: changed.get(t.repo_id) ?? null }
        : t,
    ),
  });
}

/** Writes a plan's changes. Inside the caller's transaction, beside its audit row. */
export function writePushTargets(
  ix: Internals,
  changes: readonly PushTargetPatch[],
): void {
  for (const change of changes) {
    execute(
      ix,
      qb
        .updateTable("repos")
        .set({ push_url: change.push_url })
        .where("id", "=", change.repo_id),
    );
  }
}
