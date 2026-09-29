import { expect, test } from "vitest";
import { assertJobRunners } from "./boot.js";

// Design an earlier change Q4: the daemon's own job runners skip `uncertified` only, and none may be a
// registry runner, whose certification admission must always check.

test("job runners outside the registry pass", () => {
  expect(assertJobRunners(new Set(["job-export"]), ["reg-a", "reg-b"])).toEqual(
    {
      ok: true,
      value: undefined,
    },
  );
  expect(assertJobRunners(new Set(), ["reg-a"])).toMatchObject({ ok: true });
});

test("a job runner that is a registry runner fails boot, named", () => {
  expect(
    assertJobRunners(new Set(["job-export", "reg-b"]), ["reg-a", "reg-b"]),
  ).toMatchObject({
    ok: false,
    error: {
      class: "validation",
      message: expect.stringContaining("reg-b"),
    },
  });
});
