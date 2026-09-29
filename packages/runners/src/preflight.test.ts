import { FakeClock } from "@bayon/core";
import { expect, test, vi } from "vitest";
import type {
  ModelPreflight,
  PreflightTarget,
  RunnerAdapter,
} from "./adapter.js";
import { PREFLIGHT_TIMEOUT_MS, preflightModel } from "./preflight.js";

const target: PreflightTarget = {
  model: "p/m-1",
  flags: {},
  env: {},
  executorKind: "local",
};

const withHook = (
  hook: RunnerAdapter["preflightModel"],
): Pick<RunnerAdapter, "id" | "preflightModel"> => ({
  id: "stub",
  ...(hook === undefined ? {} : { preflightModel: hook }),
});

test("an adapter without the hook is unchecked, and nothing is fetched", async () => {
  const fetch = vi.fn();
  const got = await preflightModel(withHook(undefined), target, {
    fetch,
    timeoutMs: 100,
    clock: new FakeClock(),
  });
  expect(got).toEqual({
    verdict: "unchecked",
    reason: "stub has no model pre-flight",
  });
  expect(fetch).not.toHaveBeenCalled();
});

test("the hook's verdict is passed through, with the injected fetch and a live signal", async () => {
  const fetch = vi.fn();
  const seen: { fetch?: unknown; aborted?: boolean } = {};
  const got = await preflightModel(
    withHook(async (_t, io) => {
      seen.fetch = io.fetch;
      seen.aborted = io.signal.aborted;
      return { verdict: "served" };
    }),
    target,
    { fetch, timeoutMs: 100, clock: new FakeClock() },
  );
  expect(got).toEqual({ verdict: "served" });
  expect(seen).toEqual({ fetch, aborted: false });
});

test("a hook that throws is unreachable, never a throw", async () => {
  const got = await preflightModel(
    withHook(async () => {
      throw new Error("boom");
    }),
    target,
    { timeoutMs: 100, clock: new FakeClock() },
  );
  expect(got).toEqual({
    verdict: "unreachable",
    reason: "stub's model pre-flight failed: boom",
  });
});

test("a hook that ignores its signal is cut off at the timeout, on the injected clock", async () => {
  const clock = new FakeClock();
  let signal: AbortSignal | undefined;
  const pending = preflightModel(
    withHook((_t, io) => {
      signal = io.signal;
      return new Promise<ModelPreflight>(() => undefined);
    }),
    target,
    { timeoutMs: 5_000, clock },
  );
  await clock.advance(4_999);
  expect(signal?.aborted).toBe(false);
  await clock.advance(1);
  expect(await pending).toEqual({
    verdict: "unreachable",
    reason: "stub's model pre-flight got no answer within 5000 ms",
  });
  expect(signal?.aborted).toBe(true);
});

test("the caller's abort ends it at once and reaches the hook's signal", async () => {
  const clock = new FakeClock();
  const stop = new AbortController();
  let signal: AbortSignal | undefined;
  const pending = preflightModel(
    withHook((_t, io) => {
      signal = io.signal;
      return new Promise<ModelPreflight>(() => undefined);
    }),
    target,
    { timeoutMs: 5_000, clock, signal: stop.signal },
  );
  stop.abort(new Error("stopped during spawn"));
  expect(await pending).toEqual({
    verdict: "unreachable",
    reason: "stub's model pre-flight was stopped",
  });
  expect(signal?.aborted).toBe(true);
});

test("an already-aborted caller signal never waits", async () => {
  const stop = new AbortController();
  stop.abort();
  const got = await preflightModel(
    withHook(() => new Promise<ModelPreflight>(() => undefined)),
    target,
    { clock: new FakeClock(), signal: stop.signal },
  );
  expect(got.verdict).toBe("unreachable");
});

test("the default bound is a few seconds", () => {
  expect(PREFLIGHT_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000);
  expect(PREFLIGHT_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
});
