import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "@bayon/core";
import { afterAll, describe, expect, test } from "vitest";
import { HOME_LOCK, claimHome } from "./home.js";
import { capToRecord, unparsedEvent } from "./record-events.js";
import { approximateTokens } from "./tokens.js";
import { settlesWithin } from "./wait.js";

const root = mkdtempSync(join(tmpdir(), "frm-home-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("claimHome", () => {
  test("creates a private home and locks it to one session", async () => {
    const home = join(root, "a", "home");
    expect(await claimHome(home, "s1")).toEqual({
      ok: true,
      value: { files: [join(home, HOME_LOCK)] },
    });
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect((await claimHome(home, "s1")).ok).toBe(true);
    expect(await claimHome(home, "s2")).toMatchObject({
      ok: false,
      error: { class: "conflict", message: expect.stringContaining("s1") },
    });
  });

  test("a home that cannot be created is an internal error", async () => {
    writeFileSync(join(root, "file"), "");
    expect(await claimHome(join(root, "file", "home"), "s1")).toMatchObject({
      ok: false,
      error: { class: "internal" },
    });
  });
});

describe("settlesWithin", () => {
  test("true when the promise settles first, false when the time runs out", async () => {
    const clock = new FakeClock();
    expect(await settlesWithin(Promise.resolve(), clock, 10)).toBe(true);
    expect(await settlesWithin(Promise.reject(new Error("x")), clock, 10)).toBe(
      true,
    );
    const waiting = settlesWithin(new Promise(() => {}), clock, 10);
    await clock.advance(10);
    expect(await waiting).toBe(false);
  });
});

test("approximateTokens is 4 characters a token plus 15 %", () => {
  expect(approximateTokens("")).toBe(0);
  expect(approximateTokens("abcd")).toBe(2);
  expect(approximateTokens("x".repeat(400))).toBe(115);
});

test("unparsedEvent keeps the line verbatim", () => {
  expect(unparsedEvent("{x", "partial line", 5)).toEqual({
    kind: "runner_native",
    ts: 5,
    runner_type: "unparsed",
    payload: { raw: "{x", parse_error: "partial line" },
  });
});

test("capToRecord collapses a record that would yield more events than it has bytes", () => {
  const bytes = new TextEncoder().encode("{}");
  const many = [0, 1, 2].map(() => ({
    kind: "assistant_text" as const,
    ts: 1,
    runner_type: "r",
    text: "",
    payload: {},
  }));
  expect(capToRecord(many, bytes, 1)).toEqual([
    {
      kind: "runner_native",
      ts: 1,
      ordinal: 0,
      runner_type: "unparsed",
      payload: { raw: "{}", issues: ["3 events from a 2-byte record"] },
    },
  ]);
  expect(capToRecord(many.slice(0, 2), bytes, 1).map((e) => e.ordinal)).toEqual(
    [0, 1],
  );
});
