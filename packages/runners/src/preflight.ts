// The model pre-flight, runner-neutral: asks an adapter's optional `preflightModel`
// hook whether its provider serves a model, bounded by a timeout, never throwing. Callers decide
// what a doubt means: conformance fails closed, a spawn fails open (the design).
import { systemClock, type Clock } from "@bayon/core";
import type {
  Fetch,
  ModelPreflight,
  PreflightTarget,
  RunnerAdapter,
} from "./adapter.js";

/** How long a pre-flight may take: one small GET to a provider, so a few seconds. */
export const PREFLIGHT_TIMEOUT_MS = 5_000;

const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export async function preflightModel(
  adapter: Pick<RunnerAdapter, "id" | "preflightModel">,
  target: PreflightTarget,
  o: {
    readonly fetch?: Fetch;
    readonly timeoutMs?: number;
    /** The time the bound is kept in; tests inject a FakeClock. */
    readonly clock?: Clock;
    /** The caller's own abort (a stop during spawn): ends the pre-flight at once. */
    readonly signal?: AbortSignal;
  } = {},
): Promise<ModelPreflight> {
  const hook = adapter.preflightModel;
  if (hook === undefined) {
    return {
      verdict: "unchecked",
      reason: `${adapter.id} has no model pre-flight`,
    };
  }
  const timeoutMs = o.timeoutMs ?? PREFLIGHT_TIMEOUT_MS;
  const clock = o.clock ?? systemClock;
  // The hook's signal: aborted by the bound, by the caller's own signal, or once it has answered.
  const abort = new AbortController();
  const outer = o.signal;
  const onOuter = (): void => abort.abort(outer?.reason);
  if (outer?.aborted === true) onOuter();
  else outer?.addEventListener("abort", onOuter, { once: true });
  const late = clock.after(timeoutMs, abort.signal).then(
    (): ModelPreflight => ({
      verdict: "unreachable",
      reason: `${adapter.id}'s model pre-flight got no answer within ${timeoutMs} ms`,
    }),
    (): ModelPreflight => ({
      verdict: "unreachable",
      reason: `${adapter.id}'s model pre-flight was stopped`,
    }),
  );
  const asked = hook
    .call(adapter, target, {
      fetch: o.fetch ?? globalThis.fetch,
      signal: abort.signal,
    })
    .catch((e: unknown): ModelPreflight => ({
      verdict: "unreachable",
      reason: `${adapter.id}'s model pre-flight failed: ${messageOf(e)}`,
    }));
  try {
    return await Promise.race([asked, late]);
  } finally {
    outer?.removeEventListener("abort", onOuter);
    abort.abort(); // disarms the bound and ends whatever the hook still has open
  }
}
