// Checks 5, 7, 8 and 9, each run in one checkout: an operation in progress,
// index bits that hide changes (C1c), changes and untracked files (C1a), and the ignored inventory
// (Q5, N2). The status argv come from argv.ts only.
import { join } from "node:path";
import {
  FOREMAN_ENTRY,
  disposableIgnored,
  foremanPacketsOnly,
  hiddenIndexBits,
  parseStatusZ,
} from "@bayon/core";
import { changesArgs, ignoredArgs } from "./argv.js";
import type { SweepDeps } from "./deps.js";
import { lstatOrNull, namesOrNull } from "./fs.js";
import { sweepGit } from "./git.js";
import { go, stop, type Step } from "./step.js";

/** What git leaves in a gitdir while an operation is half done (L1). */
const IN_PROGRESS: readonly (readonly [string, string])[] = [
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase or am"],
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["sequencer", "sequencer"],
  ["BISECT_LOG", "bisect"],
];

/** Check 5, in one gitdir (the admin dir or a module's). */
export async function noOperation(gitdir: string): Promise<Step<void>> {
  for (const [marker, op] of IN_PROGRESS) {
    if ((await lstatOrNull(join(gitdir, marker))) !== null) {
      return stop("dirty", `a ${op} is in progress in ${gitdir}`);
    }
  }
  return go(undefined);
}

const firsts = (items: readonly string[]): string =>
  items.slice(0, 5).join(", ") +
  (items.length > 5 ? `, … (${items.length})` : "");

/** Check 7: assume-unchanged and skip-worktree bits hide changes from every status (g13). */
export async function noHiddenBits(
  deps: SweepDeps,
  dir: string,
  signal: AbortSignal,
): Promise<Step<void>> {
  const out = await sweepGit(
    deps,
    ["-C", dir, "ls-files", "-v", "-z"],
    signal,
    {
      trim: false,
    },
  );
  if (!out.ok) return stop("unverifiable", `${dir}: ${out.error.message}`);
  const hidden = hiddenIndexBits(out.value);
  return hidden.length === 0
    ? go(undefined)
    : stop(
        "unverifiable",
        `${dir}: index bits hide changes to ${firsts(hidden)}`,
      );
}

/** Check 8: any change or untracked file, listed in full by the -c pairs (g12). */
export async function noChanges(
  deps: SweepDeps,
  dir: string,
  signal: AbortSignal,
): Promise<Step<void>> {
  const out = await sweepGit(deps, changesArgs(dir), signal, { trim: false });
  if (!out.ok) return stop("unverifiable", `${dir}: ${out.error.message}`);
  const entries = parseStatusZ(out.value);
  return entries.length === 0
    ? go(undefined)
    : stop(
        "dirty",
        `${dir}: ${firsts(entries.map((e) => `${e.code.trim()} ${e.path}`))}`,
      );
}

/**
 * Check 9: every ignored entry must be disposable, or the row is kept `ignored` (Q5). A root
 * `.foreman/` holding nothing but hand-off packets and the context store is disposable (N2, M12);
 * anywhere else it is not.
 * Resolves to the disposable entries' absolute paths.
 */
export async function ignoredInventory(
  deps: SweepDeps,
  dir: string,
  atRoot: boolean,
  names: readonly string[],
  signal: AbortSignal,
): Promise<Step<string[]>> {
  const out = await sweepGit(deps, ignoredArgs(dir), signal, { trim: false });
  if (!out.ok) return stop("unverifiable", `${dir}: ${out.error.message}`);
  const disposable: string[] = [];
  const kept: string[] = [];
  for (const e of parseStatusZ(out.value)) {
    if (e.code !== "!!") continue; // changes and untracked files are check 8's
    const path = join(dir, e.path.replace(/\/$/, ""));
    if (e.path === FOREMAN_ENTRY && atRoot) {
      const inside = await namesOrNull(path);
      if (inside !== null && foremanPacketsOnly(inside)) {
        disposable.push(path);
        continue;
      }
    } else if (disposableIgnored(e.path, names)) {
      disposable.push(path);
      continue;
    }
    kept.push(e.path);
  }
  return kept.length === 0
    ? go(disposable)
    : stop("ignored", `${dir}: ${firsts(kept)}`);
}
