// What `frm start` runs, and whether it may: the three children, their env and logs,
// and the checks made before anything starts — a home, a token, and nothing already running on it.
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SUPERVISOR_LOCK_FILE, err, ok, type Result } from "@bayon/core";
import {
  apiUrl,
  installPorts,
  lockHolder,
  readApiToken,
  type ApiTokenOptions,
} from "@bayon/executors";

type Env = Readonly<Record<string, string | undefined>>;

/** The order they start in; they stop in the reverse order. */
export const CHILD_NAMES = ["supervisor", "api", "web"] as const;
export type ChildName = (typeof CHILD_NAMES)[number];

export interface ChildPlan {
  readonly name: ChildName;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly log: string;
}

export interface StartPlan {
  readonly home: string;
  readonly env: Env;
  readonly logsDir: string;
  /** The db CLI's `up`, run to completion before any child starts. */
  readonly migrate: readonly string[];
  readonly children: readonly ChildPlan[];
  /** The API's health route: the children are up once it answers. */
  readonly healthUrl: string;
  readonly guiUrl: string;
  readonly apiPort: number;
  readonly webPort: number;
}

const invalid = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

const isSet = (value: string | undefined): boolean =>
  value !== undefined && value !== "";

/** The repo this build of frm belongs to: tools/frm/dist/start-plan.js, three levels down. */
export const repoRootOf = (moduleUrl: string): string =>
  resolve(dirname(fileURLToPath(moduleUrl)), "..", "..", "..");

/** What `frm start` runs for `env` (FRM_HOME already resolved by main), from `repoRoot`. */
export function startPlan(env: Env, repoRoot: string): Result<StartPlan> {
  const raw = env["FRM_HOME"];
  if (!isSet(raw)) {
    return invalid(
      isSet(env["FRM_DB"])
        ? "frm start needs FRM_HOME (FRM_DB alone is not enough)"
        : "no Bayon home was found: set FRM_HOME, or run pnpm frm init",
    );
  }
  const home = resolve(raw ?? "");
  const childEnv: Env = { ...env, FRM_HOME: home };
  const ports = installPorts(childEnv);
  if (!ports.ok) return ports;
  const api = apiUrl(childEnv);
  if (!api.ok) return api;
  const logsDir = join(home, "logs");
  const child = (
    name: ChildName,
    args: readonly string[],
    cwd: string = repoRoot,
  ): ChildPlan => ({ name, args, cwd, log: join(logsDir, `${name}.log`) });
  const web = join(repoRoot, "apps", "web");
  return ok({
    home,
    env: childEnv,
    logsDir,
    migrate: [join(repoRoot, "packages", "db", "dist", "cli.js"), "up"],
    children: [
      child("supervisor", [
        join(repoRoot, "apps", "supervisor", "dist", "main.js"),
      ]),
      child("api", [join(repoRoot, "apps", "api", "dist", "main.js")]),
      child("web", [join(web, "node_modules", "vite", "bin", "vite.js")], web),
    ],
    healthUrl: `${api.value}/api/v1/health`,
    guiUrl: `http://localhost:${ports.value.webPort}`,
    apiPort: ports.value.apiPort,
    webPort: ports.value.webPort,
  });
}

/** Refuses a home with no API token: every request would be refused, so say so before starting. */
export async function checkToken(
  plan: StartPlan,
  o: ApiTokenOptions = {},
): Promise<Result<void>> {
  const token = await readApiToken(plan.env, o);
  if (!token.ok) return token;
  return token.value === undefined
    ? invalid(`${plan.home} has no API token: run pnpm frm init first`)
    : ok(undefined);
}

export interface RunningProbes {
  /** Whether the API answers its health route. */
  readonly healthy: (url: string) => Promise<boolean>;
  /** Whether nothing listens on the port. */
  readonly portFree: (port: number) => Promise<boolean>;
}

/**
 * Refuses a home something already runs on: a live supervisor lock, an API that answers, or the
 * API's or the GUI's port bound. A second `frm start` would otherwise migrate under a running
 * supervisor and then fail child by child.
 */
export async function checkNotRunning(
  plan: StartPlan,
  probes: RunningProbes,
): Promise<Result<void>> {
  const refuse = (why: string): Result<never> =>
    err({
      class: "conflict",
      message: `Bayon is already running on this home (${plan.home}): stop it first, or set FRM_HOME for a second install.\n${why}`,
      retryable: false,
    });
  const holder = await lockHolder(join(plan.home, SUPERVISOR_LOCK_FILE));
  if (!holder.ok) return holder;
  if (holder.value !== "gone" && !holder.value.dead)
    return refuse(holder.value.why);
  if (await probes.healthy(plan.healthUrl))
    return refuse(`the API answers ${plan.healthUrl}`);
  for (const [what, port] of [
    ["API", plan.apiPort],
    ["GUI", plan.webPort],
  ] as const) {
    if (!(await probes.portFree(port)))
      return refuse(`the ${what}'s port ${port} is in use`);
  }
  return ok(undefined);
}
