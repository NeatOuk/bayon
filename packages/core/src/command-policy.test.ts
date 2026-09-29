import { expect, test } from "vitest";
import {
  ALWAYS_DENIED_COMMANDS,
  COMMAND_GROUPS,
  CommandPolicy,
  allowedCommands,
  defaultCommandPolicy,
  writesGit,
} from "./command-policy.js";

const joined = (prefixes: readonly (readonly string[])[]): string[] =>
  prefixes.map((p) => p.join(" "));

/** A role's default policy; a role that has none fails the test. */
function policyOf(role: string): CommandPolicy {
  const policy = defaultCommandPolicy(role);
  if (policy === undefined) throw new Error(`no default policy for ${role}`);
  return policy;
}

test("a builder may do its git work, update from its base, and run node and the package manager", () => {
  const policy = policyOf("builder");
  expect(policy).toEqual({
    role: "builder",
    groups: ["git_work", "base_update", "package_manager", "node", "make_dirs"],
  });
  const allowed = joined(allowedCommands(policy));
  for (const cmd of [
    "git status",
    "git add",
    "git commit",
    "git fetch",
    "git merge",
    "git rebase",
    "pnpm",
    "node",
    "mkdir",
  ]) {
    expect(allowed).toContain(cmd);
  }
});

test("an investigator commits its plan but does not update from its base", () => {
  const policy = policyOf("investigator");
  expect(policy.groups).not.toContain("base_update");
  expect(joined(allowedCommands(policy))).toContain("git commit");
});

test("a reviewer reads git and nothing else: no commit, fetch, push, remote or config", () => {
  const policy = policyOf("reviewer");
  expect(policy).toEqual({ role: "reviewer", groups: ["git_read"] });
  const allowed = joined(allowedCommands(policy));
  expect(allowed).toEqual([
    "git status",
    "git diff",
    "git log",
    "git show",
    "git ls-files",
    "git grep",
  ]);
  for (const cmd of [
    "git add",
    "git commit",
    "git fetch",
    "git merge",
    "git rebase",
    "git push",
    "git remote",
    "git config",
    "pnpm",
    "node",
  ]) {
    expect(allowed).not.toContain(cmd);
  }
  expect(writesGit(policy)).toBe(false);
});

test.each(["orchestrator", "conformance", "", "toString"])(
  "role %j has no default policy",
  (role) => {
    expect(defaultCommandPolicy(role)).toBeUndefined();
  },
);

test("push, remote and config are always denied, and no group allows them", () => {
  const denied = joined(ALWAYS_DENIED_COMMANDS);
  expect(denied).toEqual(["git push", "git remote", "git config"]);
  const every = joined(Object.values(COMMAND_GROUPS).flat());
  for (const cmd of denied) expect(every).not.toContain(cmd);
});

test("the policy a flag carries is parsed strictly", () => {
  expect(
    CommandPolicy.safeParse({ role: "builder", groups: ["git_work"] }).success,
  ).toBe(true);
  expect(
    CommandPolicy.safeParse({ role: "builder", groups: ["git_push"] }).success,
  ).toBe(false);
  expect(
    CommandPolicy.safeParse({ role: "builder", groups: [], allow: ["x"] })
      .success,
  ).toBe(false);
});

test("writesGit: a git group writes the repository's git state, the others do not", () => {
  expect(writesGit({ role: "r", groups: ["git_work"] })).toBe(true);
  expect(writesGit({ role: "r", groups: ["base_update"] })).toBe(true);
  expect(writesGit({ role: "r", groups: ["node", "package_manager"] })).toBe(
    false,
  );
});
