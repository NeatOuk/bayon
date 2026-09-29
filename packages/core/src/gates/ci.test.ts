import { describe, expect, test } from "vitest";
import {
  CI_SUBJECT,
  QA_CI_NEEDS_PR,
  QA_CI_TIMEOUT_DEFAULT_MS,
  QA_CI_TIMEOUT_MAX_MS,
  QA_CI_TIMEOUT_MIN_MS,
  ciCheckName,
  ciEntryNamesNoCheck,
  ciRequiredRefusal,
  ciRequirements,
  isCiGate,
  qaCiRefusal,
  qaCiTimeoutOf,
  requiredIn,
} from "./ci.js";
import { NO_QA_CONFIG, qaGateOpens } from "./qa.js";
import { CI_CHECK_NAME_MAX } from "./schemas.js";

const MIN = 60_000;

describe("the mode and its refusal", () => {
  test("ci opens a gate, as command does; none and pending open none", () => {
    expect(qaGateOpens("command")).toBe(true);
    expect(qaGateOpens("ci")).toBe(true);
    expect(qaGateOpens("none")).toBe(false);
    expect(qaGateOpens("pending")).toBe(false);
    expect(NO_QA_CONFIG).toMatchObject({ ci_checks: [], ci_timeout_ms: null });
  });

  test("ci needs pull requests opened when review passes; nothing else is refused", () => {
    const pr = { mode: "pull_request", when: "review_passed" } as const;
    expect(qaCiRefusal("ci", pr)).toBeNull();
    expect(qaCiRefusal("ci", { ...pr, mode: "push" })).toBe(QA_CI_NEEDS_PR);
    expect(qaCiRefusal("ci", { ...pr, mode: "none" })).toBe(QA_CI_NEEDS_PR);
    expect(qaCiRefusal("ci", { ...pr, when: "done" })).toBe(QA_CI_NEEDS_PR);
    for (const mode of ["none", "command", "pending"] as const) {
      expect(qaCiRefusal(mode, { mode: "none", when: "done" })).toBeNull();
    }
  });

  test("a CI gate is known by the subject it opened with", () => {
    expect(isCiGate({ subject_kind: CI_SUBJECT })).toBe(true);
    expect(isCiGate({ subject_kind: "workspace" })).toBe(false);
  });

  test("the wait: the default, and the project's held to its bounds", () => {
    expect(qaCiTimeoutOf(null)).toBe(QA_CI_TIMEOUT_DEFAULT_MS);
    expect(qaCiTimeoutOf(undefined)).toBe(QA_CI_TIMEOUT_DEFAULT_MS);
    expect(qaCiTimeoutOf(30 * MIN)).toBe(30 * MIN);
    expect(qaCiTimeoutOf(1)).toBe(QA_CI_TIMEOUT_MIN_MS);
    expect(qaCiTimeoutOf(10 ** 12)).toBe(QA_CI_TIMEOUT_MAX_MS);
  });
});

describe("ciCheckName", () => {
  test("control characters and runs of whitespace fold to one space", () => {
    expect(ciCheckName("  build\u0000\u001b[31m\n  test\t ")).toBe(
      "build [31m test",
    );
  });

  test("nothing left is no name", () => {
    expect(ciCheckName(" \n\u0007 ")).toBeNull();
  });

  test("a long name is cut to the cap, with an ellipsis", () => {
    const long = ciCheckName("x".repeat(CI_CHECK_NAME_MAX + 5));
    expect(long).toHaveLength(CI_CHECK_NAME_MAX);
    expect(long?.endsWith("…")).toBe(true);
    expect(ciCheckName("x".repeat(CI_CHECK_NAME_MAX))).toHaveLength(
      CI_CHECK_NAME_MAX,
    );
  });
});

describe("required entries: a name, or <repo_id>:<name> (review CRITICAL 1)", () => {
  const REPOS = ["web", "api"];

  test("a plain name is required in every repo; a qualified one in its repo only", () => {
    const required = ciRequirements(["build", "web:e2e", "api:lint"], REPOS);
    expect(required).toEqual([
      { repo_id: null, name: "build" },
      { repo_id: "web", name: "e2e" },
      { repo_id: "api", name: "lint" },
    ]);
    expect(requiredIn(required, "web")).toEqual(["build", "e2e"]);
    expect(requiredIn(required, "api")).toEqual(["build", "lint"]);
    expect(requiredIn([...required, ...required], "api")).toEqual([
      "build",
      "lint",
    ]);
  });

  test("split on the first colon only, and only when the prefix is a repo of the project", () => {
    expect(
      ciRequirements(
        ["web:lint:eslint", "ci/lint: eslint", "lint:eslint", "web:  "],
        REPOS,
      ),
    ).toEqual([
      { repo_id: "web", name: "lint:eslint" },
      // No repo-shaped prefix, or no such repo, or nothing after it: a plain name, whole.
      { repo_id: null, name: "ci/lint: eslint" },
      { repo_id: null, name: "lint:eslint" },
      { repo_id: null, name: "web:  " },
    ]);
  });

  test("the writers refuse a prefix that is no repo of the project, and a repo with no check", () => {
    expect(
      ciRequiredRefusal(["build", "web:e2e", "ci/x: y"], REPOS),
    ).toBeNull();
    expect(ciRequiredRefusal(["lint:eslint"], REPOS)).toBe(
      "The required check “lint:eslint” reads as repo “lint”, which is not one of this project's repos (web, api): to require a check whose name has a colon, put its repo first, as “web:lint:eslint”.",
    );
    expect(ciRequiredRefusal(["web: "], REPOS)).toBe(
      "The required check “web: ” names repo “web” but no check: write it as “web:<check name>”.",
    );
    expect(ciRequiredRefusal(["x:y"], [])).toContain("as “<repo>:x:y”");
  });

  test("the wire schema's half: a repo-shaped prefix with nothing after it", () => {
    expect(ciEntryNamesNoCheck("web:")).toBe(true);
    expect(ciEntryNamesNoCheck("web: x")).toBe(false);
    expect(ciEntryNamesNoCheck("build")).toBe(false);
  });
});
