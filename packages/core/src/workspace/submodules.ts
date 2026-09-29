import { z } from "zod";
import { err, ok, type Result } from "../errors.js";
import { hasControl, joinRel, submodulePathProblem } from "./layout.js";

// Submodules: what git says a commit's submodules are, parsed; and the plan of
// which declared repo fills each one, at which commit. Pure: the supervisor reads the mirrors.

export const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** One `[submodule "<name>"]` section of a `.gitmodules` that has a path. */
export interface GitmodulesEntry {
  readonly name: string;
  /** Relative to the repo whose `.gitmodules` it is. */
  readonly path: string;
  /** Recorded for messages only: never fetched from (§3.1). */
  readonly url: string | null;
}

const invalid = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

/**
 * Why `name` cannot name a submodule here, or null: git's own check (no `..` segment, no
 * backslash) and ours, since it rides `-c submodule.<name>.url=…`, which splits at the first `=`.
 */
export function submoduleNameProblem(name: string): string | null {
  if (name === "") return "is empty";
  if (name.startsWith("-")) return "starts with '-'";
  if (name.includes("=")) return "contains '='";
  if (name.includes("\\")) return "contains a backslash";
  if (hasControl(name)) return "contains a control character";
  if (name.split("/").includes("..")) return "has a '..' segment";
  return null;
}

const SECTION = "submodule.";

/**
 * The output of `git config --null --get-regexp '^submodule\.'` (records `key\nvalue\0`) as
 * entries with a path, by path. A bad name or path, a path named twice, or an `update=!command`
 * (a program to run; git itself dies on it, whatever --checkout says) is `validation`.
 */
export function parseGitmodules(output: string): Result<GitmodulesEntry[]> {
  const byName = new Map<
    string,
    { path?: string; url?: string; command?: boolean }
  >();
  for (const record of output.split("\0")) {
    if (record === "") continue;
    const nl = record.indexOf("\n");
    const key = nl < 0 ? record : record.slice(0, nl);
    const value = nl < 0 ? null : record.slice(nl + 1);
    const dot = key.lastIndexOf(".");
    if (!key.startsWith(SECTION) || dot <= SECTION.length) continue;
    const name = key.slice(SECTION.length, dot);
    const variable = key.slice(dot + 1).toLowerCase();
    const found = byName.get(name) ?? {};
    if (variable === "path" && value !== null) found.path = value;
    if (variable === "url" && value !== null) found.url = value;
    if (variable === "update" && value?.trimStart().startsWith("!") === true) {
      found.command = true;
    }
    byName.set(name, found);
  }
  const entries: GitmodulesEntry[] = [];
  const paths = new Set<string>();
  for (const [name, found] of byName) {
    if (found.command === true) {
      return invalid(
        `.gitmodules: submodule ${JSON.stringify(name)} has update=!command, a program to run: refused`,
      );
    }
    if (found.path === undefined) continue;
    const bad = submoduleNameProblem(name);
    if (bad !== null) {
      return invalid(
        `.gitmodules: submodule name ${JSON.stringify(name)} ${bad}`,
      );
    }
    const badPath = submodulePathProblem(found.path);
    if (badPath !== null) {
      return invalid(
        `.gitmodules: submodule ${JSON.stringify(name)}: path ${JSON.stringify(found.path)} ${badPath}`,
      );
    }
    if (paths.has(found.path)) {
      return invalid(
        `.gitmodules: path ${JSON.stringify(found.path)} is named by two submodules`,
      );
    }
    paths.add(found.path);
    entries.push({ name, path: found.path, url: found.url ?? null });
  }
  return ok(entries.toSorted((a, b) => (a.path < b.path ? -1 : 1)));
}

/** `git ls-tree -r -z <sha>` records (`<mode> <type> <sha>\t<path>\0`): the gitlinks, path → sha. */
export function parseGitlinks(output: string): ReadonlyMap<string, string> {
  const links = new Map<string, string>();
  for (const record of output.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, , sha] = record.slice(0, tab).split(" ");
    if (mode === "160000" && sha !== undefined) {
      links.set(record.slice(tab + 1), sha);
    }
  }
  return links;
}

/** A declared submodule repo: workspace_repos.submodule_path, from the superproject's root. */
export interface DeclaredSubmodule {
  readonly repoId: string;
  readonly path: string;
}

/** One submodule to materialize, parents before children. */
export interface SubmoduleEntry {
  /** From the superproject's root. */
  readonly path: string;
  /** The repo holding it, from the superproject's root; "" for the superproject. */
  readonly parent: string;
  /** Relative to `parent`: the path its `.gitmodules` names. */
  readonly rel: string;
  readonly name: string;
  readonly repoId: string;
  readonly sha: string;
  readonly url: string | null;
}

/** One repo of the tree at one commit, as read from its mirror. */
export interface SubmoduleNode {
  /** From the superproject's root; "" for the superproject. */
  readonly prefix: string;
  readonly repoId: string;
  readonly sha: string;
  readonly entries: readonly GitmodulesEntry[];
  readonly gitlinks: ReadonlyMap<string, string>;
}

/**
 * The node's submodules, each matched to a declared repo by path (§3.1): an entry with no gitlink,
 * a gitlink with no entry, or a path no repo of the workspace declares is `validation`. The URL
 * `.gitmodules` names is never used: foreman does not mirror a repo on demand (§3.2).
 */
export function childrenOf(
  node: SubmoduleNode,
  declared: readonly DeclaredSubmodule[],
): Result<SubmoduleEntry[]> {
  const at = `repo ${node.repoId} at ${node.sha.slice(0, 12)}`;
  const named = new Set(node.entries.map((e) => e.path));
  const orphan = [...node.gitlinks.keys()].find((p) => !named.has(p));
  if (orphan !== undefined) {
    return invalid(
      `${at}: the gitlink at ${JSON.stringify(orphan)} has no .gitmodules entry`,
    );
  }
  const children: SubmoduleEntry[] = [];
  for (const entry of node.entries) {
    const sha = node.gitlinks.get(entry.path);
    if (sha === undefined || !GIT_OBJECT_ID.test(sha)) {
      return invalid(
        `${at}: .gitmodules names ${JSON.stringify(entry.path)}, but the tree has no gitlink there`,
      );
    }
    const path = joinRel(node.prefix, entry.path);
    const row = declared.find((d) => d.path === path);
    if (row === undefined) {
      return invalid(
        `submodule ${JSON.stringify(path)} (url ${JSON.stringify(entry.url ?? "")}) of ${at} is not a repo of this workspace: add a repos row and a workspace_repos row with submodule_path ${JSON.stringify(path)}`,
      );
    }
    children.push({
      path,
      parent: node.prefix,
      rel: entry.path,
      name: entry.name,
      repoId: row.repoId,
      sha,
      url: entry.url,
    });
  }
  return ok(children);
}

/** worktrees.submodule_shas_json: the start SHAs and the git that made them. */
export const SubmoduleShas = z.object({
  v: z.literal(1),
  git: z.string().min(1),
  shas: z.array(
    z.object({
      path: z.string().min(1),
      repo_id: z.string().min(1),
      sha: z.string().regex(GIT_OBJECT_ID),
    }),
  ),
});
export type SubmoduleShas = z.infer<typeof SubmoduleShas>;
