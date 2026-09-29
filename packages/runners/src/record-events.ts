// What every adapter's mapper shares: numbering a record's events and the fallback for a line
// that cannot be read. Runner-neutral.
import type { CanonicalEvent } from "@bayon/core";
import type { MappedEvent } from "./adapter.js";

/** The `runner_type` of a line that is not a JSON object, or was cut off by EOF. */
export const UNPARSED = "unparsed";

const decoder = new TextDecoder();

/** A line kept verbatim as `runner_native` (Invariant 4): stored, never dropped. */
export function unparsedEvent(
  text: string,
  reason: string,
  ts: number,
): CanonicalEvent {
  return {
    kind: "runner_native",
    ts,
    runner_type: UNPARSED,
    payload: { raw: text, parse_error: reason },
  };
}

/**
 * Numbers a record's events. Ordinals must stay below the record's length so that
 * `offset + ordinal` never reaches the next record (law L1); a record that would break that
 * becomes one `runner_native`.
 */
export function capToRecord(
  events: readonly CanonicalEvent[],
  bytes: Uint8Array,
  ts: number,
): MappedEvent[] {
  if (events.length <= bytes.length) {
    return events.map((e, ordinal) => ({ ...e, ordinal }));
  }
  return [
    {
      kind: "runner_native",
      ts,
      ordinal: 0,
      runner_type: UNPARSED,
      payload: {
        raw: decoder.decode(bytes),
        issues: [`${events.length} events from a ${bytes.length}-byte record`],
      },
    },
  ];
}
