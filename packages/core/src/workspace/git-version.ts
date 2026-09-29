// The git a submodule workspace may run on: fixed for CVE-2024-32002 and
// CVE-2025-48384. Upstream releases only: a distro's backport cannot be seen in a version string.

/** The setting that carries the floor: the supervisor checks a spawn against it, and
 * `frm executor image` checks a freshly built image's own git against it. */
export const GIT_PATCHED_KEY = "workspace.git_patched";

/**
 * The first release of each series fixed for CVE-2025-48384 (each also carries the CVE-2024-32002
 * fix): workspace.git_patched's default.
 */
export const DEFAULT_GIT_PATCHED: readonly string[] = [
  "2.43.7",
  "2.44.4",
  "2.45.4",
  "2.46.4",
  "2.47.3",
  "2.48.2",
  "2.49.1",
  "2.50.1",
];

/** An upstream release, `major.minor.patch`. */
export const GIT_RELEASE = /^\d+\.\d+\.\d+$/;

type Triple = readonly [number, number, number];

const triple = (v: string): Triple => {
  const [a = 0, b = 0, c = 0] = v.split(".").map(Number);
  return [a, b, c];
};

const compare = (x: Triple, y: Triple): number =>
  x[0] - y[0] || x[1] - y[1] || x[2] - y[2];

/** `git version 2.50.1 (Apple Git-155)` → `2.50.1`; `2.51` → `2.51.0`; null if no version. */
export function parseGitVersion(text: string): string | null {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (m === null) return null;
  return `${m[1] ?? "0"}.${m[2] ?? "0"}.${m[3] ?? "0"}`;
}

/**
 * Why `version` may not run a submodule workspace, or null: accepted when its series is listed
 * and its patch is at or past the listed one, or when it is newer than every listed release.
 */
export function gitVersionProblem(
  version: string,
  patched: readonly string[],
): string | null {
  const v = triple(version);
  const listed = patched.filter((p) => GIT_RELEASE.test(p)).map(triple);
  const series = listed.find((p) => p[0] === v[0] && p[1] === v[1]);
  if (series !== undefined && compare(v, series) >= 0) return null;
  const newest = listed.toSorted(compare).at(-1);
  if (series === undefined && newest !== undefined && compare(v, newest) > 0) {
    return null;
  }
  const why = `git ${version} is not fixed for CVE-2024-32002 and CVE-2025-48384, so it may not check submodules out`;
  if (series !== undefined) {
    return `${why}: the floor for its ${v[0]}.${v[1]} series is ${series.join(".")}`;
  }
  return `${why}: the floor is ${newest?.join(".") ?? "(none)"} or a fixed release of an older series (${patched.join(", ")})`;
}
