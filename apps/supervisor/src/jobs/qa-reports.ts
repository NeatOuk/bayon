// A QA harness's report files: the ones its globs matched, copied out of the worktree
// into the gate's artifacts so they outlive the detached worktree the sweep removes (§9.2), and so
// the evidence's `artifact_paths` name files that still exist when an operator reads the gate.
//
// Capped both ways, because a project's own tooling decides how many files it writes and how large
// they are, and neither is Bayon's to trust: QA_REPORTS_MAX files, QA_REPORT_BYTES_MAX each. A glob
// may not leave the worktree (`qaReportGlob` refuses `..` and an absolute path at the door; the
// realpath check here is the second half, for a symlink that points out).
//
// **And every text report is scrubbed on the way in.** A harness is handed secrets by name, and a
// verbose failure routinely echoes what it was given -- into its own report file as readily as onto
// its stdout. Copying one verbatim would put a secret in an artifact, in the gate's evidence and,
// through the JUnit path, in the next fix session's prompt. A file that is not text cannot be
// scrubbed without corrupting it, so it is copied whole and **flagged**, and the flag reaches the
// evidence: nobody should read a report believing it was cleaned when it was not (§14, Invariant 11).
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  QA_REPORTS_MAX,
  QA_REPORT_BYTES_MAX,
  matchGlob,
  ok,
  scrubSecrets,
  scrubbableText,
  type QaSecret,
  type Result,
} from "@bayon/core";
import { frmError } from "../lifecycle/errors.js";

/** The most directory entries the walk looks at: a runaway tree is not worth an unbounded scan. */
export const QA_WALK_MAX = 20_000;
/** Directories never walked: a report is a build output, and neither of these ever is. */
const SKIP = new Set([".git", "node_modules"]);

/** One report copied out of the worktree. */
export interface CopiedReport {
  /** Its path inside the worktree, forward slashes. */
  readonly rel: string;
  /** Where it now is, under the gate's artifacts. */
  readonly path: string;
  /** The source file's size; a scrubbed copy may be shorter. */
  readonly bytes: number;
  /** It is not text, so it was copied byte for byte and **not** scrubbed. */
  readonly binary: boolean;
}

export interface CollectedReports {
  readonly reports: readonly CopiedReport[];
  /** Files a glob matched that were left where they were, and why. */
  readonly skipped: readonly string[];
}

const posix = (path: string): string => path.split(sep).join("/");

/** Every file under `root`, as worktree-relative paths, capped and with the noise skipped. */
async function walk(root: string): Promise<string[]> {
  const found: string[] = [];
  const queue: string[] = [root];
  let seen = 0;
  while (queue.length > 0 && found.length < QA_WALK_MAX) {
    const dir = queue.shift();
    if (dir === undefined) break;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable: nothing to report from it
    }
    for (const entry of entries) {
      seen += 1;
      if (seen > QA_WALK_MAX) return found;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) queue.push(full);
      } else if (entry.isFile()) {
        found.push(posix(relative(root, full)));
      }
    }
  }
  return found;
}

/**
 * The files under `worktree` that `globs` match, copied into `<into>`, keeping their relative path.
 *
 * Deterministic: the matches are sorted, so the same tree always yields the same evidence, and the
 * cap always cuts the same files. A file over the size cap is skipped rather than truncated — a
 * half a report is worse than a named absence, and the whole of the harness's own output is in the
 * log either way.
 *
 * `secrets` are the values the harness was given: a text report is written out scrubbed, and one
 * that is not text is copied unchanged and comes back `binary: true` for the evidence to flag.
 */
export async function collectReports(
  worktree: string,
  globs: readonly string[],
  into: string,
  secrets: readonly QaSecret[] = [],
): Promise<Result<CollectedReports>> {
  if (globs.length === 0) return ok({ reports: [], skipped: [] });
  const files = (await walk(worktree)).toSorted();
  const matched = files.filter((rel) => globs.some((g) => matchGlob(g, rel)));
  const reports: CopiedReport[] = [];
  const skipped: string[] = [];
  let root: string;
  try {
    root = await realpath(worktree);
  } catch (e) {
    return err(`cannot resolve the worktree ${worktree}`, e);
  }
  for (const rel of matched) {
    if (reports.length >= QA_REPORTS_MAX) {
      skipped.push(`${rel} (over the ${String(QA_REPORTS_MAX)}-file cap)`);
      continue;
    }
    const from = join(worktree, rel);
    // The second half of the escape check: a glob cannot name `..`, but a symlink inside the
    // worktree can point anywhere, and a report is only ever a file the work produced.
    let real: string;
    try {
      real = await realpath(from);
    } catch {
      skipped.push(`${rel} (unreadable)`);
      continue;
    }
    if (real !== join(root, ...rel.split("/"))) {
      skipped.push(`${rel} (a link out of the worktree)`);
      continue;
    }
    const size = await stat(from).catch(() => null);
    if (size === null) {
      skipped.push(`${rel} (unreadable)`);
      continue;
    }
    if (size.size > QA_REPORT_BYTES_MAX) {
      skipped.push(
        `${rel} (${String(size.size)} bytes, over the ${String(QA_REPORT_BYTES_MAX)}-byte cap)`,
      );
      continue;
    }
    const to = join(into, ...rel.split("/"));
    let binary = false;
    try {
      await mkdir(dirname(to), { recursive: true, mode: 0o700 });
      // Read it whole first: the size cap above already bounds this, and the scrub needs the file
      // rather than a stream — a secret split across two chunks is a secret that survives.
      const bytes = await readFile(from);
      const text = scrubbableText(bytes);
      if (text === null) {
        binary = true;
        await copyFile(from, to);
      } else {
        await writeFile(to, scrubSecrets(text, secrets), { mode: 0o600 });
      }
    } catch (e) {
      skipped.push(`${rel} (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    reports.push({ rel, path: to, bytes: size.size, binary });
  }
  return ok({ reports, skipped });
}

const err = (message: string, cause: unknown): Result<never> => ({
  ok: false,
  error: frmError("internal", message, String(cause)),
});
