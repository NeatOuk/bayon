import {
  CONFORMANCE_TEST_IDS,
  CONFORMANCE_TEST_NAMES,
  NON_NEGOTIABLE_TESTS,
  type ConformanceSummary,
  type ConformanceTestId,
} from "@bayon/core";
import { labelOf, type ConformanceState } from "@/components/status";
import { StatusBadge } from "@/components/status-badge";

// One badge per §15 test from a stored result's summary: pass, fail, n/a (capability declared absent
// and its fallback verified) or incomplete. Tests 9, 10 and 14 are non-negotiable for unattended work.
// The tone and the words come from the status map (status.ts).

export function testState(
  summary: ConformanceSummary,
  id: ConformanceTestId,
): ConformanceState {
  if (summary.passed.includes(id)) return "pass";
  if (summary.failed.includes(id)) return "fail";
  if (summary.na.includes(id)) return "na";
  if (summary.incomplete.includes(id)) return "incomplete";
  return "not run";
}

export function ConformanceBadges({
  summary,
}: {
  readonly summary: ConformanceSummary;
}) {
  return (
    <div className="flex flex-col gap-1">
      <ul aria-label="conformance tests" className="flex flex-wrap gap-1">
        {CONFORMANCE_TEST_IDS.map((id) => {
          const state = testState(summary, id);
          const required = NON_NEGOTIABLE_TESTS.includes(id);
          return (
            <li key={id}>
              <StatusBadge
                entity="conformance"
                state={state}
                label={`${id} ${CONFORMANCE_TEST_NAMES[id]}${required ? "*" : ""}: ${labelOf("conformance", state)}`}
              />
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">
        {[
          "* non-negotiable for unattended work",
          summary.certifiable ? "certifiable run" : "not a certifiable run",
          ...(summary.unverified_caps.length === 0
            ? []
            : [`declared, unverified: ${summary.unverified_caps.join(", ")}`]),
        ].join(" · ")}
      </p>
    </div>
  );
}
