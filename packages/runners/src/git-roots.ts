// The git dirs a linked worktree writes outside its cwd, shared by every adapter that
// grants them through an OS sandbox (runner-neutral: each adapter says how it grants them).
// Bayon's local worktrees come off a bare mirror, so a commit writes the worktree's own git dir
// (<common>/worktrees/<id>) and the mirror's objects, refs and logs. A write sandbox refuses each of
// them unless it is a writable root, as checked live in the design. The mirror's
// config and hooks are never among them: a session can neither rewire a remote nor plant a hook the
// supervisor's own git would run. A plain checkout (git dir = common dir) gets none, since granting
// its git dir would grant its config and hooks too.
import { isAbsolute, join } from "node:path";
import { err, ok, type Result } from "@bayon/core";
import {
  GIT_ENV_FLOOR,
  safeGitArgs,
  type Argv,
  type Executor,
} from "@bayon/executors";
import { asFrmError, frmError } from "./errors.js";
import { tee } from "./tee.js";

const decoder = new TextDecoder();
const NOT_A_REPO = /not a git repository/i;

/** The flags are safeGitArgs: this asks git about a cwd a session can write. */
const REV_PARSE: Argv = [
  "git",
  ...safeGitArgs([
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
    "--git-common-dir",
  ]),
];

/** The roots from rev-parse's two lines; none unless both are absolute and differ. */
export function rootsOf(gitDir: string, commonDir: string): readonly string[] {
  if (!isAbsolute(gitDir) || !isAbsolute(commonDir) || gitDir === commonDir) {
    return [];
  }
  return [
    gitDir,
    join(commonDir, "objects"),
    join(commonDir, "refs"),
    join(commonDir, "logs"),
  ];
}

/**
 * The writable roots `cwd`'s git state needs, asked of git on `ex`. None when `cwd` is not in a git
 * repository (nothing to grant) or is a plain checkout; an error when git cannot answer at all.
 */
export async function gitWritableRoots(
  ex: Executor,
  cwd: string,
  path: string,
): Promise<Result<readonly string[]>> {
  try {
    const proc = await ex.exec([...REV_PARSE], {
      cwd,
      // C locale: the not-a-repository message is matched in English.
      env: { ...GIT_ENV_FLOOR, PATH: path, LC_ALL: "C" },
      stdin: "ignore",
    });
    const { records, exited } = tee(proc);
    const lines: string[] = [];
    for await (const r of records) lines.push(decoder.decode(r.bytes).trim());
    const status = await exited;
    if (status.code !== 0) {
      return NOT_A_REPO.test(status.stderrTail)
        ? ok([])
        : err(
            frmError(
              "spawn_failed",
              `git rev-parse in ${cwd} failed: ${status.stderrTail.slice(-500)}`,
            ),
          );
    }
    const [gitDir = "", commonDir = ""] = lines;
    return ok(rootsOf(gitDir, commonDir));
  } catch (e) {
    return err(asFrmError(e, "spawn_failed", `cannot run git in ${cwd}`));
  }
}
