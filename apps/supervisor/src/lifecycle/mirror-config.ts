// A mirror's own repo-local config, the one git config file environment
// floor cannot reach. That floor (git.ts, GIT_ENV_FLOOR) shuts out the system and the global file
// outright; SAFE_GIT's `-c` pairs outrank everything a flag can name. Neither touches
// `<mirror>/config`, and no `-c` can disable `filter.*` or `url.*.insteadOf` by wildcard: the driver
// and the URL base are part of the key. So this writes the mirror's config instead of flagging the
// call — at ensureMirror, for a mirror just cloned and for one already on disk alike.
//
// It matters because a worktree shares its mirror's config file: a `filter.*` driver written here
// runs its smudge command on every checkout in every agent worktree cut from this mirror, as the
// supervisor's own user. Nothing of ours writes these keys, so removing them takes nothing away.
//
// Which keys those are is `@bayon/core`'s mirror-config.ts — pure data, so the smoke can hold a real
// mirror to the same table. What lives here is the three-step apply the review of an earlier change showed
// the table alone does not give you:
//
//   1. read the local file with includes **off** and remove what the table refuses, `include.path`
//      and `includeIf.*.path` among them;
//   2. read it again with includes **on** and refuse the mirror outright if anything the table
//      refuses is still in effect — the first read cannot see through an include, so only this one
//      can say "no command and no redirect", rather than "the keys I looked for were not in the
//      file I read";
//   3. do the same to every `config.worktree` under the mirror, which `extensions.worktreeConfig`
//      makes git read per worktree and which step 1 never looks at. An agent can write another
//      session's, so this one is cross-session too.
//
// `<mirror>/info/attributes` is shared with every worktree the same way and is deliberately left
// alone: `* filter=p` runs nothing unless a driver `p` is defined, and after this pass no config
// file git reads for this mirror — shared, included, or per-worktree — can define one.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  err,
  ok,
  parseConfigList,
  plannedConfigRemovals,
  plannedMirrorConfig,
  redactedConfigKey,
  type ConfigChange,
  type ConfigEntry,
  type MirrorConfigWanted,
  type Result,
} from "@bayon/core";
import { frmError } from "./errors.js";
import { failedGit, hostGitRun, type HostGitCtx } from "./host-git.js";

export interface MirrorConfigCtx extends HostGitCtx {
  /**
   * Added to git's environment for this pass. The sweep puts `GIT_NO_LAZY_FETCH` on every call it
   * makes (L3) and this is one of them; nothing else needs it.
   */
  readonly gitEnv?: Readonly<Record<string, string>>;
}

export type {
  ConfigChange,
  ConfigEntry,
  MirrorConfigWanted,
} from "@bayon/core";
export {
  HARDENED_MIRROR_CONFIG,
  MIRROR_FETCH_REFSPEC,
  parseConfigList,
  plannedMirrorConfig,
  unsafeMirrorKey,
} from "@bayon/core";

/** One config file this pass owns: the mirror's shared config, or one `config.worktree`. */
interface ConfigScope {
  /** What to call it in a message. */
  readonly what: string;
  /** The `git config` words that address this file, before `--list` or a write. */
  readonly at: readonly string[];
  /** What this file must end up holding — removals only, for a per-worktree file. */
  readonly plan: (entries: readonly ConfigEntry[]) => readonly ConfigChange[];
}

const envOf = (
  ctx: MirrorConfigCtx,
): { env?: Readonly<Record<string, string>> } =>
  ctx.gitEnv === undefined ? {} : { env: ctx.gitEnv };

/** The argv one change takes: a set replaces every value the key had, an unset removes them all. */
export const configArgs = (
  change: ConfigChange,
  at: readonly string[] = ["config", "--local"],
): readonly string[] =>
  change.op === "set"
    ? [...at, "--replace-all", change.key, change.value]
    : [...at, "--unset-all", change.key];

/**
 * A config file's entries. `--no-includes` and `--includes` are both spelled out: git's default
 * differs by scope (off for `--local`, and that default is exactly what let an `include.path` hide
 * a filter driver from the first cut of this module), and a reader should not have to know which.
 */
async function listConfig(
  ctx: MirrorConfigCtx,
  mirror: string,
  scope: ConfigScope,
  includes: boolean,
  signal: AbortSignal,
): Promise<Result<readonly ConfigEntry[]>> {
  const listed = await hostGitRun(
    ctx,
    [
      "-C",
      mirror,
      ...scope.at,
      "--list",
      "-z",
      includes ? "--includes" : "--no-includes",
    ],
    { what: scope.what, signal, ...envOf(ctx) },
  );
  if (!listed.ok) return listed;
  // A repository with an empty config lists nothing and exits 0; any other exit is a directory we
  // cannot treat as a mirror.
  if (listed.value.code !== 0) return err(failedGit(scope.what, listed.value));
  return ok(parseConfigList(listed.value.stdout));
}

