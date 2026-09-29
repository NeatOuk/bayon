import { createHash } from "node:crypto";
import type { Clock, FrmError } from "@bayon/core";

// A small per-bearer rate limit for the two routes that make the supervisor reach out to a remote
// (H1): `POST /projects` and `POST /projects/repo-check`. In memory, since it only
// has to hold a burst back, not survive a restart: at most `limit` calls in any `windowMs`. Keyed by
// a hash of the bearer, so the map never holds the token itself. No dependency: these few lines.

export const REPO_ROUTE_LIMIT = 10;
export const REPO_ROUTE_WINDOW_MS = 60_000;

export const RATE_LIMITED: FrmError = {
  class: "admission_refused",
  message:
    "Too many repository checks and new projects in the last minute: wait a moment, then try again.",
  retryable: true,
};

export interface RateLimit {
  /** Counts one call for `bearer`: true when it may go ahead, false past the limit. */
  take(bearer: string | undefined): boolean;
}

export function rateLimit(
  clock: Pick<Clock, "now">,
  limit = REPO_ROUTE_LIMIT,
  windowMs = REPO_ROUTE_WINDOW_MS,
): RateLimit {
  let calls: ReadonlyMap<string, readonly number[]> = new Map();
  return {
    take(bearer) {
      const key = createHash("sha256")
        .update(bearer ?? "")
        .digest("hex");
      const now = clock.now();
      const recent = (calls.get(key) ?? []).filter((at) => at > now - windowMs);
      const allowed = recent.length < limit;
      const kept = allowed ? [...recent, now] : recent;
      // Only bearers seen inside the window are kept: the map cannot grow without bound.
      calls = new Map(
        [...calls, [key, kept] as const].filter(([, times]) =>
          times.some((at) => at > now - windowMs),
        ),
      );
      return allowed;
    },
  };
}
