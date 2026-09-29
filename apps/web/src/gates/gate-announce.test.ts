import { expect, test } from "vitest";
import { gateChanges, gateLine, lineSignature } from "@/gates/gate-announce";

const T812 = { id: "ticket-812", key: "FRM-812" };

const running = {
  kind: "code_review",
  repo_id: null,
  attempt: 1,
  state: "running",
  reason: null,
};

test("a line names the gate, its repo and ticket when given, and its attempt and state", () => {
  expect(gateLine(running, T812)).toEqual({
    key: "ticket-812|code_review|",
    subject: "code_review on FRM-812",
    state: "#1 running",
  });
  expect(
    gateLine({
      ...running,
      repo_id: "api",
      state: "failed",
      reason: "base_drift",
    }),
  ).toEqual({
    key: "|code_review|api",
    subject: "code_review · api",
    state: "#1 failed (base drift)",
  });
});

test("nothing changed announces nothing, and the signatures match", () => {
  const lines = [gateLine(running, T812)];
  expect(gateChanges(lines, [gateLine(running, T812)])).toBe("");
  expect(lineSignature(lines)).toBe(lineSignature([gateLine(running, T812)]));
});

test("a decided gate, a rerun in the same slot, a new gate and a gone one each read once", () => {
  const plan = { ...running, kind: "plan_review" };
  const before = [gateLine(running, T812), gateLine(plan, T812)];
  const after = [
    gateLine({ ...running, attempt: 2 }, T812),
    gateLine(
      { ...running, kind: "ce_review", state: "failed", reason: "timeout" },
      T812,
    ),
  ];
  expect(gateChanges(before, after)).toBe(
    "code_review on FRM-812: #2 running. ce_review on FRM-812: #1 failed (timeout). plan_review on FRM-812: left the list.",
  );
  expect(lineSignature(before)).not.toBe(lineSignature(after));
});
