import { describe, expect, test } from "vitest";
import {
  SYSTEM_CONTEXT_MAX,
  SystemHumanRequest,
  dedupeKey,
  dedupePrefix,
  excerpt,
  pairKey,
} from "./requests.js";

// System request keys: `<rule>:<subject>:<window>`, one per condition and
// window, and a prefix per (rule, subject).

const base = {
  rule: "circuit",
  subject: "T1",
  window: "1700000000000",
  question: "blocked?",
  context_md: "",
  options: ["unblock and retry"],
} as const;

describe("system request keys", () => {
  test("the key is the prefix plus the window", () => {
    expect(dedupePrefix("retry_storm", pairKey("fixture", "local"))).toBe(
      "retry_storm:fixture/local:",
    );
    expect(dedupeKey(base)).toBe("circuit:T1:1700000000000");
    expect(dedupeKey(base).startsWith(dedupePrefix("circuit", "T1"))).toBe(
      true,
    );
  });

  test("a subject is never a prefix of another subject's keys", () => {
    expect(dedupeKey({ ...base, subject: "T10" })).not.toMatch(
      new RegExp(`^${dedupePrefix("circuit", "T1")}`),
    );
  });

  test("key parts with a colon or whitespace are refused, and the context is capped", () => {
    expect(SystemHumanRequest.safeParse(base).success).toBe(true);
    expect(
      SystemHumanRequest.safeParse({ ...base, subject: "a:b" }).success,
    ).toBe(false);
    expect(
      SystemHumanRequest.safeParse({ ...base, window: "a b" }).success,
    ).toBe(false);
    expect(
      SystemHumanRequest.safeParse({
        ...base,
        context_md: "x".repeat(SYSTEM_CONTEXT_MAX + 1),
      }).success,
    ).toBe(false);
  });

  test("excerpt cuts and marks", () => {
    expect(excerpt("short", 10)).toBe("short");
    expect(excerpt("0123456789abc", 10)).toBe("012345678…");
    expect(excerpt("0123456789abc", 10)).toHaveLength(10);
  });
});
