// The context proxy's frames in the turn host's record stream (spec M12): folded into each
// run's terminal, no event of their own (not even a flush of streamed text), nothing else changed,
// and a replay folds the same.
import { readFileSync } from "node:fs";
import { CONTEXT_RULESET, type ContextFrame } from "@bayon/core";
import { expect, test } from "vitest";
import type { MapInput, MappedEvent } from "../../adapter.js";
import { encodeContextFrame } from "../../context-frames.js";
import { createOpencodeMapper } from "./mapper.js";
import { MODELS } from "./registration.js";

const FIXTURE = new URL(
  "../../../fixtures/opencode/cancel-then-ok.jsonl",
  import.meta.url,
);
const TS = 1_800_000_000_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const frame = (compressed: number, chars: number): ContextFrame => ({
  type: "frm.ctx",
  v: 1,
  ruleset: CONTEXT_RULESET,
  blocks: 2,
  compressed,
  failed: 0,
  chars_in: chars,
  chars_out: chars / 4,
  digests: [],
  ms: 1,
});
const frameLine = (f: unknown) =>
  decoder.decode(encodeContextFrame(f as ContextFrame).bytes);

/** The fixture's lines with frames inserted: each before the line `at(line)` picks. */
function records(
  insert: readonly { at: (line: string) => boolean; frame: unknown }[],
): MapInput[] {
  const lines = readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(1);
  const pending = [...insert];
  const out: string[] = [];
  for (const line of lines) {
    while (pending[0]?.at(line) === true)
      out.push(frameLine(pending.shift()?.frame));
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

const thought = (l: string) => l.includes('"agent_thought_chunk"');
const answer = (id: number) => (l: string) =>
  l.startsWith(`{"jsonrpc":"2.0","id":${id},"result"`);

const mapAll = (rs: readonly MapInput[]): MappedEvent[] => {
  const mapper = createOpencodeMapper({ prices: MODELS });
  return rs.flatMap((r) => mapper.map(r));
};
const strip = (es: readonly MappedEvent[]) =>
  es.map((e) => {
    if (e.kind !== "terminal") return { ...e, ordinal: 0 };
    const { context: _, ...payload } = e.payload;
    void _;
    return { ...e, ordinal: 0, payload };
  });

test("frames fold into their run's terminal, mid-stream too, and nothing else changes", () => {
  const plain = mapAll(records([]));
  const framed = mapAll(
    records([
      { at: thought, frame: frame(1, 400) }, // between two chunks of one message
      { at: answer(3), frame: frame(2, 800) },
      { at: answer(4), frame: frame(1, 1200) },
    ]),
  );
  const terminals = framed.filter((e) => e.kind === "terminal");
  expect(terminals.map((t) => t.payload["context"])).toEqual([
    {
      ruleset: CONTEXT_RULESET,
      calls: 2,
      blocks: 4,
      compressed: 3,
      failed: 0,
      chars_in: 1200,
      chars_out: 300,
    },
    {
      ruleset: CONTEXT_RULESET,
      calls: 1,
      blocks: 2,
      compressed: 1,
      failed: 0,
      chars_in: 1200,
      chars_out: 300,
    },
  ]);
  expect(framed.some((e) => e.kind === "runner_native")).toBe(false);
  expect(strip(framed)).toEqual(strip(plain));
  expect(
    plain
      .filter((e) => e.kind === "terminal")
      .some((t) => "context" in t.payload),
  ).toBe(false);
});

test("a replay of the same records gives the same events", () => {
  const rs = records([{ at: answer(4), frame: frame(1, 100) }]);
  expect(mapAll(rs)).toEqual(mapAll(rs));
});

test("a record that says frm.ctx but is not a frame is kept as runner_native", () => {
  const events = mapAll(
    records([{ at: answer(4), frame: { ...frame(1, 10), v: 2 } }]),
  );
  const native = events.filter((e) => e.kind === "runner_native");
  expect(native.map((e) => e.runner_type)).toEqual(["frm.ctx"]);
});
