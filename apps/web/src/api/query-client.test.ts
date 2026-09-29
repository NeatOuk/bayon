import { describe, expect, test } from "vitest";
import { ApiRequestError } from "@/api/http";
import {
  MAX_TRIES,
  createQueryClient,
  retryUnlessFinal,
} from "@/api/query-client";

const apiError = (status: number, retryable: boolean) =>
  new ApiRequestError(status, {
    class: retryable ? "internal" : "validation",
    message: "m",
    retryable,
  });

const retriesAt = (error: Error): boolean[] =>
  [0, 1, 2, 3, 4].map((failures) => retryUnlessFinal(failures, error));

describe("retryUnlessFinal", () => {
  test("an error the server (or the parse) calls final is never retried", () => {
    // A body the schema rejects: a 200, `validation`, not retryable (stale 304 body).
    expect(retryUnlessFinal(0, apiError(200, false))).toBe(false);
    expect(retriesAt(apiError(404, false))).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  test("a retryable ApiRequestError is retried until the third failure", () => {
    expect(retriesAt(apiError(502, true))).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  test("any other error (a network failure) is retried until the third failure", () => {
    expect(retriesAt(new TypeError("Failed to fetch"))).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  test("three tries at most, as TanStack's default", () => {
    expect(MAX_TRIES).toBe(3);
  });
});

test("the app's QueryClient retries every query with it", () => {
  expect(createQueryClient().getDefaultOptions().queries?.retry).toBe(
    retryUnlessFinal,
  );
});
