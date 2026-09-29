// The fixture runner's mapper: its lines already are canonical events without `ts`. It stamps the
// record's `ts`, validates with core's `parseCanonical` (anything invalid, such as an unknown kind,
// becomes `runner_native`), and turns a terminal's running totals into the run's spend delta.
import { parseCanonical, type Usage } from "@bayon/core";
import { z } from "zod";
import type { Mapper } from "../../adapter.js";
import { capToRecord, unparsedEvent } from "../../record-events.js";
import { SPEND_START, reported, type SpendState } from "../../spend.js";

const Cumulative = z.record(
  z.string(),
  z.object({
    tokens_in: z.int().nonnegative(),
    tokens_out: z.int().nonnegative(),
    tokens_cache_read: z.int().nonnegative(),
    tokens_cache_write: z.int().nonnegative(),
    cost_usd: z.number().nonnegative(),
  }),
);
const TerminalLine = z.looseObject({
  kind: z.literal("terminal"),
  payload: z.looseObject({ cumulative: Cumulative }),
});

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

/** A fresh mapper for one fixture process segment. */
export function createFixtureMapper(): Mapper {
  let spend: SpendState = SPEND_START;
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
      const terminal = TerminalLine.safeParse(line);
      let payload = line["payload"];
      if (terminal.success) {
        const billed = reported(spend, terminal.data.payload.cumulative);
        spend = billed.state;
        const usage: Usage = {
          tokens_in: billed.spend.tokens_in,
          tokens_out: billed.spend.tokens_out,
          tokens_cache_read: billed.spend.tokens_cache_read,
          tokens_cache_write: billed.spend.tokens_cache_write,
        };
        payload = {
          ...terminal.data.payload,
          spend: billed.spend,
          usage,
          cost_usd: billed.spend.cost_usd,
        };
      }
      const event = parseCanonical(
        { ...line, payload, ts: input.ts },
        { now: () => input.ts },
      );
      return capToRecord([event], input.bytes, input.ts);
    },
  };
}
