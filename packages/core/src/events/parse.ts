import { z } from "zod";
import type { Clock } from "../clock.js";
import { CanonicalEvent, EpochMs } from "./schema.js";

/** The `runner_type` of a fallback event whose input named none. */
export const UNKNOWN_RUNNER_TYPE = "unknown";

const name = z.string().min(1);

// What a fallback keeps of a failed input's envelope. Anything unusable is replaced or left out.
const Salvage = z
  .object({
    ts: EpochMs.optional().catch(undefined),
    runner_type: name.catch(UNKNOWN_RUNNER_TYPE),
    run_id: name.optional().catch(undefined),
  })
  .catch({ runner_type: UNKNOWN_RUNNER_TYPE });

/**
 * Parses anything into a CanonicalEvent and never throws. Input that is not a valid event (an
 * unknown kind, an invalid payload, not an object at all) becomes `runner_native`, with the input
 * verbatim in `payload.raw` and the reasons in `payload.issues`: stored, never dropped.
 */
export function parseCanonical(
  input: unknown,
  clock: Pick<Clock, "now">,
): CanonicalEvent {
  try {
    const parsed = CanonicalEvent.safeParse(input);
    if (parsed.success) return parsed.data;
    const { ts, runner_type, run_id } = Salvage.parse(input);
    return {
      kind: "runner_native",
      ts: ts ?? clock.now(),
      runner_type,
      ...(run_id === undefined ? {} : { run_id }),
      payload: {
        raw: input,
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.map(String).join(".")}: ${issue.message}`,
        ),
      },
    };
  } catch {
    // Only reachable when reading the input itself throws, e.g. a getter.
    return {
      kind: "runner_native",
      ts: clock.now(),
      runner_type: UNKNOWN_RUNNER_TYPE,
      payload: { raw: input, issues: ["input could not be read"] },
    };
  }
}
