import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import { useIdempotencyKey } from "@/api/use-idempotency-key";

test("the same operation keeps one key, however many times it is read", () => {
  const { result } = renderHook(() => useIdempotencyKey());
  const first = result.current.current();
  // The retry of an ambiguous failure: the server may already hold the command, so this must carry
  // the same key rather than ask for a second one.
  expect(result.current.current()).toBe(first);
  expect(result.current.current()).toBe(first);
});

test("a key survives a re-render, which is where a per-render mint would leak", () => {
  const { result, rerender } = renderHook(() => useIdempotencyKey());
  const first = result.current.current();
  rerender();
  expect(result.current.current()).toBe(first);
});

test("settling ends the operation, so the next one is a new one with its own key", () => {
  const { result } = renderHook(() => useIdempotencyKey());
  const first = result.current.current();
  act(() => {
    result.current.settle();
  });
  const second = result.current.current();
  expect(second).not.toBe(first);
  expect(second).toBe(result.current.current());
});
