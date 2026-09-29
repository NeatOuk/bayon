// The git identity agents commit as: one per install, the `agents.git_author` setting,
// seeded by 016. It is not a secret. The supervisor puts it in every session's env, so an agent's
// commit never carries the host's own user.
import { z } from "zod";

export const AGENT_GIT_AUTHOR_KEY = "agents.git_author";
export const DEFAULT_AGENT_GIT_AUTHOR = "Bayon Agent <agent@bayon.invalid>";

// `Name <email>` as git writes it: one line, a name without angle brackets, an email without spaces.
const AUTHOR = /^([^<>\r\n]*[^<>\s])\s*<([^<>\s]+)>$/;

export interface GitAuthor {
  readonly name: string;
  readonly email: string;
}

/** The setting's value: `Name <email>`, parsed. */
export const AgentGitAuthor = z
  .string()
  .trim()
  .regex(AUTHOR, "must be `Name <email>` on one line")
  .transform((value): GitAuthor => {
    const [, name = "", email = ""] = AUTHOR.exec(value) ?? [];
    return { name: name.trim(), email };
  });

/** The env git reads a commit's author and committer from. */
export const gitIdentityEnv = (
  author: GitAuthor,
): Readonly<Record<string, string>> => ({
  GIT_AUTHOR_NAME: author.name,
  GIT_AUTHOR_EMAIL: author.email,
  GIT_COMMITTER_NAME: author.name,
  GIT_COMMITTER_EMAIL: author.email,
});
