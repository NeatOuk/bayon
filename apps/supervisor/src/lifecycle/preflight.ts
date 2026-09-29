// The spawn's model pre-flight (§9.1): after the home step, whose env resolves the
// provider's address, and before the runner starts, whether the provider serves the session's
// model. A definite "not served" fails the spawn in seconds, naming the model and the host. A check
// that got no answer fails open: logged, and the spawn goes on — an unanswered list call is no
// evidence the model is gone, the runner's own call stays the authority, and its failure is reported
// with its class. An adapter without the hook is unchecked (the design).
import { err, ok, type Clock, type Result } from "@bayon/core";
import type { ExecutorKind } from "@bayon/executors";
import {
  preflightModel,
  type Fetch,
  type RunnerAdapter,
  type SpawnSpec,
} from "@bayon/runners";
import type { Log } from "./context.js";
import { frmError } from "./errors.js";

export async function preflightStep(
  o: {
    readonly log: Log;
    readonly sessionId: string;
    readonly adapter: RunnerAdapter;
    readonly executorKind: ExecutorKind;
    /** The bound's time: the supervisor's clock. */
    readonly clock: Clock;
    /** The spawn pipeline's abort: a stop ends the pre-flight at once, not after its bound. */
    readonly signal: AbortSignal;
    /** Tests only: a stand-in fetch; the default is the global one. */
    readonly fetch?: Fetch;
    readonly timeoutMs?: number;
  },
  spec: SpawnSpec,
): Promise<Result<void>> {
  const verdict = await preflightModel(
    o.adapter,
    {
      model: spec.model,
      ...(spec.modelSettings === undefined
        ? {}
        : { modelSettings: spec.modelSettings }),
      flags: spec.flags,
      env: spec.env,
      executorKind: o.executorKind,
    },
    {
      clock: o.clock,
      signal: o.signal,
      ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
      ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
    },
  );
  switch (verdict.verdict) {
    case "served":
    case "unchecked":
      return ok(undefined);
    case "not_served":
      return err(frmError("runner_error", verdict.reason));
    case "unreachable":
      // Stopped: the pipeline's own abort check reports it; there is nothing to warn about.
      if (o.signal.aborted) return ok(undefined);
      o.log.warn(
        { sessionId: o.sessionId, model: spec.model, reason: verdict.reason },
        "model pre-flight got no answer; spawning anyway",
      );
      return ok(undefined);
  }
}
