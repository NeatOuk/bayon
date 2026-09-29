// The command policy (core) as this CLI's permission rules: one `Bash(<prefix>:*)` per
// argv prefix. The rule syntax is this adapter's alone (Invariant 1). The CLI's disallowedTools
// outrank its allowedTools, so the always-denied prefixes hold whatever a profile allows.
import {
  ALWAYS_DENIED_COMMANDS,
  allowedCommands,
  type CommandPolicy,
  type CommandPrefix,
} from "@bayon/core";

/** `Bash(git commit:*)`: the CLI's prefix rule for one argv prefix. */
export const bashRule = (prefix: CommandPrefix): string =>
  `Bash(${prefix.join(" ")}:*)`;

/** The rules a policy auto-approves; none without one. */
export const policyTools = (policy: CommandPolicy | undefined): string[] =>
  policy === undefined ? [] : allowedCommands(policy).map(bashRule);

/** Denied to every session this adapter starts, a profile's own allowlist notwithstanding. */
export const ALWAYS_DISALLOWED_TOOLS: readonly string[] =
  ALWAYS_DENIED_COMMANDS.map(bashRule);
