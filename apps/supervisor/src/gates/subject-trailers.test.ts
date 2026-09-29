// the gate refuses a branch whose own commits attribute the work to the agent or its
// harness. The git call is exercised by the gate's own tests; what is worth pinning here is the
// parsing and the line it draws — a trailer starts a line, so a message that merely talks about one
// is not itself a violation.
import { expect, test } from "vitest";
import { offendingCommits } from "./subject.js";

/**
 * `git log --format=%H%n%B%x1e` as git really prints it: sha, message, then `\n\x1e\n`, newest
 * first. Verified against real git output, not assumed.
 */
const log = (...commits: readonly (readonly [string, string])[]): string =>
  commits.map(([sha, message]) => `${sha}\n${message}\n\n`).join("");

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";

test("a clean log offends nobody", () => {
  expect(
    offendingCommits(
      log([SHA, "feat(db): 013 budgets"], [OTHER, "fix(web): a dead feed"]),
    ),
  ).toEqual([]);
});

test("an empty log is clean", () => {
  expect(offendingCommits("")).toEqual([]);
});

// Named by shape, never by runner (Invariant 1): a harness's own spelling of its session trailer
// is a runner string, and this file may not hold one.
test.each([
  ["Co-Authored-By: Someone <s@example.com>"],
  ["co-authored-by: someone <s@example.com>"],
  ["Agent-Session: https://example.test/session_abc"],
  ["agent-session: https://example.test/session_abc"],
  ["Session: https://example.test/session_abc"],
  ["  Co-Authored-By: indented still counts"],
  ["Co-Authored-By : spaced before the colon"],
])("%s is an attribution trailer", (trailer) => {
  const found = offendingCommits(
    log([SHA, `feat(db): a change\n\n${trailer}`]),
  );
  expect(found).toEqual(["0123456789ab feat(db): a change"]);
});

test("a message that talks about a trailer does not carry one", () => {
  const messages = [
    "docs: say why we drop the Co-Authored-By trailer",
    "chore: strip session trailers in the merge script\n\nThe merge script greps for co-authored-by and refuses the branch.",
  ];
  for (const message of messages) {
    expect(offendingCommits(log([SHA, message]))).toEqual([]);
  }
});

test("every offender is named, newest first, and a clean commit between them is not", () => {
  const found = offendingCommits(
    log(
      [SHA, "feat: newest\n\nCo-Authored-By: A <a@example.com>"],
      [OTHER, "feat: clean middle"],
      [SHA, "feat: oldest\n\nAgent-Session: https://example.test"],
    ),
  );
  expect(found).toEqual([
    "0123456789ab feat: newest",
    "0123456789ab feat: oldest",
  ]);
});
