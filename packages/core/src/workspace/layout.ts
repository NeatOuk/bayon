import { err, ok, type Result } from "../errors.js";

// A workspace's shape (§3.1): which repo is the primary, which are sibling
// worktrees, which are submodules of the primary. Pure: the supervisor reads the rows and acts on
// the layout; every refusal here comes before any git.

export type WorkspaceKind = "single" | "multi" | "submodule";

/** The columns of a workspace_repos row joined with its repo that the layout reads. */
export interface LayoutRow {
  /** The repo id. */
  readonly id: string;
  readonly rel_path: string;
  readonly role: string;
  readonly submodule_path: string | null;
  readonly has_submodules: number;
}

export interface WorkspaceLayout<R extends LayoutRow> {
  readonly kind: WorkspaceKind;
  /** The runner's cwd: `role='primary'`, or a single workspace's only repo. */
  readonly primary: R;
  /** multi: the other repos, sibling worktrees, by rel_path. */
  readonly extras: readonly R[];
  /** submodule: the declared submodules, by submodule_path. */
  readonly submodules: readonly R[];
}

const invalid = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

/** A C0 control character or DEL: never in a path or a name git config carries. */
export const hasControl = (s: string): boolean =>
  [...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

/**
 * Why `path` is not a clean relative path, or null: no leading `/`, no empty, `.` or `..` segment
 * (so it equals its own posix normalization), no `.git` segment in any case, no backslash, no
 * control character.
 */
export function relPathProblem(path: string): string | null {
  if (path === "") return "is empty";
  if (path.startsWith("/")) return "is absolute";
  if (path.includes("\\")) return "contains a backslash";
  if (hasControl(path)) return "contains a control character";
  const segments = path.split("/");
  if (segments.includes("")) return "has an empty segment";
  if (segments.some((s) => s === "." || s === "..")) {
    return "has a '.' or '..' segment";
  }
  if (segments.some((s) => s.toLowerCase() === ".git"))
    return "has a .git segment";
  return null;
}

/** First segments a repo's rel_path may not take: the session's home (container) and packets. */
const RESERVED = [".frm", ".foreman"];
const SEGMENT = /^[A-Za-z0-9._@+-]+$/;

/** Why `path` cannot be a submodule path (L1), or null: relPathProblem's rules and more. */
export function submodulePathProblem(path: string): string | null {
  const rel = relPathProblem(path);
  if (rel !== null) return rel;
  for (const segment of path.split("/")) {
    if (!SEGMENT.test(segment)) {
      return `has a segment outside [A-Za-z0-9._@+-]: ${JSON.stringify(segment)}`;
    }
    if (segment.startsWith("-")) return "has a segment starting with '-'";
    if (segment.toLowerCase() === ".git") return "has a .git segment";
  }
  return null;
}

/** posix.join of two clean relative paths. */
export const joinRel = (a: string, b: string): string =>
  a === "" ? b : b === "" ? a : `${a}/${b}`;

const nests = (a: string, b: string): boolean =>
  a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`);

const byKey =
  <R>(key: (r: R) => string) =>
  (a: R, b: R): number =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;

function relPaths<R extends LayoutRow>(rows: readonly R[]): string | null {
  for (const r of rows) {
    const problem = relPathProblem(r.rel_path);
    if (problem !== null) {
      return `repo ${r.id}: rel_path ${JSON.stringify(r.rel_path)} ${problem}`;
    }
    const first = r.rel_path.split("/")[0] ?? "";
    if (RESERVED.includes(first)) {
      return `repo ${r.id}: rel_path ${JSON.stringify(r.rel_path)} starts with ${first}, which the session keeps for itself`;
    }
  }
  return null;
}

function single<R extends LayoutRow>(
  rows: readonly R[],
): Result<WorkspaceLayout<R>> {
  const [row, ...more] = rows;
  if (row === undefined || more.length > 0) {
    return invalid(
      `a single workspace has exactly one repo, not ${rows.length}`,
    );
  }
  if (row.has_submodules !== 0) {
    return invalid(
      `repo ${row.id} has submodules: its workspace's kind is submodule`,
    );
  }
  if (row.submodule_path !== null) {
    return invalid(`repo ${row.id}: a single workspace has no submodule_path`);
  }
  return ok({ kind: "single", primary: row, extras: [], submodules: [] });
}

