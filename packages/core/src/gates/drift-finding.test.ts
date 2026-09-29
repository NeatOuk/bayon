import { describe, expect, test } from "vitest";
import { EVIDENCE } from "../laws/fixtures.js";
import {
  DRIFT_CATEGORY,
  DRIFT_REPO_PREFIX,
  DRIFT_SEVERITY,
  driftFinding,
} from "./drift-finding.js";
import { ReviewFinding } from "./findings.js";

// a round gate that failed because its base moved carries one system finding, the fix
// round's instruction to bring the branch up to date before it resubmits. Informational only.

const BASE = "a".repeat(40);
const TIP = "c".repeat(40);
const atPin = {
  reason: "base_drift",
  detail: "the pinned base is not the tip",
  drift: { base_sha: BASE, tip_sha: TIP },
};

describe("driftFinding", () => {
  test("a drift at pin: the summary alone says what to merge; the detail names the full tip", () => {
    const f = driftFinding("code_review", atPin);
    expect(ReviewFinding.safeParse(f).success).toBe(true);
    expect(f).toMatchObject({
      severity: "minor",
      category: DRIFT_CATEGORY,
      file: null,
      line: null,
    });
    expect(f?.summary).toBe(
      `The base branch moved: merge ${TIP.slice(0, 12)} into this branch, rerun the checks, then resubmit`,
    );
    expect(f?.detail_md).toContain(BASE);
    expect(f?.detail_md).toContain(`\`git merge ${TIP}\``);
    expect(f?.detail_md).toContain("finding_resolve");
  });

  test("the finding is below the seeded blocking severities (007), so it never holds pass_review", () => {
    expect(["blocker", "major"]).not.toContain(DRIFT_SEVERITY);
  });

  test("a per-repo gate's finding names its repo first", () => {
    const f = driftFinding("code_review", atPin, "api");
    expect(f?.summary.startsWith(`${DRIFT_REPO_PREFIX}api: `)).toBe(true);
  });

  test("a review that ran and was failed on its drift flag names the pinned base, and merges FETCH_HEAD", () => {
    const reviewed = {
      ...EVIDENCE,
      flags: { base_drift: true },
      reason: "base_drift",
    };
    const f = driftFinding("ce_review", reviewed);
    expect(f?.summary).toContain("merge its tip into this branch");
    expect(f?.detail_md).toContain(EVIDENCE.subject.base_sha);
    expect(f?.detail_md).toContain("git merge FETCH_HEAD");
  });

  test("evidence with no shas still gives the instruction", () => {
    const f = driftFinding("lint_check", { reason: "base_drift" });
    expect(f?.severity).toBe("minor");
    expect(f?.detail_md).toContain("git merge FETCH_HEAD");
  });

  test.each(["plan_review", "qa_harness"])(
    "%s is not a round a fix answers: no finding",
    (kind) => {
      expect(driftFinding(kind, atPin)).toBeNull();
    },
  );
});
