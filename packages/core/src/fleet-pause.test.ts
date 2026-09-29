import { expect, test } from "vitest";
import { fleetHoldOf, unlaunchedGateDeadline } from "./fleet-pause.js";

test("a missing fleet.paused is a config error, as it is to admission", () => {
  expect(fleetHoldOf(undefined)).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
});

test("paused reads 1 (or true) and has no resume; 0 (or false) resumed at its last write", () => {
  expect(fleetHoldOf({ value: 1, updated_at: 7 })).toEqual({
    ok: true,
    value: { paused: true, resumedAt: null },
  });
  expect(fleetHoldOf({ value: true, updated_at: 7 })).toEqual({
    ok: true,
    value: { paused: true, resumedAt: null },
  });
  expect(fleetHoldOf({ value: 0, updated_at: 7 })).toEqual({
    ok: true,
    value: { paused: false, resumedAt: 7 },
  });
  expect(fleetHoldOf({ value: false, updated_at: 9 })).toEqual({
    ok: true,
    value: { paused: false, resumedAt: 9 },
  });
});

test.each([2, "1", null, [1]])("fleet.paused %j is refused", (value) => {
  expect(fleetHoldOf({ value, updated_at: 1 })).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
});

test("an unlaunched gate's wall clock runs from the later of its start and the last resume", () => {
  const wallClockMs = 900;
  expect(
    unlaunchedGateDeadline({ startedAt: 1_000, wallClockMs, resumedAt: null }),
  ).toBe(1_900);
  // Resumed before it started (or never paused since): its own start.
  expect(
    unlaunchedGateDeadline({ startedAt: 1_000, wallClockMs, resumedAt: 400 }),
  ).toBe(1_900);
  // Opened while paused, resumed later: the whole wall clock from the resume.
  expect(
    unlaunchedGateDeadline({ startedAt: 1_000, wallClockMs, resumedAt: 5_000 }),
  ).toBe(5_900);
});
