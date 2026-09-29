import { expect, test } from "vitest";
import { ErrorClass, FrmError, err, ok } from "./errors.js";

test("error classes are a closed enum", () => {
  expect(ErrorClass.options).toEqual([
    "db_busy",
    "validation",
    "not_found",
    "conflict",
    "law_refused",
    "admission_refused",
    "over_budget",
    "spawn_failed",
    "runner_exited_without_terminal",
    "runner_error",
    "timeout",
    "interrupted",
    "supervisor_restart",
    "unknown_command",
    "internal",
  ]);
  expect(
    FrmError.safeParse({ class: "oops", message: "m", retryable: false })
      .success,
  ).toBe(false);
});

test("an FrmError carries class, message, retryable and an optional cause", () => {
  const error: FrmError = {
    class: "db_busy",
    message: "database is locked",
    retryable: true,
    cause: new Error("SQLITE_BUSY"),
  };
  expect(FrmError.parse(error)).toEqual(error);
  expect(
    FrmError.parse({ class: "internal", message: "x", retryable: false }),
  ).toEqual({ class: "internal", message: "x", retryable: false });
});

test("ok and err build the two Result branches", () => {
  expect(ok(3)).toEqual({ ok: true, value: 3 });
  const error: FrmError = { class: "timeout", message: "t", retryable: true };
  expect(err(error)).toEqual({ ok: false, error });
});
