// The context proxy's `frm.ctx` frames in an adapter's record stream (spec M12, §5.2 / §9.4), and
// their fold for a mapper. Runner-neutral: the frame is ours, not a runner's. One frame per model
// call goes between the runner's own lines; the raw log keeps it, so a replay folds the same totals.
import {
  CONTEXT_FRAME_TYPE,
  foldContextFrame,
  parseContextFrame,
  type ContextFrame,
  type ContextTotals,
} from "@bayon/core";
import type { RawRecord } from "./adapter.js";
import type { RecordQueue } from "./records.js";

const encoder = new TextEncoder();

/** A frame as one record: its JSON, the fields in the schema's order, no line break. */
export function encodeContextFrame(f: ContextFrame): RawRecord {
  const ordered: ContextFrame = {
    type: CONTEXT_FRAME_TYPE,
    v: 1,
    ruleset: f.ruleset,
    blocks: f.blocks,
    compressed: f.compressed,
    failed: f.failed,
    chars_in: f.chars_in,
    chars_out: f.chars_out,
    digests: f.digests,
    ms: f.ms,
  };
  return { bytes: encoder.encode(JSON.stringify(ordered)), partial: false };
}

/**
 * Where a session's proxy puts its frames. The proxy starts before the runner's process, so the
 * record queue the frames join does not exist yet: frames wait here until `attach`, then go in as
 * they come. A frame after the queue closed is dropped by the queue, like any late record.
 */
export interface FrameSink {
  push(frame: ContextFrame): void;
  attach(queue: RecordQueue): void;
}

export function createFrameSink(): FrameSink {
  // Channel internals: mutable, never exposed.
  let queue: RecordQueue | undefined;
  let waiting: RawRecord[] = [];
  return {
    push(frame) {
      const record = encodeContextFrame(frame);
      if (queue === undefined) {
        waiting = [...waiting, record];
        return;
      }
      // Never awaited: a full queue holds the runner's reader back, never the model call.
      void queue.push(record);
    },
    attach(q) {
      queue = q;
      const held = waiting;
      waiting = [];
      for (const record of held) void q.push(record);
    },
  };
}

/** What a mapper learns from a `frm.ctx` record: the run's totals with it folded in, or why not. */
export type ContextFold =
  | { readonly ok: true; readonly totals: ContextTotals }
  | { readonly ok: false; readonly issues: readonly string[] };

/** Folds one parsed `frm.ctx` record into a run's totals (`undefined`: the run's first). */
export function foldContextRecord(
  totals: ContextTotals | undefined,
  raw: unknown,
): ContextFold {
  const frame = parseContextFrame(raw);
  return frame.ok
    ? { ok: true, totals: foldContextFrame(totals ?? null, frame.value) }
    : { ok: false, issues: [frame.error.message] };
}

export { CONTEXT_FRAME_TYPE };
