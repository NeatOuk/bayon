import { describe, expect, test } from "vitest";
import type { FrmError } from "./errors.js";
import {
  DEFAULT_RUN_CLASSES,
  RunClass,
  loadRunClasses,
} from "./run-classes.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

// §8.4 as amended: `build` and `build_complex` are separate rows, 0 means n/a; the run-class
// ceilings migration raised spike, build, build_complex, review and fix for real sessions.
const AMENDED_8_4 = [
  ["pulse", 6_000, 12, 40, 15 * MIN, 0.5, 10, 70, "cheap"],
  ["spike", 150_000, 100, 300, 45 * MIN, 5, 75, 70, "standard"],
  ["build", 300_000, 300, 1_200, 2 * HOUR, 15, 225, 70, "standard"],
  ["build_complex", 600_000, 500, 2_000, 4 * HOUR, 30, 375, 70, "complex"],
  ["review", 150_000, 60, 200, 30 * MIN, 5, 0, 0, "standard"],
  ["fix", 150_000, 150, 500, HOUR, 5, 112, 70, "standard"],
  ["qa", 0, 0, 0, 20 * MIN, 0.2, 0, 0, "cheap"],
  ["probe", 0, 0, 0, 30_000, 0, 0, 0, "cheap"],
] as const;

const byName = (classes: readonly RunClass[]) =>
  new Map(classes.map((c) => [c.name, c]));
const preset = (name: string): RunClass =>
  RunClass.parse(DEFAULT_RUN_CLASSES.find((c) => c.name === name));

describe("DEFAULT_RUN_CLASSES", () => {
  test("are the amended §8.4 table", () => {
    expect(
      DEFAULT_RUN_CLASSES.map((c) => [
        c.name,
        c.context_tokens_cap,
        c.max_turns,
        c.max_tool_calls,
        c.wall_clock_ms,
        c.cost_cap_usd,
        c.handoff_at_turns,
        c.handoff_at_context_pct,
        c.default_tier,
      ]),
    ).toEqual(AMENDED_8_4);
  });

  test("each default is a valid run class", () => {
    for (const runClass of DEFAULT_RUN_CLASSES) {
      expect(RunClass.parse(runClass)).toEqual(runClass);
    }
  });
});

describe("RunClass", () => {
  const build = preset("build");

  test.each([
    [
      "a zero wall clock (no terminal inside it is a failure, §5.2)",
      { wall_clock_ms: 0 },
    ],
    ["a negative cap", { max_turns: -1 }],
    ["a fractional count", { max_tool_calls: 1.5 }],
    ["a context percentage over 100", { handoff_at_context_pct: 101 }],
    ["an unknown tier", { default_tier: "premium" }],
    ["an empty name", { name: "" }],
  ])("rejects %s", (_name, patch) => {
    expect(RunClass.safeParse({ ...build, ...patch }).success).toBe(false);
  });
});

describe("loadRunClasses", () => {
  test("falls back to the defaults when the table is empty", async () => {
    expect(await loadRunClasses(async () => [])).toEqual({
      ok: true,
      value: byName(DEFAULT_RUN_CLASSES),
    });
  });

  test("DB rows override defaults by name and add new classes", async () => {
    const tunedPulse = { ...preset("pulse"), max_turns: 8 };
    const nightly = { ...preset("pulse"), name: "nightly", cost_cap_usd: 1 };
    const result = await loadRunClasses(async () => [tunedPulse, nightly]);
    expect(result).toEqual({
      ok: true,
      value: byName([...DEFAULT_RUN_CLASSES, tunedPulse, nightly]),
    });
    expect(result.ok && result.value.get("pulse")?.max_turns).toBe(8);
  });

  test("an invalid row is a validation error, not a silent default", async () => {
    const result = await loadRunClasses(async () => [
      { ...preset("pulse"), max_turns: "twelve" },
    ]);
    expect(result).toEqual({
      ok: false,
      error: {
        class: "validation",
        message: expect.stringContaining("max_turns"),
        retryable: false,
      },
    });
  });

  test("a reader failure that is already an FrmError is passed through", async () => {
    const busy: FrmError = {
      class: "db_busy",
      message: "database is locked",
      retryable: true,
    };
    expect(
      await loadRunClasses(async () => {
        throw busy;
      }),
    ).toEqual({ ok: false, error: busy });
  });

  test("any other reader failure is internal, with the cause kept", async () => {
    const cause = new Error("disk gone");
    expect(
      await loadRunClasses(async () => {
        throw cause;
      }),
    ).toEqual({
      ok: false,
      error: {
        class: "internal",
        message: "reading run_classes failed",
        retryable: false,
        cause,
      },
    });
  });
});
