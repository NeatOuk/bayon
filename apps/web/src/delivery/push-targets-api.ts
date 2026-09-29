import { checkPushUrl } from "@bayon/core";
import {
  ProjectSettingsState,
  PushTargetsDetected,
  type ProjectRepoView,
  type PushTargetPatch,
} from "@bayon/proto";
import { patchJson, postJson } from "@/api/http";

// A project's push targets (migration 039): where each repo's delivered work goes when that is not
// its origin. Detect reads the folders and saves nothing; saving is `PATCH /projects/:id
// {push_urls}`, audited `project.set` with the rest of the settings.

const segment = encodeURIComponent;

/** `POST /projects/:id/push-targets/detect`: each repo's folder origin now, never saved. */
export const detectPushTargets = (
  project: string,
): Promise<PushTargetsDetected> =>
  postJson(
    `/projects/${segment(project)}/push-targets/detect`,
    {},
    PushTargetsDetected,
  );

/** `PATCH /projects/:id {push_urls}`: only the targets that change; null pushes to the origin. */
export const setPushTargets = (
  project: string,
  pushUrls: readonly PushTargetPatch[],
): Promise<ProjectSettingsState> =>
  patchJson(
    `/projects/${segment(project)}`,
    { push_urls: pushUrls },
    ProjectSettingsState,
  );

/** A project's repos as the section lists them: the primary first, then submodules by path. */
export const reposInOrder = (
  repos: readonly ProjectRepoView[],
): ProjectRepoView[] =>
  repos.toSorted(
    (a, b) =>
      (a.submodule_path === null ? 0 : 1) -
        (b.submodule_path === null ? 0 : 1) ||
      (a.submodule_path ?? "").localeCompare(b.submodule_path ?? ""),
  );

/** The drafts, by repo id: each repo's stored target, blank for none. */
export const draftsOf = (
  repos: readonly Pick<ProjectRepoView, "id" | "push_url">[],
): Record<string, string> =>
  Object.fromEntries(repos.map((r) => [r.id, r.push_url ?? ""]));

/** What saving `drafts` would change: one entry per repo whose target differs from the stored. */
export function changesOf(
  repos: readonly ProjectRepoView[],
  drafts: Readonly<Record<string, string>>,
): PushTargetPatch[] {
  return repos.flatMap((repo) => {
    const typed = (drafts[repo.id] ?? "").trim();
    const next = typed === "" ? null : typed;
    return next === repo.push_url ? [] : [{ repo_id: repo.id, push_url: next }];
  });
}

/** The first change core's shape rule refuses, as `<repo>: <sentence>`; null when all pass. */
export function problemOf(changes: readonly PushTargetPatch[]): string | null {
  for (const change of changes) {
    if (change.push_url === null) continue;
    const checked = checkPushUrl(change.push_url);
    if (!checked.ok) return `${change.repo_id}: ${checked.error.message}`;
  }
  return null;
}
