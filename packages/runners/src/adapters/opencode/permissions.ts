// opencode's permission config for one session, pure. opencode evaluates the
// LAST matching rule, in key order, and a call no rule matches is `ask`, which headless can only be
// refused and which stops the loop (the an earlier change trap). So every rule here resolves to allow or
// deny, broad rules come first and narrow ones after, and the always-denied commands come last.
import {
  ALWAYS_DENIED_COMMANDS,
  allowedCommands,
  type CommandPolicy,
  type CommandPrefix,
} from "@bayon/core";
import { SAFE_GIT } from "@bayon/executors";
import { MCP_SERVER, mcpToolName } from "./tool-names.js";

type Action = "allow" | "deny";
export type PermissionConfig = Readonly<
  Record<string, Action | Readonly<Record<string, Action>>>
>;

export interface PermissionInput {
  /** The role's command policy: only its prefixes run in the shell. Absent: every command. */
  readonly policy?: CommandPolicy;
  /** Deny the file-writing tools (write, edit, apply_patch): a reviewer's session. */
  readonly readOnly: boolean;
  /** The session's MCP tools, by wire name: exactly these are callable. */
  readonly mcpTools: readonly string[];
  /** Paths outside the worktree opencode itself must read: its truncated tool output, its tmp. */
  readonly ownDirs: readonly string[];
}

/** Command text that reconfigures git around the always-denied commands. */
export const GIT_SMUGGLING: readonly string[] = [
  "GIT_CONFIG",
  "GIT_DIR=",
  "GIT_COMMON_DIR=",
  "--git-dir",
  "--config-env",
  // Every key SAFE_GIT pins (the hooks path, fsmonitor, helpers, maintenance), named by the
  // shared helper rather than spelled here.
  ...SAFE_GIT.filter((_, i) => i % 2 === 1).map((s) =>
    s.slice(0, s.indexOf("=")),
  ),
];

/**
 * The `bash` rules: the policy's prefixes (or everything), then the never-allowed commands.
 * opencode's wildcard makes a trailing ` *` optional, so `git status *` also matches `git status`;
 * `git push*` also catches spellings glued to the verb.
 */
export function bashRules(
  policy: CommandPolicy | undefined,
): Readonly<Record<string, Action>> {
  const allowed = policy === undefined ? [] : allowedCommands(policy);
  const text = (p: CommandPrefix): string => p.join(" ");
  return Object.fromEntries<Action>([
    ["*", policy === undefined ? "allow" : "deny"],
    ...allowed.map((p): [string, Action] => [`${text(p)} *`, "allow"]),
    ...ALWAYS_DENIED_COMMANDS.map((p): [string, Action] => [
      `${text(p)}*`,
      "deny",
    ]),
    // git settings smuggled past the text above (a config in the env, a hooks path on argv, another
    // git dir). Text rules are not a boundary — the sandbox is (design §5a) — but these are cheap.
    ...GIT_SMUGGLING.map((t): [string, Action] => [`*${t}*`, "deny"]),
  ]);
}

export function permissionConfig(p: PermissionInput): PermissionConfig {
  const edit: Action = p.readOnly ? "deny" : "allow";
  return {
    "*": "allow",
    bash: bashRules(p.policy),
    edit,
    // Subagents, the network and interactive prompts are off for every session.
    task: "deny",
    webfetch: "deny",
    websearch: "deny",
    skill: "deny",
    question: "deny",
    doom_loop: "deny",
    todowrite: "allow",
    external_directory: Object.fromEntries<Action>([
      ["*", "deny"],
      ...p.ownDirs.map((dir): [string, Action] => [`${dir}/*`, "allow"]),
    ]),
    // Every tool of the session's MCP server is denied, then exactly the granted ones allowed.
    [`${MCP_SERVER}_*`]: "deny",
    ...Object.fromEntries<Action>(
      p.mcpTools.map((tool): [string, Action] => [mcpToolName(tool), "allow"]),
    ),
  };
}
