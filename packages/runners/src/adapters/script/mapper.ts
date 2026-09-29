// The `script` runner's mapper: its lines are already canonical events (no `ts`, stamped here),
// validated exactly like the fixture runner's (Invariant 4: anything invalid becomes
// `runner_native`, never dropped). No spend bookkeeping -- a script job reports `usage`/`cost_usd`
// (both zero; it is not billed) inline in its own `terminal` payload, not via cumulative totals.
import { parseCanonical } from "@bayon/core";
import type { Mapper } from "../../adapter.js";
import { capToRecord, unparsedEvent } from "../../record-events.js";

const decoder = new TextDecoder();

function jsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** A fresh mapper for one script process segment. */
export function createScriptMapper(): Mapper {
  return {
    map(input) {
      if (input.bytes.length === 0) return [];
      const text = decoder.decode(input.bytes);
      const line = input.partial === true ? undefined : jsonObject(text);
      if (line === undefined) {
        const reason =
          input.partial === true ? "partial line" : "not a JSON object";
        return capToRecord(
          [unparsedEvent(text, reason, input.ts)],
          input.bytes,
          input.ts,
        );
      }
      const event = parseCanonical(
        { ...line, ts: input.ts },
        { now: () => input.ts },
      );
      return capToRecord([event], input.bytes, input.ts);
    },
  };
}