function onePrimary<R extends LayoutRow>(
  kind: WorkspaceKind,
  rows: readonly R[],
): Result<{ primary: R; others: R[] }> {
  const primaries = rows.filter((r) => r.role === "primary");
  const [primary, ...more] = primaries;
  if (primary === undefined || more.length > 0) {
    return invalid(
      `a ${kind} workspace has exactly one primary repo, not ${primaries.length}`,
    );
  }
  const odd = rows.find((r) => r.role !== "primary" && r.role !== "dep");
  if (odd !== undefined) {
    return invalid(
      `repo ${odd.id}: role ${JSON.stringify(odd.role)} is neither primary nor dep`,
    );
  }
  return ok({ primary, others: rows.filter((r) => r !== primary) });
}

function multi<R extends LayoutRow>(
  rows: readonly R[],
): Result<WorkspaceLayout<R>> {
  const split = onePrimary("multi", rows);
  if (!split.ok) return split;
  const { primary, others } = split.value;
  if (others.length === 0) {
    return invalid("a multi workspace has at least one dep repo");
  }
  for (const r of rows) {
    if (r.submodule_path !== null) {
      return invalid(`repo ${r.id}: a multi workspace has no submodule_path`);
    }
    if (r.has_submodules !== 0) {
      return invalid(
        `repo ${r.id} has submodules: a multi workspace takes none in M4`,
      );
    }
  }
  for (const [i, a] of rows.entries()) {
    const b = rows.slice(i + 1).find((o) => nests(a.rel_path, o.rel_path));
    if (b !== undefined) {
      return invalid(
        `repos ${a.id} and ${b.id} nest (rel_path ${JSON.stringify(a.rel_path)} and ${JSON.stringify(b.rel_path)}): sibling worktrees must not`,
      );
    }
  }
  return ok({
    kind: "multi",
    primary,
    extras: others.toSorted(byKey((r) => r.rel_path)),
    submodules: [],
  });
}

function submodule<R extends LayoutRow>(
  rows: readonly R[],
): Result<WorkspaceLayout<R>> {
  const split = onePrimary("submodule", rows);
  if (!split.ok) return split;
  const { primary, others } = split.value;
  if (primary.has_submodules !== 1) {
    return invalid(
      `repo ${primary.id}: the primary of a submodule workspace has has_submodules=1`,
    );
  }
  if (primary.submodule_path !== null) {
    return invalid(`repo ${primary.id}: the primary has no submodule_path`);
  }
  const seen = new Set<string>();
  for (const r of others) {
    const path = r.submodule_path;
    if (path === null) {
      return invalid(
        `repo ${r.id}: every other repo of a submodule workspace has a submodule_path`,
      );
    }
    const problem = submodulePathProblem(path);
    if (problem !== null) {
      return invalid(
        `repo ${r.id}: submodule_path ${JSON.stringify(path)} ${problem}`,
      );
    }
    if (seen.has(path)) {
      return invalid(
        `submodule_path ${JSON.stringify(path)} is declared twice`,
      );
    }
    seen.add(path);
    const want = joinRel(primary.rel_path, path);
    if (r.rel_path !== want) {
      return invalid(
        `repo ${r.id}: rel_path ${JSON.stringify(r.rel_path)} must be ${JSON.stringify(want)} (the primary's rel_path joined with its submodule_path)`,
      );
    }
  }
  return ok({
    kind: "submodule",
    primary,
    extras: [],
    submodules: others.toSorted(byKey((r) => r.submodule_path ?? "")),
  });
}

/** A workspace's layout from its kind and rows, or `validation` saying why not. */
export function workspaceLayout<R extends LayoutRow>(
  kind: string,
  rows: readonly R[],
): Result<WorkspaceLayout<R>> {
  if (rows.length === 0) return invalid("the workspace has no repos");
  const paths = relPaths(rows);
  if (paths !== null) return invalid(paths);
  switch (kind) {
    case "single":
      return single(rows);
    case "multi":
      return multi(rows);
    case "submodule":
      return submodule(rows);
    default:
      return invalid(`unknown workspace kind ${JSON.stringify(kind)}`);
  }
}
