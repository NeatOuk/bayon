import { describe, expect, test } from "vitest";
import { compareVersions, RELEASE_VERSION } from "./version-compare.js";

describe("RELEASE_VERSION", () => {
  test("accepts a release and a short prerelease", () => {
    expect(RELEASE_VERSION.safeParse("0.3.290").success).toBe(true);
    expect(RELEASE_VERSION.safeParse("2.1.10").success).toBe(true);
    expect(RELEASE_VERSION.safeParse("1.0.0-beta.1").success).toBe(true);
  });

  test("refuses garbage, an overlong string and a prerelease over 32 chars", () => {
    expect(RELEASE_VERSION.safeParse("latest").success).toBe(false);
    expect(RELEASE_VERSION.safeParse("1.2").success).toBe(false);
    expect(RELEASE_VERSION.safeParse("1.2.3; rm -rf").success).toBe(false);
    expect(RELEASE_VERSION.safeParse(`1.2.3-${"a".repeat(33)}`).success).toBe(
      false,
    );
    expect(RELEASE_VERSION.safeParse(`1.2.${"3".repeat(64)}`).success).toBe(
      false,
    );
  });
});

describe("compareVersions", () => {
  test("compares numerically, not lexically", () => {
    expect(compareVersions("0.3.290", "0.3.283")).toBeGreaterThan(0);
    expect(compareVersions("2.1.10", "2.1.9")).toBeGreaterThan(0);
    expect(compareVersions("1.9.0", "1.10.0")).toBeLessThan(0);
  });

  test("a release beats its own prerelease", () => {
    expect(compareVersions("1.2.3", "1.2.3-beta.1")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3-beta.1", "1.2.3")).toBeLessThan(0);
  });

  test("equal versions compare to zero", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3-rc.1", "1.2.3-rc.1")).toBe(0);
  });

  test("garbage on either side compares to zero, never newer", () => {
    expect(compareVersions("not-a-version", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3", "not-a-version")).toBe(0);
  });

  test("prerelease identifiers compare per semver §11", () => {
    // Numeric identifiers compare numerically, not lexically.
    expect(compareVersions("1.0.0-beta.9", "1.0.0-beta.10")).toBeLessThan(0);
    // Alphanumeric identifiers compare lexically (ASCII).
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
    // A prerelease is always lower than the release it precedes.
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    // A numeric identifier sorts below an alphanumeric one at the same position.
    expect(compareVersions("1.0.0-1", "1.0.0-a")).toBeLessThan(0);
  });
});
