import { expect, test } from "vitest";
import {
  AgentGitAuthor,
  DEFAULT_AGENT_GIT_AUTHOR,
  gitIdentityEnv,
} from "./agent-identity.js";

test("the default parses into a name and an email", () => {
  expect(AgentGitAuthor.parse(DEFAULT_AGENT_GIT_AUTHOR)).toEqual({
    name: "Bayon Agent",
    email: "agent@bayon.invalid",
  });
});

test("surrounding and inner spacing before the email is dropped", () => {
  expect(AgentGitAuthor.parse("  Fleet Bot   <bot@example.invalid> ")).toEqual({
    name: "Fleet Bot",
    email: "bot@example.invalid",
  });
});

test.each([
  "",
  "Bayon Agent",
  "<agent@bayon.invalid>",
  "Bayon Agent <>",
  "Bayon <Agent> <agent@bayon.invalid>",
  "Bayon Agent <agent @bayon.invalid>",
  "Bayon\nAgent <agent@bayon.invalid>",
  "Bayon Agent <agent@bayon.invalid> trailing",
])("%j is refused", (value) => {
  expect(AgentGitAuthor.safeParse(value).success).toBe(false);
});

test("the env sets the author and the committer alike", () => {
  expect(
    gitIdentityEnv({ name: "Bayon Agent", email: "agent@bayon.invalid" }),
  ).toEqual({
    GIT_AUTHOR_NAME: "Bayon Agent",
    GIT_AUTHOR_EMAIL: "agent@bayon.invalid",
    GIT_COMMITTER_NAME: "Bayon Agent",
    GIT_COMMITTER_EMAIL: "agent@bayon.invalid",
  });
});
