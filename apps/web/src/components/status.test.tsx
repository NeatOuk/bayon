import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import {
  ENTITY_STATES,
  STATUS,
  TONES,
  gateStatus,
  labelOf,
  pulseStatus,
  sessionStatus,
  statusOf,
  type StatusEntity,
} from "@/components/status";
import { StatusBadge, StatusIcon } from "@/components/status-badge";

// The status map: every state of every entity has a tone and a human label, and the
// states that need two columns (an exited session's reason, a failed gate's, a skipped pulse's)
// read by them.

const typed = Object.entries(ENTITY_STATES) as [
  StatusEntity,
  readonly string[],
][];

describe.each(typed)("%s", (entity, states) => {
  test("maps every value of its enum, and nothing else", () => {
    expect(Object.keys(STATUS[entity]).sort()).toEqual([...states].sort());
  });

  test.each(states)("%s has a tone, an icon and a human label", (state) => {
    const status = statusOf(entity, state);
    expect(TONES).toContain(status.tone);
    expect(status.icon).toBeTruthy();
    expect(status.label).not.toBe("");
    expect(status.label).not.toMatch(/_/);
  });
});

test("every entity's entries are complete, typed or not", () => {
  for (const map of Object.values(STATUS))
    for (const status of Object.values(map)) {
      expect(TONES).toContain(status.tone);
      expect(status.label).not.toMatch(/_/);
    }
});

test("the audit's disagreements now read one way", () => {
  // A blocked ticket is danger, never green; a done one is the only green ticket.
  expect(statusOf("ticket", "blocked").tone).toBe("danger");
  expect(statusOf("ticket", "done").tone).toBe("success");
  expect(labelOf("ticket", "qa_harness")).toBe("QA harness");
  // A crashed session is danger; a running one is at work, not green.
  expect(sessionStatus("exited", "error")).toMatchObject({
    tone: "danger",
    label: "Crashed",
  });
  expect(sessionStatus("exited", "ok").tone).toBe("success");
  expect(sessionStatus("running").tone).toBe("info");
  expect(sessionStatus("exited").label).toBe("Exited");
  // Waiting on you asks, it does not alarm.
  expect(statusOf("waiting", "you").tone).toBe("warning");
});

test.each([
  ["passed", null, "success", "Passed"],
  ["running", null, "info", "Running"],
  ["waived", null, "neutral", "Waived"],
  ["failed", null, "danger", "Failed"],
  ["failed", "blocking_findings", "danger", "Failed (blocking findings)"],
  ["failed", "reviewer_error", "warning", "Failed (reviewer error)"],
  ["failed", "no_reviewer", "warning", "Failed (no reviewer)"],
  ["failed", "superseded", "neutral", "Failed (superseded)"],
  ["failed", "timeout", "neutral", "Failed (timeout)"],
  // A reason a newer server added reads as stored, and still as a failure.
  ["failed", "brand_new_reason", "danger", "Failed (brand new reason)"],
  // A state a newer server added reads as stored, neutral.
  ["pending", null, "neutral", "Pending"],
])("a %s gate (%s) is %s, %j", (state, reason, tone, label) => {
  expect(gateStatus({ state, reason })).toMatchObject({ tone, label });
});

test.each([
  ["done", null, "success", "Done"],
  ["failed", null, "danger", "Failed"],
  ["expired", null, "warning", "Expired"],
  ["skipped", "rate_capped", "warning", "Skipped (rate capped)"],
  ["skipped", "nothing_to_do", "neutral", "Skipped (nothing to do)"],
  ["skipped", "new_reason", "neutral", "Skipped (new reason)"],
  ["skipped", null, "neutral", "Skipped"],
])("a %s pulse (%s) is %s, %j", (state, skip_reason, tone, label) => {
  expect(pulseStatus({ state, skip_reason })).toMatchObject({ tone, label });
});

test("a state no map knows reads as stored, in words, neutral", () => {
  expect(statusOf("ticket", "under_audit")).toMatchObject({
    tone: "neutral",
    label: "Under audit",
  });
  // An inherited key is not a state.
  expect(statusOf("ticket", "toString").label).toBe("ToString");
});

test("a status badge shows the label beside a hidden icon, in its tone", () => {
  render(<StatusBadge entity="ticket" state="blocked" />);
  const badge = screen.getByText("Blocked");
  expect(badge.dataset.tone).toBe("danger");
  expect(badge.dataset.state).toBe("blocked");
  expect(badge.className).toContain("bg-danger-subtle");
  expect(badge.className).toContain("text-danger");
  const icon = badge.querySelector("svg");
  expect(icon?.getAttribute("aria-hidden")).toBe("true");
});

test("a badge takes a resolved status, and its own words", () => {
  render(
    <>
      <StatusBadge status={sessionStatus("exited", "error")} />
      <StatusBadge entity="conformance" state="pass" label="9 resume: pass" />
    </>,
  );
  expect(screen.getByText("Crashed").dataset.tone).toBe("danger");
  expect(screen.getByText("9 resume: pass").dataset.tone).toBe("success");
});

test("a status icon alone is hidden and carries the tone's text colour", () => {
  const { container } = render(<StatusIcon entity="ticket" state="done" />);
  const icon = container.querySelector("svg");
  expect(icon?.getAttribute("aria-hidden")).toBe("true");
  expect(icon?.getAttribute("class")).toContain("text-success");
});