/** Applies `changes` to one config file, stopping at the first git refuses. */
async function applyChanges(
  ctx: MirrorConfigCtx,
  mirror: string,
  scope: ConfigScope,
  changes: readonly ConfigChange[],
  signal: AbortSignal,
): Promise<Result<void>> {
  for (const change of changes) {
    // The key is redacted in every message: for `url.<base>.insteadOf` the base *is* the key, and
    // a base is commonly spelled `https://x-access-token:<token>@github.com/` (Invariant 11).
    const named = `${change.op} ${redactedConfigKey(change.key)}`;
    const ran = await hostGitRun(
      ctx,
      ["-C", mirror, ...configArgs(change, scope.at)],
      { what: `${scope.what}: ${named}`, signal, ...envOf(ctx) },
    );
    if (!ran.ok) return ran;
    if (ran.value.code !== 0) {
      return err(
        frmError(
          "spawn_failed",
          `${scope.what}: cannot ${named}: ${ran.value.stderr.trim() || `exit ${String(ran.value.code)}`}`,
        ),
      );
    }
  }
  return ok(undefined);
}

/**
 * One config file brought to its plan's end state and then **checked with includes resolved**: the
 * check is the guarantee, the first plan only the attempt. A file that still holds a refused key
 * after its pass hides one behind an include we could not unset, and that is an error — a mirror
 * that is still hostile is not one to cut a worktree from.
 */
async function hardenScope(
  ctx: MirrorConfigCtx,
  mirror: string,
  scope: ConfigScope,
  signal: AbortSignal,
): Promise<Result<readonly ConfigChange[]>> {
  const local = await listConfig(ctx, mirror, scope, false, signal);
  if (!local.ok) return local;
  const changes = scope.plan(local.value);
  const applied = await applyChanges(ctx, mirror, scope, changes, signal);
  if (!applied.ok) return applied;
  const effective = await listConfig(ctx, mirror, scope, true, signal);
  if (!effective.ok) return effective;
  const left = scope.plan(effective.value);
  if (left.length > 0) {
    const names = left
      .map((c) => `${c.op} ${redactedConfigKey(c.key)}`)
      .join(", ");
    return err(
      frmError(
        "spawn_failed",
        `${scope.what}: ${names} still in effect once includes are resolved`,
      ),
    );
  }
  return ok(changes);
}

/** Whichever of `<mirror>/config.worktree` and the linked worktrees' own exist right now. */
async function worktreeConfigFiles(mirror: string): Promise<string[]> {
  const admin = join(mirror, "worktrees");
  const here = join(mirror, "config.worktree");
  let names: string[] = [];
  try {
    names = (await readdir(admin, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => join(admin, e.name, "config.worktree"));
  } catch {
    // No linked worktrees yet: `worktrees/` is made by the first `git worktree add`.
  }
  const found: string[] = [];
  for (const file of [here, ...names]) {
    // `git config --file` on a path that is not there is a fatal, not an empty listing.
    if (await exists(file)) found.push(file);
  }
  return found;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Brings `mirror`'s repo-local config up to the hardened one, and answers what it changed — `[]`
 * when there was nothing to do, so running it on a hardened mirror costs two reads and no write.
 * Call it under the per-mirror mutex: it reads the config and then writes it.
 *
 * `wanted.originUrl` is `repos.origin_url`, and the mirror's `remote.origin.url` is reconciled
 * against it: the key that *is* the fetch target was the one key this module's first cut read and
 * never compared, so a mirror repointed at an attacker's host stayed repointed, and every worktree,
 * review diff and gate subject after it came from there.
 *
 * A config this cannot read or write is an error, and the caller fails the spawn.
 */
export async function hardenMirrorConfig(
  ctx: MirrorConfigCtx,
  mirror: string,
  wanted: MirrorConfigWanted,
  signal: AbortSignal,
): Promise<Result<readonly ConfigChange[]>> {
  const what = `hardening the config of mirror ${mirror}`;
  const shared = await hardenScope(
    ctx,
    mirror,
    {
      what,
      at: ["config", "--local"],
      plan: (entries) => plannedMirrorConfig(entries, wanted),
    },
    signal,
  );
  if (!shared.ok) return shared;
  const changes = [...shared.value];
  for (const file of await worktreeConfigFiles(mirror)) {
    const per = await hardenScope(
      ctx,
      mirror,
      {
        what: `${what}: ${file}`,
        at: ["config", "--file", file],
        // Nothing is *written* to a per-worktree file: the keys a mirror must carry belong in the
        // one config every worktree shares.
        plan: plannedConfigRemovals,
      },
      signal,
    );
    if (!per.ok) return per;
    changes.push(...per.value);
  }
  return ok(changes);
}
