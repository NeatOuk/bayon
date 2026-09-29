import { describe, expect, test } from "vitest";
import {
  ContextFrame,
  ContextTotals,
  MAX_FRAME_DIGESTS,
  foldContextFrame,
  parseContextFrame,
} from "./frame.js";

const DIGEST = "a".repeat(64);
const FRAME: ContextFrame = {
  type: "frm.ctx",
  v: 1,
  ruleset: "ctx1",
  blocks: 4,
  compressed: 2,
  failed: 1,
  chars_in: 90_000,
  chars_out: 20_000,
  digests: [DIGEST, "0123456789abcdef".repeat(4)],
  ms: 3,
};

describe("ContextFrame", () => {
  test("a frame parses", () => {
    expect(parseContextFrame(FRAME)).toEqual({ ok: true, value: FRAME });
  });

  test.each([
    ["another type", { ...FRAME, type: "frm.other" }],
    ["another version", { ...FRAME, v: 2 }],
    ["an unknown key", { ...FRAME, extra: 1 }],
    ["a bad ruleset", { ...FRAME, ruleset: "CTX 1" }],
    ["a negative count", { ...FRAME, blocks: -1 }],
    ["a fractional count", { ...FRAME, chars_in: 1.5 }],
    ["an upper-case digest", { ...FRAME, digests: ["A".repeat(64)] }],
    ["a short digest", { ...FRAME, digests: ["ab"] }],
    [
      "too many digests",
      {
        ...FRAME,
        digests: Array.from({ length: MAX_FRAME_DIGESTS + 1 }, () => DIGEST),
      },
    ],
    ["more compressed and failed than blocks", { ...FRAME, compressed: 4 }],
    ["no frame at all", "frm.ctx"],
  ])("%s is refused as validation", (_, input) => {
    const r = parseContextFrame(input);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.class).toBe("validation");
    expect(r.error.retryable).toBe(false);
    expect(r.error.message).toMatch(/^not a context frame: /);
  });

  test("64 digests are allowed", () => {
    const digests = Array.from({ length: MAX_FRAME_DIGESTS }, () => DIGEST);
    expect(ContextFrame.safeParse({ ...FRAME, digests }).success).toBe(true);
  });
});

describe("foldContextFrame", () => {
  test("null starts the totals at one call", () => {
    expect(foldContextFrame(null, FRAME)).toEqual({
      ruleset: "ctx1",
      calls: 1,
      blocks: 4,
      compressed: 2,
      failed: 1,
      chars_in: 90_000,
      chars_out: 20_000,
    });
  });

  test("each frame adds to the totals, which keep the first ruleset", () => {
    const once = foldContextFrame(null, FRAME);
    const twice = foldContextFrame(once, {
      ...FRAME,
      ruleset: "ctx2",
      blocks: 1,
      compressed: 1,
      failed: 0,
      chars_in: 10,
      chars_out: 5,
    });
    expect(twice).toEqual({
      ruleset: "ctx1",
      calls: 2,
      blocks: 5,
      compressed: 3,
      failed: 1,
      chars_in: 90_010,
      chars_out: 20_005,
    });
    expect(once.calls).toBe(1); // the input is never changed
    expect(ContextTotals.parse(twice)).toEqual(twice);
  });
});
