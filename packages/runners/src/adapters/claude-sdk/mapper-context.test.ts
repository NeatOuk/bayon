// The context proxy's frames in this runner's record stream (spec M12): folded into each
// run's terminal, no event of their own, nothing else changed, and a replay folds the same.
import { readFileSync } from "node:fs";
import { CONTEXT_RULESET, type ContextFrame } from "@bayon/core";
import { expect, test } from "vitest";
import type { MapInput, MappedEvent } from "../../adapter.js";
import { encodeContextFrame } from "../../context-frames.js";
import { createMapper } from "./mapper.js";
import { MODELS } from "./registration.js";

const FIXTURE = new URL(
  "../../../fixtures/claude-sdk/two-runs.jsonl",
  import.meta.url,
);
const TS = 1_800_000_000_000;
const encoder = new TextEncoder();

const frame = (compressed: number, chars: number): ContextFrame => ({
  type: "frm.ctx",
  v: 1,
  ruleset: CONTEXT_RULESET,
  blocks: 3,
  compressed,
  failed: 0,
  chars_in: chars,
  chars_out: chars / 10,
  digests: Array.from({ length: compressed }, (_, i) => String(i).repeat(64)),
  ms: 2,
});

/** The fixture's records, with `frames[i]` inserted before its i-th result line. */
function records(frames: readonly (readonly unknown[])[]): MapInput[] {
  const lines = readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(1);
  let results = 0;
  const out: string[] = [];
  for (const line of lines) {
    if ((JSON.parse(line) as { type?: string }).type === "result") {
      for (const f of frames[results] ?? []) {
        out.push(
          typeof f === "string"
            ? f
            : new TextDecoder().decode(
                encodeContextFrame(f as ContextFrame).bytes,
              ),
        );
      }
      results += 1;
    }
    out.push(line);
  }
  let offset = 0;
  return out.map((text) => {
    const bytes = encoder.encode(text);
    const r = { offset, bytes, ts: TS };
    offset += bytes.length + 1;
    return r;
  });
}

const mapAll = (rs: readonly MapInput[]): MappedEvent[] => {
  const mapper = createMapper({ prices: MODELS });
  return rs.flatMap((r) => mapper.map(r));
};
const strip = (es: readonly MappedEvent[]) =>
  es.map((e) => {
    if (e.kind !== "terminal") return { ...e, ordinal: 0 };
    const { context: _, ...payload } = e.payload;
    void _;
    return { ...e, ordinal: 0, payload };
  });

test("frames fold into their run's terminal, and nothing else changes", () => {
  const plain = mapAll(records([]));
  const framed = mapAll(
    records([[frame(1, 1000), frame(2, 3000)], [frame(1, 500)]]),
  );
  const terminals = framed.filter((e) => e.kind === "terminal");
  expect(terminals.map((t) => t.payload["context"])).toEqual([
    {
      ruleset: CONTEXT_RULESET,
      calls: 2,
      blocks: 6,
      compressed: 3,
      failed: 0,
      chars_in: 4000,
      chars_out: 400,
    },
    {
      ruleset: CONTEXT_RULESET,
      calls: 1,
      blocks: 3,
      compressed: 1,
      failed: 0,
      chars_in: 500,
      chars_out: 50,
    },
  ]);
  // The fixture's second init is runner_native already; the frames add none.
  expect(framed.filter((e) => e.runner_type === "frm.ctx")).toEqual([]);
  expect(strip(framed)).toEqual(strip(plain));
  // Off: no frames, no `context` on any terminal.
  expect(
    plain
      .filter((e) => e.kind === "terminal")
      .map((t) => "context" in t.payload),
  ).toEqual([false, false]);
});

test("a replay of the same records gives the same events", () => {
  const rs = records([[frame(1, 1000)], [frame(2, 800)]]);
  expect(mapAll(rs)).toEqual(mapAll(rs));
});

test("a record that says frm.ctx but is not a frame is kept as runner_native", () => {
  const bad = { ...frame(1, 10), failed: 7 };
  const events = mapAll(records([[bad]]));
  const native = events.filter((e) => e.runner_type === "frm.ctx");
  expect(native.map((e) => e.kind)).toEqual(["runner_native"]);
  expect(events.find((e) => e.kind === "terminal")?.payload).not.toHaveProperty(
    "context",
  );
});
