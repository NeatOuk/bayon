// The store of originals a context proxy keeps (spec M12, §8.5): `<storeDir>/<sha>.txt`, one file
// per compressed block, named by its content's sha256. A block is compressed only once its original
// is here, so the marker's path always leads to the whole text. Runner-neutral.
//
// Where it may be (review of): the proxy writes from the supervisor, outside any sandbox,
// by path. A store inside a directory the session can write (its worktree, its home) could be swapped
// for a symlink between any check and the write, and the supervisor would then write where the
// sandbox forbids the model to. Node has no openat, so the race is not fought: the store must lie
// outside every root the session writes (`<session root>/.foreman/ctx`), where the sandboxed model can
// read an original and never change the path to it. Each write still refuses a store directory that
// is a symlink, and opens a fresh temp file O_CREAT|O_EXCL|O_NOFOLLOW before renaming it into place:
// defence in depth where a runner has no sandbox (its shell already runs as the user).
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  sep,
} from "node:path";
import { CONTEXT_STORE_DIR, err, ok, type Result } from "@bayon/core";
import { frmError } from "./errors.js";

const WRITE_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_NOFOLLOW;

/** `a` is `b` or lies inside it. */
const within = (a: string, b: string): boolean => {
  const rel = relative(b, a);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
};

/**
 * Why `storeDir` cannot be a store for a session that writes `writable`, or null. It must be
 * absolute and normal, end in `.foreman/ctx` (the name the rules' store guard knows, so a read of an
 * original is never compressed), and neither lie inside nor contain any root the session writes.
 */
export function storeProblem(
  storeDir: string,
  writable: readonly string[],
): string | null {
  if (!isAbsolute(storeDir) || normalize(storeDir) !== storeDir) {
    return "the store is not an absolute, normal path";
  }
  const [parent, name] = CONTEXT_STORE_DIR.split("/");
  if (basename(storeDir) !== name || basename(dirname(storeDir)) !== parent) {
    return `the store must end in ${CONTEXT_STORE_DIR}`;
  }
  const clash = writable.some(
    (w) => within(storeDir, w) || within(w, storeDir),
  );
  return clash
    ? "the store lies inside a root the session writes (or holds one): the session could redirect the supervisor's writes"
    : null;
}

const codeOf = (e: unknown): string =>
  e instanceof Error &&
  "code" in e &&
  typeof e.code === "string" &&
  /^[A-Z0-9_]+$/.test(e.code)
    ? e.code
    : "error";

/**
 * Writes `text` to `<storeDir>/<name>` atomically. `name` is the caller's (`<sha256>.txt`), never
 * derived from the text here. An error is the reason, never thrown.
 */
export async function storeOriginal(
  storeDir: string,
  name: string,
  text: string,
): Promise<Result<void>> {
  if (!/^[0-9a-f]{64}\.txt$/.test(name)) {
    return err(frmError("validation", "context store: not a content name"));
  }
  const tmp = join(storeDir, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await mkdir(storeDir, { recursive: true, mode: 0o700 });
    if (!(await lstat(storeDir)).isDirectory()) {
      return err(
        frmError(
          "validation",
          "context store: not a plain directory (a symlink, or a file)",
        ),
      );
    }
    const file = await open(tmp, WRITE_FLAGS, 0o600);
    try {
      await file.writeFile(text, "utf8");
    } finally {
      await file.close();
    }
    await rename(tmp, join(storeDir, name));
    return ok(undefined);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    return err(
      frmError("internal", `context store: write failed (${codeOf(e)})`),
    );
  }
}
