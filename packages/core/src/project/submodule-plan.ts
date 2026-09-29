// A folder with submodules as one project (§3.1): the folder is the primary of a
// `submodule` workspace and each submodule a `dep` repo, laid out the way `workspaceLayout` checks
// (a dep's rel_path is the primary's joined with its submodule_path). Pure: the door finds the
// submodules and their folders; this names and places them.
import { joinRel } from "../workspace/layout.js";
import type { ProjectIds } from "./plan.js";

/** A submodule the door found checked out in the project's folder. */
export interface FoundSubmodule {
  /** Its path in the primary, from `.gitmodules`. */
  readonly path: string;
  /** Its checked-out folder's real path: the dep repo's origin. */
  readonly origin: string;
  /** A branch it really has, for the supervisor to fetch as its base. */
  readonly base: string;
}

export interface ProjectSubmodulePlan {
  readonly repo: {
    readonly id: string;
    readonly name: string;
    readonly origin_url: string;
    readonly default_base_branch: string;
  };
  readonly workspaceRepo: {
    readonly workspace_id: string;
    readonly repo_id: string;
    readonly rel_path: string;
    readonly role: "dep";
    readonly submodule_path: string;
  };
}

/** `<project>-<path>`, lowercased, runs of anything else as one `-`: `KITE-Web` → `kite-kite-web`. */
export const submoduleRepoId = (project: string, path: string): string =>
  `${project}-${path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}`;

/** One dep row pair per submodule. The primary's own rows are `projectPlan`'s, with the workspace
 * kind `submodule`, `has_submodules=1` and role `primary` set by the door. */
export function projectSubmodulePlan(
  ids: ProjectIds,
  primaryRelPath: string,
  found: readonly FoundSubmodule[],
): ProjectSubmodulePlan[] {
  return found.map((s) => {
    const id = submoduleRepoId(ids.repo, s.path);
    return {
      repo: {
        id,
        name: id,
        origin_url: s.origin,
        default_base_branch: s.base,
      },
      workspaceRepo: {
        workspace_id: ids.workspace,
        repo_id: id,
        rel_path: joinRel(primaryRelPath, s.path),
        role: "dep",
        submodule_path: s.path,
      },
    };
  });
}
