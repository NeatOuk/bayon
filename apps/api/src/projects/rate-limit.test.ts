import { FakeClock } from "@bayon/core";
import { expect, test } from "vitest";
import { RATE_LIMITED, rateLimit } from "./rate-limit.js";

// The per-bearer limit on the routes that reach a remote (H1).

test("ten calls a minute per bearer; the eleventh waits for the window to move", async () => {
  const clock = new FakeClock(1_700_000_000_000);
  const limit = rateLimit(clock);
  for (let i = 0; i < 10; i += 1) expect(limit.take("Bearer a")).toBe(true);
  expect(limit.take("Bearer a")).toBe(false);
  // Another bearer has its own count.
  expect(limit.take("Bearer b")).toBe(true);
  await clock.advance(60_001);
  expect(limit.take("Bearer a")).toBe(true);
});

test("the refusal is plain words, retryable, and answered 429", () => {
  expect(RATE_LIMITED).toMatchObject({
    class: "admission_refused",
    retryable: true,
  });
  expect(RATE_LIMITED.message).toContain("wait a moment");
});
