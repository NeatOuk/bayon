// What a certification pins beside its key (§15; "Amendments — M4": each health pass re-detects
// runner versions, and a changed version makes the runner uncertified): the version the
// runner's health reported on the pair's own executor, recorded by test 1's `health_ok` check. The
// health pass asks the same adapter call again, and a different answer lapses the pair. A pair
// whose test 1 saw no version pins none, so nothing is compared — and `unattended_allowed` now
// refuses such a pair outright, since a certification nothing can falsify is not one.
// Beside the version, a container's built image id is pinned: the certified runner lives inside
// that image, so a rebuild that changes it is a new subject.
//
// On a container executor that image id is the *only* pin the pair has: the health
// pass reads no version there — test 1 read it inside a session and opening one every
// pass is not a health check — so `PairObservation.health_version` is null by construction and
// versionDrift below is a no-op. A container result with no image id is one nothing can falsify, so
// `unattended_allowed` in conformance.ts refuses it outright; nothing here has to read a missing pin
// as drift, which would be an accusation where there is only silence.
import {
  MAX_DETAIL_CHARS,
  VERSION_TEST_ID,
  type ConformanceResult,
} from "./conformance.js";

export { VERSION_TEST_ID };
/** Test 1's check that health answered with a version; its detail is that version, clipped. */
export const HEALTH_VERSION_CHECK = "health_ok";

/** A check detail as the suite stores it: at most MAX_DETAIL_CHARS, an ellipsis marking a cut. */
export function clipDetail(text: string): string {
  return text.length <= MAX_DETAIL_CHARS
    ? text
    : `${text.slice(0, MAX_DETAIL_CHARS - 1)}…`;
}

/** The version health reported on the certified executor, or null when test 1 saw none. */
export function pinnedHealthVersion(r: ConformanceResult): string | null {
  const test = r.tests.find((t) => t.id === VERSION_TEST_ID);
  const check = test?.checks.find((c) => c.name === HEALTH_VERSION_CHECK);
  if (check?.ok !== true || check.detail === null) return null;
  return check.detail.trim() === "" ? null : check.detail;
}

/** The image the pair was certified against, or null where the executor has none (a local one) and
 * for a result stored before image identity was pinned. */
export function pinnedImageId(r: ConformanceResult): string | null {
  const pinned = r.executor.image_id;
  return pinned === null || pinned.trim() === "" ? null : pinned.trim();
}

/** What one health pass observed of a (runner, executor) pair. */
export interface PairObservation {
  readonly runner_id: string;
  readonly executor_id: string;
  /** adapter.health(executor)'s version, re-detected now. Null on an executor that places its
   * sessions: test 1 read that version *inside* a session there, and opening one every
   * pass is not a health check — the image's identity stands in for it. */
  readonly health_version: string | null;
  /** The executor's image identity now; null when it has none or could not be read. */
  readonly image_id: string | null;
}

/** Why the result's pins no longer hold against the observation; null when they hold or it pins
 * nothing. Each pin is judged on its own: one the observation could not read is not drift. */
export function observationDrift(
  r: ConformanceResult,
  o: PairObservation,
): string | null {
  return versionDrift(r, o) ?? imageDrift(r, o);
}

function versionDrift(r: ConformanceResult, o: PairObservation): string | null {
  const pinned = pinnedHealthVersion(r);
  if (pinned === null || o.health_version === null) return null;
  const now = clipDetail(o.health_version);
  return now.trim() === pinned.trim()
    ? null
    : `health_version ${pinned.trim()} → ${now.trim()} on ${o.executor_id}`;
}

function imageDrift(r: ConformanceResult, o: PairObservation): string | null {
  const pinned = pinnedImageId(r);
  if (pinned === null || o.image_id === null) return null;
  const now = o.image_id.trim();
  return now === pinned
    ? null
    : `image_id ${pinned} → ${now} on ${o.executor_id}`;
}
