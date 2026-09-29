// Filesystem reads the sweep trusts: lstat, never following a symlink;
// paths compared as the realpath of their nearest existing ancestor (NEW-1); gitdir files resolved
// against their own directory when relative (g18); and the removal guards (NEW-4).
import type { Stats } from "node:fs";
import {
  lstat,
  readFile,
  readdir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

/** ENOENT or ENOTDIR: nothing at that path. */
export const isMissing = (e: unknown): boolean =>
  e instanceof Error &&
  "code" in e &&
  (e.code === "ENOENT" || e.code === "ENOTDIR");

const codeOf = (e: unknown): string | undefined =>
  e instanceof Error && "code" in e && typeof e.code === "string"
    ? e.code
    : undefined;

/** lstat, or null when nothing is there. Any other failure throws (the caller flags it). */
export async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

/** A directory entry's names, or null when the directory is not there. */
export async function namesOrNull(dir: string): Promise<string[] | null> {
  try {
    return await readdir(dir);
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

/** A file's text, trimmed, or null when it is not there. */
export async function textOrNull(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

/**
 * The realpath of `path`'s nearest existing ancestor, then the components under it: a gone path
 * still compares equal under /var vs /private/var or a symlinked FRM_HOME (NEW-1).
 */
export async function canon(path: string): Promise<string> {
  const rest: string[] = [];
  let cur = resolve(path);
  for (;;) {
    try {
      const real = await realpath(cur);
      return rest.length === 0 ? real : join(real, ...rest.toReversed());
    } catch (e) {
      if (!isMissing(e)) throw e;
      const parent = dirname(cur);
      if (parent === cur) return resolve(path);
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

/** `path` lies strictly inside `root` (both absolute and canonical). */
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * The target of a gitdir file (`<admin>/gitdir`, or a checkout's `.git` with `prefix` "gitdir:"),
 * resolved against the file's directory when relative (g18). Null when absent or not that shape.
 */
export async function gitdirTarget(
  file: string,
  prefix: string,
): Promise<string | null> {
  const text = await textOrNull(file);
  if (text === null || !text.startsWith(prefix)) return null;
  const target = text.slice(prefix.length).trim();
  return target === "" ? null : resolve(dirname(file), target);
}

/**
 * NEW-4: `rel`'s parent, resolved, is exactly `root`/dirname(rel): no symlinked directory between
 * the checkout and the path a removal is about to touch. `root` is a realpath.
 */
export async function parentIsPlain(
  root: string,
  rel: string,
): Promise<boolean> {
  if (isAbsolute(rel) || rel.split("/").includes("..")) return false;
  const parent = dirname(join(root, rel));
  try {
    return (await realpath(parent)) === parent;
  } catch (e) {
    if (isMissing(e)) return true; // its parent is already gone: nothing to touch
    throw e;
  }
}

/** unlink; nothing there is fine. */
export async function unlinkIfThere(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (e) {
    if (!isMissing(e)) throw e;
  }
}

/** rmdir, never recursive: null when done or already gone, else why it is still there. */
export async function rmdirIfThere(path: string): Promise<string | null> {
  try {
    await rmdir(path);
    return null;
  } catch (e) {
    if (isMissing(e)) return null;
    const code = codeOf(e);
    if (code === "ENOTEMPTY" || code === "EEXIST") {
      return `${path} is not empty`;
    }
    throw e;
  }
}
