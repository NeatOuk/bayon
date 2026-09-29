import { describe, expect, test } from "vitest";
import {
  HEALTH_VERSION_CHECK,
  VERSION_TEST_ID,
  clipDetail,
  observationDrift,
  pinnedHealthVersion,
  pinnedImageId,
} from "./certification-pins.js";
import { MAX_DETAIL_CHARS, type ConformanceResult } from "./conformance.js";

/** Only `tests` and `executor` matter here; the rest is certify()'s business. */
const resultWith = (
  checks: ConformanceResult["tests"][number]["checks"],
  id = VERSION_TEST_ID,
  image_id: string | null = null,
): ConformanceResult =>
  ({
    executor: { id: "ctr-1", kind: "container", image_id },
    tests: [
      {
        id,
        name: "version",
        status: "pass",
        attempts: 1,
        duration_ms: 1,
        fallback: null,
        checks,
      },
    ],
  }) as unknown as ConformanceResult;

const health = (detail: string | null, ok = true) => ({
  name: HEALTH_VERSION_CHECK,
  ok,
  detail,
});
const OBSERVED = {
  runner_id: "r",
  executor_id: "ctr-1",
  image_id: null,
} as const;
const SHA_A = `sha256:${"a".repeat(64)}`;
const SHA_B = `sha256:${"b".repeat(64)}`;

describe("pinnedHealthVersion", () => {
  test("test 1's passing health check pins its detail", () => {
    expect(pinnedHealthVersion(resultWith([health("2.1.3 (CLI)")]))).toBe(
      "2.1.3 (CLI)",
    );
  });

  test.each([
    ["a failed health check", [health("spawn failed", false)]],
    ["no detail", [health(null)]],
    ["a blank detail", [health("  ")]],
    ["no health check", [{ name: "version_captured", ok: true, detail: "1" }]],
  ])("%s pins nothing", (_, checks) => {
    expect(pinnedHealthVersion(resultWith(checks))).toBeNull();
  });

  test("another test's check of the same name pins nothing", () => {
    expect(pinnedHealthVersion(resultWith([health("1")], 2))).toBeNull();
  });
});

describe("observationDrift", () => {
  test("the same version holds, whitespace aside", () => {
    const r = resultWith([health("2.1.3")]);
    expect(
      observationDrift(r, { ...OBSERVED, health_version: "2.1.3\n" }),
    ).toBeNull();
  });

  test("a changed version lapses the pair, saying what changed and where", () => {
    expect(
      observationDrift(resultWith([health("2.1.3")]), {
        ...OBSERVED,
        health_version: "2.2.0",
      }),
    ).toBe("health_version 2.1.3 → 2.2.0 on ctr-1");
  });

  test("a version longer than a check detail compares as the suite clipped it", () => {
    const long = "v".repeat(MAX_DETAIL_CHARS + 20);
    const r = resultWith([health(clipDetail(long))]);
    expect(
      observationDrift(r, { ...OBSERVED, health_version: long }),
    ).toBeNull();
    expect(
      observationDrift(r, { ...OBSERVED, health_version: `${long}x` }),
    ).toBeNull();
    expect(
      observationDrift(r, { ...OBSERVED, health_version: `x${long}` }),
    ).toMatch(/^health_version /);
  });

  test("nothing pinned: nothing to compare", () => {
    expect(
      observationDrift(resultWith([health("boom", false)]), {
        ...OBSERVED,
        health_version: "9",
      }),
    ).toBeNull();
  });

  test("a version the observation could not read is not drift", () => {
    expect(
      observationDrift(resultWith([health("2.1.3")]), {
        ...OBSERVED,
        health_version: null,
      }),
    ).toBeNull();
  });
});

describe("pinnedImageId", () => {
  test.each([
    ["an image id", SHA_A, SHA_A],
    ["a padded one, trimmed", ` ${SHA_A}\n`, SHA_A],
    [
      "none pinned (a local executor, or a result stored before this)",
      null,
      null,
    ],
    ["a blank one", "   ", null],
  ])("%s", (_, stored, expected) => {
    expect(pinnedImageId(resultWith([], VERSION_TEST_ID, stored))).toBe(
      expected,
    );
  });
});

describe("observationDrift on the image", () => {
  test("a rebuild under the same tag lapses the pair", () => {
    expect(
      observationDrift(resultWith([], VERSION_TEST_ID, SHA_A), {
        ...OBSERVED,
        health_version: null,
        image_id: SHA_B,
      }),
    ).toBe(`image_id ${SHA_A} → ${SHA_B} on ctr-1`);
  });

  test("the same image holds", () => {
    expect(
      observationDrift(resultWith([], VERSION_TEST_ID, SHA_A), {
        ...OBSERVED,
        health_version: null,
        image_id: SHA_A,
      }),
    ).toBeNull();
  });

  test("an image the observation could not read is not drift", () => {
    expect(
      observationDrift(resultWith([], VERSION_TEST_ID, SHA_A), {
        ...OBSERVED,
        health_version: null,
        image_id: null,
      }),
    ).toBeNull();
  });

  test("a result that pinned no image is not decertified for one", () => {
    expect(
      observationDrift(resultWith([], VERSION_TEST_ID, null), {
        ...OBSERVED,
        health_version: null,
        image_id: SHA_B,
      }),
    ).toBeNull();
  });

  test("the version is judged first, then the image", () => {
    const r = resultWith([health("2.1.3")], VERSION_TEST_ID, SHA_A);
    expect(
      observationDrift(r, {
        ...OBSERVED,
        health_version: "2.2.0",
        image_id: SHA_B,
      }),
    ).toBe("health_version 2.1.3 → 2.2.0 on ctr-1");
    expect(
      observationDrift(r, {
        ...OBSERVED,
        health_version: "2.1.3",
        image_id: SHA_B,
      }),
    ).toBe(`image_id ${SHA_A} → ${SHA_B} on ctr-1`);
  });
});

test("clipDetail cuts at MAX_DETAIL_CHARS with an ellipsis", () => {
  expect(clipDetail("short")).toBe("short");
  const cut = clipDetail("x".repeat(MAX_DETAIL_CHARS + 1));
  expect(cut).toHaveLength(MAX_DETAIL_CHARS);
  expect(cut.endsWith("…")).toBe(true);
});
