// The commands a worker role's shell may run with nobody to ask, stated runner-neutrally
// as argv prefixes. Each adapter maps a policy its own way (Invariant 1): as its runner's permission
// rules, or through its runner's sandbox. None of it is a sandbox of its own: `node` and the package
// manager run arbitrary code, so untrusted work stays container-only (executors.untrusted_roles).
import { z } from "zod";

/** A command's argv starts with one of these to belong to it. */
export type CommandPrefix = readonly [string, ...string[]];

export const CommandGroup = z.enum([
  "git_read",
  "git_work",
  "base_update",
  "package_manager",
  "node",
  "make_dirs",
]);
export type CommandGroup = z.infer<typeof CommandGroup>;

const git = (sub: string): CommandPrefix => ["git", sub];

/** What each group names. `git_work` is the workaround profile's set, the pilot's proof it is enough. */
export const COMMAND_GROUPS: Readonly<
  Record<CommandGroup, readonly CommandPrefix[]>
> = {
  // A reviewer's reads of the history and the tree: nothing here writes the repository.
  git_read: ["status", "diff", "log", "show", "ls-files", "grep"].map(git),
  git_work: [
    "status",
    "diff",
    "log",
    "show",
    "add",
    "commit",
    "restore",
    "rm",
    "mv",
    "rev-parse",
    "branch",
    "stash",
    "ls-files",
    "grep",
  ].map(git),
  // Bringing a branch up to date with its base (a code review fails on drift, §13.2): never push.
  base_update: ["fetch", "merge", "rebase", "merge-base"].map(git),
  // The repo's install, build, lint and test scripts run through its package manager.
  package_manager: [["pnpm"], ["npm"], ["npx"], ["yarn"]],
  node: [["node"]],
  make_dirs: [["mkdir"]],
};

/** Denied to every session whatever its profile allows: Bayon never pushes, nor rewires a remote. */
export const ALWAYS_DENIED_COMMANDS: readonly CommandPrefix[] = [
  "push",
  "remote",
  "config",
].map(git);

/** What rides in SpawnSpec.flags under COMMAND_POLICY_FLAG: the role it is for, and its groups. */
export const CommandPolicy = z.strictObject({
  role: z.string().min(1),
  groups: z.array(CommandGroup),
});
export type CommandPolicy = z.infer<typeof CommandPolicy>;

/** The flags key a policy rides under; a profile's own permission_json replaces it. */
export const COMMAND_POLICY_FLAG = "commandPolicy";

// The orchestrator has no shell (plan rule 4) and conformance brings its own: neither gets a
// default. An investigator commits a plan, which is never drift-checked. A reviewer only reads
//. The builder's groups are listed, not CommandGroup.options, so a new group never
// changes a builder's policy, nor with it its config hash (§8.1).
const ROLE_GROUPS: Readonly<Record<string, readonly CommandGroup[]>> = {
  builder: ["git_work", "base_update", "package_manager", "node", "make_dirs"],
  investigator: ["git_work", "package_manager", "node", "make_dirs"],
  reviewer: ["git_read"],
};

/** A worker role's default policy, or undefined for a role that has none. */
export function defaultCommandPolicy(role: string): CommandPolicy | undefined {
  const groups = Object.hasOwn(ROLE_GROUPS, role)
    ? ROLE_GROUPS[role]
    : undefined;
  return groups === undefined ? undefined : { role, groups: [...groups] };
}

/** Every prefix a policy allows, in group order. */
export const allowedCommands = (policy: CommandPolicy): CommandPrefix[] =>
  policy.groups.flatMap((g) => COMMAND_GROUPS[g]);

/** Whether a policy lets its session write the repository's git state (commit, merge, fetch). */
export const writesGit = (policy: CommandPolicy): boolean =>
  policy.groups.includes("git_work") || policy.groups.includes("base_update");
