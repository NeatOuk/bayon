// What the local executor's health measures (§6.1): FRM_HOME/work, where every local
// session root and worktree lives, and each repo's mirror (§9.2: the supervisor's own, at
// repos.mirror_path), read from the db on every check so a repo added at runtime counts. Before
// the db is handed over, the work root alone.
import { join } from "node:path";
import { listRepos, type Db } from "@bayon/db";

export function localDiskPaths(
  frmHome: string,
  db: () => Db | undefined,
): () => Promise<readonly string[]> {
  const work = join(frmHome, "work");
  return async () => {
    const open = db();
    if (open === undefined) return [work];
    const repos = await listRepos(open);
    // The executor records a throw as a disk failure: the paths could not be listed.
    if (!repos.ok) throw new Error(`cannot list repos: ${repos.error.message}`);
    return [work, ...repos.value.map((r) => r.mirror_path)];
  };
}
