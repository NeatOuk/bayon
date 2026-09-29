import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  LOCAL_ROOTS_KEY,
  LocalRoots,
  err,
  isInsideRoot,
  ok,
  type Result,
} from "@bayon/core";
import { getSettings, type Db } from "@bayon/db";
import { z } from "zod";

// A folder as a project's repo (§14): accepted only inside one `projects.local_roots`
// allows, a shell-only control. Real paths on both sides, so a symlink inside an allowed folder
// that points out of it is refused, and the real path is what the repo row keeps.
// ponytail: checked at create time only. The mirror is cloned at the project's first spawn, which
// can be much later, and a folder swapped for a symlink by then is followed. Whoever can do that
// already writes to the operator's folders.

const invalid = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

const HOW =
  `a folder is accepted only inside one allowed from a shell: ` +
  `frm settings set ${LOCAL_ROOTS_KEY} <absolute path> --yes (§14)`;

/** fs/promises' realpath is the native one: on a case-insensitive disk (macOS) it also returns
 * the on-disk case, so a path typed in another case still compares equal. The JS realpathSync
 * would not — it keeps the case it was given, and refuses such a path. */
const realOrNull = (path: string): Promise<string | null> =>
  realpath(path).catch(() => null);

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/** A working tree (`.git` dir or file) or a bare repo (`HEAD` plus `objects`). */
async function isGitRepo(dir: string): Promise<boolean> {
  if (await exists(join(dir, ".git"))) return true;
  return (
    (await exists(join(dir, "HEAD"))) && (await exists(join(dir, "objects")))
  );
}

/**
 * `path`'s real path, when it is a git repo inside a folder the operator allowed; otherwise why
 * not (`validation`). A missing path and one outside every allowed folder get the same answer, so
 * the route is no oracle for what exists elsewhere on the host.
 */
export async function allowedLocalRepo(
  db: Db,
  path: string,
): Promise<Result<string>> {
  const rows = await getSettings(db, [LOCAL_ROOTS_KEY]);
  if (!rows.ok) return rows;
  const roots = LocalRoots.safeParse(rows.value.get(LOCAL_ROOTS_KEY) ?? []);
  if (!roots.success) {
    return invalid(
      `${LOCAL_ROOTS_KEY} is not a list of absolute paths: ${z.prettifyError(roots.error)}`,
    );
  }
  if (roots.data.length === 0) {
    return invalid(`repo url ${JSON.stringify(path)} is a folder; ${HOW}`);
  }
  const real = await realOrNull(path);
  const realRoots = await Promise.all(roots.data.map(realOrNull));
  const inside =
    real !== null &&
    realRoots.some((root) => root !== null && isInsideRoot(real, root));
  if (!inside) {
    return invalid(
      `${JSON.stringify(path)} is not an existing folder inside one ${LOCAL_ROOTS_KEY} allows; ${HOW}`,
    );
  }
  if (!(await isGitRepo(real))) {
    return invalid(`${JSON.stringify(path)} is not a git repository`);
  }
  return ok(real);
}
