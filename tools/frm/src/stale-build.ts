// A stale `tools/frm/dist` answers a command it does not know yet as a bad option, and the operator
// has no way to tell. So main.ts compares the newest source (src/**, tests aside: tsc builds them
// into dist/ too, but they change no command) with the newest file tsc wrote, and says so once when
// the source is newer. Only in a source checkout — a dist/ with src/ beside it — and one stat walk
// of each: a few hundred files, a few milliseconds.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const STALE_BUILD_NOTICE =
  "this frm build is out of date — run: pnpm -w build";

export interface BuildTimes {
  /** The newest source file's mtime; null when there is no source here. */
  readonly newestSourceMs: number | null;
  /** The newest built file's mtime; null when there is no build here. */
  readonly newestBuiltMs: number | null;
}

export function isStale(t: BuildTimes): boolean {
  return (
    t.newestSourceMs !== null &&
    t.newestBuiltMs !== null &&
    t.newestSourceMs > t.newestBuiltMs
  );
}

/** The two file-system calls the walk makes: injected by tests, node's own otherwise. */
export interface WalkFs {
  readonly entries: (dir: string) => readonly {
    readonly name: string;
    readonly isDirectory: () => boolean;
  }[];
  readonly mtimeMs: (file: string) => number;
}

const nodeFs: WalkFs = {
  entries: (dir) => readdirSync(dir, { withFileTypes: true }),
  mtimeMs: (file) => statSync(file).mtimeMs,
};

/**
 * The newest mtime of the files under `dir` that `keep` accepts; null when there are none or `dir`
 * is not there. A file that vanishes mid-walk throws: staleBuildNotice catches it.
 */
export function newestMtimeMs(
  dir: string,
  keep: (file: string) => boolean = () => true,
  fs: WalkFs = nodeFs,
): number | null {
  let entries;
  try {
    entries = fs.entries(dir);
  } catch {
    return null;
  }
  let newest: number | null = null;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    const at = entry.isDirectory()
      ? newestMtimeMs(path, keep, fs)
      : keep(path)
        ? fs.mtimeMs(path)
        : null;
    if (at !== null && (newest === null || at > newest)) newest = at;
  }
  return newest;
}

const isSource = (file: string): boolean =>
  file.endsWith(".ts") && !file.endsWith(".test.ts");

/**
 * The notice for the build in `distDir`, or null when it is current or not a source checkout. A
 * notice must never cost the command: any error in the walk (a file removed mid-build, a directory
 * it may not read) is "not stale".
 */
export function staleBuildNotice(
  distDir: string,
  fs: WalkFs = nodeFs,
): string | null {
  try {
    const times: BuildTimes = {
      newestSourceMs: newestMtimeMs(join(distDir, "..", "src"), isSource, fs),
      newestBuiltMs: newestMtimeMs(distDir, () => true, fs),
    };
    return isStale(times) ? STALE_BUILD_NOTICE : null;
  } catch {
    return null;
  }
}
