// Where an exec runs. The remote layout is fixed and derived, never
// remembered: remote_root/{bin,run,mirror,work}, a session root is exactly work/<sid>, mounted in
// its container under /frm/s/<sid>. The ssh user is in the docker group, so a host exec is
// root-equivalent on a shared host: the host route is only for supervisor chores under
// {mirror,bin,run}, and nothing it is given may point into a session.
import { posix } from "node:path";
import { frmError } from "../errors.js";
import type { Argv } from "../types.js";

export const SESSION_ID = /^[0-9A-Za-z_-]{1,64}$/;

/** Paths inside a session container. Fixed; overridable only by the loopback test harness. */
export interface ContainerPaths {
  /** The parent of every session root: `<sessions>/<sid>` is `Prepared.root`. */
  readonly sessions: string;
  /** The tmpfs holding the exec-shim's records. */
  readonly run: string;
  /** Where the exec-shim is mounted, read-only. */
  readonly shim: string;
}

/** remote_root/mirror is mounted read-only at its own host path, so a `clone
 * --reference`'s alternates resolve in a container and on the docker host alike. */
export const CONTAINER_PATHS: ContainerPaths = {
  sessions: "/frm/s",
  run: "/run/frm",
  shim: "/opt/frm/exec-shim.mjs",
};

export interface RemoteLayout {
  readonly root: string;
  readonly bin: string;
  readonly run: string;
  readonly mirror: string;
  readonly work: string;
}

export function layoutOf(root: string): RemoteLayout {
  return {
    root,
    bin: `${root}/bin`,
    run: `${root}/run`,
    mirror: `${root}/mirror`,
    work: `${root}/work`,
  };
}

export type Route =
  | { readonly kind: "container"; readonly sessionId: string }
  | { readonly kind: "host" };

export const within = (path: string, dir: string): boolean =>
  path === dir || path.startsWith(`${dir}/`);

/** An absolute path with no `.`, `..` or doubled slashes; a trailing slash is dropped. */
export function normalPath(path: string, what: string): string {
  const trimmed =
    path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  if (!posix.isAbsolute(trimmed) || posix.normalize(trimmed) !== trimmed) {
    throw invalid(`${what} must be an absolute, normalized path: ${path}`);
  }
  return trimmed;
}

export function routeExec(
  layout: RemoteLayout,
  paths: ContainerPaths,
  argv: Argv,
  cwd: string,
  env: Readonly<Record<string, string>>,
): Route {
  const dir = normalPath(cwd, "cwd");
  if (within(dir, paths.sessions)) {
    const sessionId = dir.slice(paths.sessions.length + 1).split("/")[0] ?? "";
    if (!SESSION_ID.test(sessionId)) {
      throw invalid(`cwd ${dir} names no session`);
    }
    return { kind: "container", sessionId };
  }
  if (![layout.mirror, layout.bin, layout.run].some((d) => within(dir, d))) {
    throw invalid(
      `cwd ${dir}: a docker-host exec runs only under ${layout.root}/{mirror,bin,run}; ` +
        "session content runs in its container",
    );
  }
  assertHostArgs(layout, dir, argv, env);
  return { kind: "host" };
}

const looksLikePath = (s: string): boolean =>
  s.startsWith("/") || s.startsWith(".") || s.includes("/");

/** An argument and, for `--flag=value`, its value. */
const candidates = (arg: string): string[] => {
  const eq = arg.indexOf("=");
  return eq >= 0 ? [arg, arg.slice(eq + 1)] : [arg];
};

/**
 * Refuses a host exec whose program, arguments or env reach into a session (`git -C …/work/x`,
 * `--git-dir=…`, `tee ../work/x/f`, `GIT_DIR`), and arguments that leave remote_root. Env values
 * are split on `:` and may point elsewhere (PATH, HOME), just never into a session.
 */
function assertHostArgs(
  layout: RemoteLayout,
  cwd: string,
  argv: Argv,
  env: Readonly<Record<string, string>>,
): void {
  const [program, ...args] = argv;
  const intoSession = (candidate: string) =>
    looksLikePath(candidate) &&
    within(posix.resolve(cwd, candidate), layout.work);
  if (intoSession(program)) {
    throw invalid(`the program ${program} lies in a session root`);
  }
  for (const arg of args) {
    for (const candidate of candidates(arg)) {
      if (candidate === "/dev/null" || !looksLikePath(candidate)) continue;
      const target = posix.resolve(cwd, candidate);
      if (within(target, layout.work) || !within(target, layout.root)) {
        throw invalid(
          `argument ${JSON.stringify(arg)} reaches ${target}: a docker-host exec stays in ` +
            `${layout.root} and out of its sessions`,
        );
      }
    }
  }
  for (const [name, value] of Object.entries(env)) {
    if (value.split(":").some(intoSession)) {
      throw invalid(`env ${name} points into a session root`);
    }
  }
}

function invalid(message: string) {
  return frmError("validation", message);
}
