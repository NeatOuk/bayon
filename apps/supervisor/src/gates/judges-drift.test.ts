import { ROUND_KINDS } from "@bayon/core";
import { expect, test } from "vitest";
import { judgesDrift } from "./run-gate.js";

// Drift is judged only where base..head is the subject (H4). an earlier change: a QA harness runs the
// branch, so a moved base is no reason to fail it — and a drifted qa_harness had no way out.

test.each(["plan_review", "parity_check", "qa_harness"])(
  "%s does not judge drift",
  (kind) => {
    expect(judgesDrift(kind)).toBe(false);
  },
);

test.each(ROUND_KINDS.filter((k) => k !== "parity_check"))(
  "%s judges drift",
  (kind) => {
    expect(judgesDrift(kind)).toBe(true);
  },
);
