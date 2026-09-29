// frm.ctx frames as records (spec M12): encoded in the schema's order, held until the
// record queue exists, then queued between the runner's lines; and the fold a mapper uses.
import { CONTEXT_RULESET, type ContextFrame } from "@bayon/core";
import { expect, test } from "vitest";
import {
  createFrameSink,
  encodeContextFrame,
  foldContextRecord,
} from "./context-frames.js";
import { createRecordQueue } from "./records.js";

const frame = (n: number): ContextFrame => ({
  ms: 3,
  digests: ["a".repeat(64)],
  chars_out: 10 * n,
  chars_in: 100 * n,
  failed: 0,
  compressed: 1,
  blocks: 2,
  ruleset: CONTEXT_RULESET,
  v: 1,
  type: "frm.ctx",
});

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test("a frame is one JSON line, its fields in the schema's order", () => {
  const r = encodeContextFrame(frame(1));
  expect(r.partial).toBe(false);
  expect(Object.keys(JSON.parse(text(r.bytes)) as object)).toEqual([
    "type",
    "v",
    "ruleset",
    "blocks",
    "compressed",
    "failed",
    "chars_in",
    "chars_out",
    "digests",
    "ms",
  ]);
  expect(text(r.bytes)).not.toContain("\n");
});

test("frames wait for the queue, then join it in order", async () => {
  const sink = createFrameSink();
  sink.push(frame(1));
  sink.push(frame(2));
  const queue = createRecordQueue();
  sink.attach(queue);
  sink.push(frame(3));
  queue.close();
  const seen: number[] = [];
  for await (const r of queue) {
    seen.push((JSON.parse(text(r.bytes)) as { chars_in: number }).chars_in);
  }
  expect(seen).toEqual([100, 200, 300]);
});

test("a mapper folds frames into run totals, and says why a record is not one", () => {
  const one = foldContextRecord(undefined, frame(1));
  const two = one.ok ? foldContextRecord(one.totals, frame(2)) : one;
  expect(two).toEqual({
    ok: true,
    totals: {
      ruleset: CONTEXT_RULESET,
      calls: 2,
      blocks: 4,
      compressed: 2,
      failed: 0,
      chars_in: 300,
      chars_out: 30,
    },
  });
  const bad = foldContextRecord(undefined, { ...frame(1), failed: 9 });
  expect(bad.ok).toBe(false);
  expect(bad.ok ? [] : bad.issues.join(" ")).toMatch(/not a context frame/);
});
