// Stale mirror temp dirs: what ensureMirror leaves beside a
// mirror when a first-use clone is killed. Only `.<basename>.clone-XXXXXX` real directories older
// than max(worktree.mirror_tmp_min_age_ms, 2 × workspace.git_timeout_ms), under that mirror's mutex
// (so never beside this supervisor's own clone), and never the mirror itself or anything else.
import { rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isStaleCloneName } from "@bayon/core";
import { listRepos } from "@bayon/db";
import { mirrorKey, mirrorPathProblem } from "../mirror.js";
import type { SweepDeps } from "./deps.js";
import { lstatOrNull, namesOrNull } from "./fs.js";

/** The newest mtime a clone writes: the dir, its objects/ and objects/pack/. */
async function newestMtime(dir: string): Promise<number> {
  let newest = 0;
  for (const path of [
    dir,
    join(dir, "objects"),
    join(dir, "objects", "pack"),
  ]) {
    const st = await lstatOrNull(path);
    if (st !== null) newest = Math.max(newest, st.mtimeMs);
  }
  return newest;
}

/** Removes every stale temp dir beside the repos' mirrors; resolves to how many went. */
export async function sweepMirrorTemps(
  deps: SweepDeps,
  minAgeMs: number,
  signal: AbortSignal,
): Promise<number> {
  const repos = await listRepos(deps.db);
  if (!repos.ok) {
    deps.log.error(
      { error: repos.error },
      "sweep: cannot list the repos' mirrors",
    );
    return 0;
  }
  const floor = Math.max(
    minAgeMs,
    2 * deps.settings["workspace.git_timeout_ms"],
  );
  const mirrors = [...new Set(repos.value.map((r) => r.mirror_path))].filter(
    (m) => mirrorPathProblem(m) === null,
  );
  let removed = 0;
  for (const mirror of mirrors) {
    if (signal.aborted) break;
    removed += await deps.mirrors.run(mirrorKey(mirror), async () => {
      let gone = 0;
      try {
        const parent = dirname(mirror);
        for (const name of (await namesOrNull(parent)) ?? []) {
          const path = join(parent, name);
          if (!isStaleCloneName(name, basename(mirror)) || path === mirror)
            continue;
          const st = await lstatOrNull(path);
          if (st === null || !st.isDirectory()) continue; // a symlink or a file: never
          if (deps.clock.now() - (await newestMtime(path)) <= floor) continue;
          await rm(path, { recursive: true, force: true });
          deps.log.info(
            { mirror, path },
            "sweep: removed a stale mirror clone",
          );
          gone += 1;
        }
      } catch (e) {
        deps.log.error(
          { mirror, err: String(e) },
          "sweep: cannot clear stale mirror clones",
        );
      }
      return gone;
    });
  }
  return removed;
}
