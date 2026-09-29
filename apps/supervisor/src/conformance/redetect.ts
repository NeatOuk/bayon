// Runner versions re-detected on each health pass (§15; "Amendments — M4": a changed version makes
// the runner uncertified). For every runner holding a live certification on a healthy
// executor, the adapter's own health call is asked again: runner-neutral, and the very call test 1
// pinned the certified version from. A different answer decertifies that pair through
// decertifyStale, which writes only what changed, so an unchanged version writes nothing and a
// decertified pair is never written again. A runner with no live pair on the executor has nothing
// pinned there to compare with, so it is not asked. On an executor that places its sessions the
// image's identity is re-read in the version's place.
import {
  err,
  type Clock,
  type PairObservation,
  type Result,
  type RunnerReading,
} from "@bayon/core";
import { listRunnerCertifications, type Db } from "@bayon/db";
import type { Executor } from "@bayon/executors";
import type { RunnerAdapter } from "@bayon/runners";
import { settlesWithin } from "../lifecycle/async-util.js";
import type { Log } from "../lifecycle/context.js";
import { asFrmError } from "../lifecycle/errors.js";
import { decertifyStale, type KitOf } from "./decertify.js";

export interface RedetectDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly log: Log;
  readonly adapters: ReadonlyMap<string, RunnerAdapter>;
  /** Bounds each adapter's health call (executor.health_timeout_ms). */
  readonly timeoutMs: number;
  /** Conformance kits by runner id; default the registry's. */
  readonly kits?: KitOf;
}

/**
 * Re-detects each certified runner's version on `executor` and decertifies the pairs whose version
 * changed; returns the readings for health_detail. `previous` (the last check's readings) keeps a
 * failing detection from being logged on every pass.
 */
export async function redetectRunners(
  d: RedetectDeps,
  executor: Executor,
  previous: Readonly<Record<string, RunnerReading>>,
): Promise<Readonly<Record<string, RunnerReading>>> {
  const certs = await listRunnerCertifications(d.db);
  if (!certs.ok) {
    d.log.error(
      { executor: executor.id, error: certs.error },
      "cannot list certifications to re-detect runner versions",
    );
    return {};
  }
  // One runner may hold a live certificate per model here: it is asked once.
  const live = [
    ...new Map(
      certs.value.flatMap((c) => {
        const adapter = d.adapters.get(c.runner_id);
        return c.executor_id === executor.id &&
          c.decertified_at === null &&
          adapter !== undefined
          ? [[adapter.id, adapter] as const]
          : [];
      }),
    ).values(),
  ];
  if (live.length === 0) return {};
  // On an executor that places sessions (a container), test 1 read the version inside a session of
  // its own; asking outside one would compare another binary, and opening a session
  // every pass is not a health check. There the image's identity is what is re-read instead
  //: the certified runner lives inside that image, so a rebuild is a new subject. Such
  // an executor gets no readings — health_detail has nothing to say about a version nobody asked
  // for — but its pairs are still judged.
  const placed = executor.placeSession !== undefined;
  const image_id = placed ? await imageIdentity(d, executor) : null;
  const readings = placed
    ? []
    : await Promise.all(
        live.map(async (a) => [a.id, await detect(d, a, executor)] as const),
      );
  for (const [runner, r] of readings) {
    if (r.error !== null && previous[runner]?.error !== r.error) {
      d.log.warn(
        { runner, executor: executor.id, error: r.error },
        `cannot re-detect runner ${runner}'s version on ${executor.id}: ${r.error}`,
      );
    }
  }
  const observed: PairObservation[] = placed
    ? image_id === null
      ? []
      : live.map((a) => ({
          runner_id: a.id,
          executor_id: executor.id,
          health_version: null,
          image_id,
        }))
    : readings.flatMap(([runner_id, r]) =>
        r.version === null
          ? []
          : [
              {
                runner_id,
                executor_id: executor.id,
                health_version: r.version,
                image_id: null,
              },
            ],
      );
  if (observed.length > 0) await decertifyChanged(d, observed);
  return Object.fromEntries(readings);
}

/** The executor's image id now, or null when it has none or will not say — neither is drift. */
async function imageIdentity(
  d: RedetectDeps,
  executor: Executor,
): Promise<string | null> {
  if (executor.imageIdentity === undefined) return null;
  try {
    return await executor.imageIdentity();
  } catch (e) {
    d.log.warn(
      { executor: executor.id, error: asFrmError(e, "internal", "") },
      `cannot read the image identity of ${executor.id}`,
    );
    return null;
  }
}

/**
 * Only what was observed is judged here: the runners' keys (version as registered, caps, kit,
 * suite) are boot's and each registration's to check, never a health pass's.
 */
async function decertifyChanged(
  d: RedetectDeps,
  observed: readonly PairObservation[],
): Promise<void> {
  const stale = await decertifyStale(d.db, [], d.kits, observed);
  if (!stale.ok) {
    d.log.error({ error: stale.error }, "cannot decertify changed runners");
    return;
  }
  for (const s of stale.value) {
    d.log.warn(
      { runner: s.runner_id, executor: s.executor_id, reason: s.reason },
      `runner ${s.runner_id} is uncertified on ${s.executor_id}: ${s.reason}`,
    );
  }
}

async function detect(
  d: RedetectDeps,
  adapter: RunnerAdapter,
  executor: Executor,
): Promise<RunnerReading> {
  const asked: Promise<Result<{ version: string }>> = adapter
    .health(executor)
    .catch((e: unknown) =>
      err(asFrmError(e, "runner_error", "its health call threw")),
    );
  if (!(await settlesWithin(asked, d.clock, d.timeoutMs))) {
    return { version: null, error: `no answer within ${d.timeoutMs} ms` };
  }
  const got = await asked;
  if (!got.ok) return { version: null, error: got.error.message };
  const version = got.value.version.trim();
  return version === ""
    ? { version: null, error: "its health answered no version" }
    : { version, error: null };
}
