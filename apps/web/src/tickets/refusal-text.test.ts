import { RefusalReason } from "@bayon/core";
import { expect, test } from "vitest";
import { ApiRequestError } from "@/api/http";
import {
  PLAIN_REFUSAL,
  plainError,
  plainRefusal,
  technicalRefusal,
} from "@/tickets/refusal-text";

// "refused by start_spike (no_session): no live session holds ticket 01M3…" became one
// plain sentence; the rule, code and detail stay for the title.

test("every refusal reason reads as a sentence, with no code or id in it", () => {
  for (const reason of RefusalReason.options) {
    const text = PLAIN_REFUSAL[reason];
    expect(text).toMatch(/^[A-Z].*\.$/);
    expect(text).not.toMatch(/_/);
  }
});

test("the no_session refusal the walkthrough met", () => {
  const option = {
    rule: "start_spike",
    reason: "no_session" as const,
    detail: "no live session holds ticket 01M3P7M0NGJ755SBTNXHZ98CBX",
  };
  expect(plainRefusal(option)).toBe(
    "Nobody is working on it yet: start work first.",
  );
  expect(technicalRefusal(option)).toBe(
    "start_spike (no_session): no live session holds ticket 01M3P7M0NGJ755SBTNXHZ98CBX",
  );
});

test("a refusal with no reason reads plainly and keeps its rule for the title; with no detail the title is the rule and code", () => {
  expect(plainRefusal({ rule: "prioritize" })).toBe(
    "This move isn't allowed right now.",
  );
  expect(technicalRefusal({ rule: "prioritize" })).toBe("prioritize");
  expect(
    technicalRefusal({ rule: "block", reason: "cross_ticket_write" }),
  ).toBe("block (cross_ticket_write)");
});

test("an error: a law's 422, a staffing refusal without its code, anything else as it is", () => {
  const api = (message: string, extra: object = {}) =>
    new ApiRequestError(409, {
      class: "conflict",
      message,
      retryable: false,
      ...extra,
    });
  expect(
    plainError(
      api("start_spike: x", { rule: "start_spike", reason: "no_session" }),
    ),
  ).toBe("Nobody is working on it yet: start work first.");
  expect(plainError(api("over_budget: today's spend reached the cap."))).toBe(
    "Today's spend reached the cap.",
  );
  expect(plainError(api("stale version"))).toBe("stale version");
  expect(plainError(api("elsewhere: not a staffing code"))).toBe(
    "elsewhere: not a staffing code",
  );
  expect(plainError(new Error("Failed to fetch"))).toBe("Failed to fetch");
});
