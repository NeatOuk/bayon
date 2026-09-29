// The argv of one Codex process, verified against 0.154.0's `exec --help` and
// `exec resume --help`. Security keys ride `-c` on every turn: SessionFlags outrank the user and
// the project config layers, and the worktree is never trusted (facts 8, 9). Pure.
import { err, ok, type Result } from "@bayon/core";
import { SESSION_GIT_ENV, type ExecutorKind } from "@bayon/executors";
import { frmError } from "../../errors.js";

export type Sandbox = "read-only" | "workspace-write" | "danger-full-access";
export const SANDBOXES: readonly Sandbox[] = [
  "read-only",
  "workspace-write",
  "danger-full-access",
];

/** The session's MCP server name, and the env var its bearer is read from (never argv). */
export const MCP_SERVER = "foreman";
export const MCP_TOKEN_ENV = "FRM_MCP_TOKEN";

/** 0.154.0's `inherit = "core"` set (fact 8), named again as an allowlist. */
const CORE_ENV = [
  "PATH",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "USER",
] as const;

/**
 * The agents' git identity, which is not a secret: without it the shell's commits would
 * carry the host's own user.
 */
export const GIT_IDENTITY_ENV = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

/**
 * What the model's shell may see: the core set, the agents' git identity, and the session's git
 * floor, named by the shared helper rather than spelled here. Nothing else.
 */
export const SHELL_ENV_ALLOW: readonly string[] = [
  ...CORE_ENV,
  ...GIT_IDENTITY_ENV,
  ...Object.keys(SESSION_GIT_ENV),
];

/**
 * What the model's shell is **set** to: the identity, read from the session's env and
 * nothing else of it, then the session git floor from the helper, whatever that env holds.
 *
 * Inheritance cannot be relied on for either (shell-env.test.ts, on 0.154.0). Where Codex builds a
 * command's env from the policy alone (`codex sandbox`), `inherit = "core"` keeps the core set
 * before `include_only` is ever applied, and `*KEY*` is a default exclude the floor's config-key
 * names would match (fact 8): only `set` gets them there. Where it lays the policy env over its own
 * inherited env (the exec shell tool), `set` is what makes the floor's values win over whatever the
 * turn host's env holds. `include_only` still has the last word over `set`.
 */
export function shellSet(
  env: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return {
    ...Object.fromEntries(
      GIT_IDENTITY_ENV.flatMap((name) => {
        const value = env[name];
        return value === undefined ? [] : [[name, value] as const];
      }),
    ),
    ...SESSION_GIT_ENV,
  };
}

// A TOML basic string: JSON's escaping is a subset of TOML's for the text we pass.
const str = (value: string): string => JSON.stringify(value);
const list = (values: readonly string[]): string =>
  `[${values.map(str).join(",")}]`;
/** A TOML inline table of basic strings. */
const table = (entries: Readonly<Record<string, string>>): string =>
  `{${Object.entries(entries)
    .map(([key, value]) => `${str(key)}=${str(value)}`)
    .join(",")}}`;
const c = (key: string, value: string): readonly string[] => [
  "-c",
  `${key}=${value}`,
];

export interface TurnArgs {
  readonly bin: readonly [string, ...string[]];
  readonly cwd: string;
  readonly model: string;
  readonly effort?: string;
  readonly sandbox: Sandbox;
  /**
   * Directories writable besides the cwd under `workspace-write`: a linked worktree's git dirs, so
   * a builder can commit (git-roots.ts). Ignored under any other sandbox.
   */
  readonly writableRoots?: readonly string[];
  readonly mcp?: {
    readonly url: string;
    readonly tools: readonly string[];
    readonly startupTimeoutSec: number;
  };
  /**
   * The session's env, read for the agents' git identity alone (shellSet): only those names, and
   * the git floor, ever reach argv. Absent, the shell still gets the floor.
   */
  readonly shellEnv?: Readonly<Record<string, string>>;
  /** Resume this thread (turn N+1); absent for a thread's first turn. */
  readonly thread?: string;
  /** --output-schema and -o (SendSpec.output): paths as the executor's processes see them. */
  readonly output?: { readonly schemaPath: string; readonly path: string };
}

/** The `-c` overrides every turn carries: the policy, whatever any config file says. */
export function securityArgs(a: TurnArgs): readonly string[] {
  const server = `mcp_servers.${MCP_SERVER}`;
  return [
    ...c("approval_policy", str("never")),
    ...c("sandbox_mode", str(a.sandbox)),
    ...c("sandbox_workspace_write.network_access", "false"),
    ...(a.sandbox === "workspace-write" &&
    a.writableRoots !== undefined &&
    a.writableRoots.length > 0
      ? c("sandbox_workspace_write.writable_roots", list(a.writableRoots))
      : []),
    ...c("shell_environment_policy.inherit", str("core")),
    ...c("shell_environment_policy.ignore_default_excludes", "false"),
    ...c("shell_environment_policy.include_only", list(SHELL_ENV_ALLOW)),
    ...c("shell_environment_policy.set", table(shellSet(a.shellEnv ?? {}))),
    ...c("cli_auth_credentials_store", str("file")),
    ...c("web_search", str("disabled")),
    ...(a.mcp === undefined
      ? []
      : [
          ...c(`${server}.url`, str(a.mcp.url)),
          ...c(`${server}.bearer_token_env_var`, str(MCP_TOKEN_ENV)),
          ...c(`${server}.enabled_tools`, list(a.mcp.tools)),
          // 0.154.0 gates every MCP call on approval: a tool with no annotations needs one unless
          // its mode is `approve` or the sandbox has full disk access, and `never` denies it before
          // any request leaves the CLI. The server is ours, per-session and
          // role-scoped, and enforces its own laws; with nobody to ask, the gate could only refuse.
          ...c(`${server}.default_tools_approval_mode`, str("approve")),
          ...c(`${server}.required`, "true"),
          ...c(
            `${server}.startup_timeout_sec`,
            String(a.mcp.startupTimeoutSec),
          ),
        ]),
  ];
}

/** `exec` for a thread's first turn, `exec resume <thread>` after; the prompt is always stdin. */
export function turnArgv(a: TurnArgs): readonly [string, ...string[]] {
  const common = [
    "--json",
    "--strict-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "-m",
    a.model,
    ...(a.effort === undefined
      ? []
      : c("model_reasoning_effort", str(a.effort))),
    ...securityArgs(a),
    ...(a.output === undefined
      ? []
      : ["--output-schema", a.output.schemaPath, "-o", a.output.path]),
  ];
  const [program, ...rest] = a.bin;
  return a.thread === undefined
    ? [program, ...rest, "exec", ...common, "-C", a.cwd, "-"]
    : // resume has no -C: its cwd is the process's, which the host sets to the worktree (fact 1).
      [program, ...rest, "exec", "resume", ...common, a.thread, "-"];
}

/**
 * The session's sandbox: the profile's, else the default for the executor's kind. Codex's own
 * sandbox cannot run under Docker's seccomp, so `danger-full-access` is for containers only,
 * where the container is the boundary (design Q5).
 */
export function resolveSandbox(
  wanted: Sandbox | undefined,
  byKind: Readonly<Partial<Record<ExecutorKind, Sandbox>>>,
  kind: ExecutorKind,
): Result<Sandbox> {
  const sandbox = wanted ?? byKind[kind] ?? "workspace-write";
  return sandbox === "danger-full-access" && kind !== "container"
    ? err(
        frmError(
          "validation",
          `sandbox danger-full-access needs a container executor, not ${kind}`,
        ),
      )
    : ok(sandbox);
}
