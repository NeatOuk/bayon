// What the context proxy reports per model call, and the run's totals (spec M12, §5.2 / §9.4). The
// proxy interleaves one `frm.ctx` frame per call into the adapter's record stream; the mapper folds
// them and puts the totals on the run's terminal payload as `context`. No new event kind.
import { z } from "zod";
import { err, ok, type Result } from "../errors.js";

export const CONTEXT_FRAME_TYPE = "frm.ctx";
/** A frame names at most this many originals it stored. */
export const MAX_FRAME_DIGESTS = 64;

const count = z.int().nonnegative();
const Ruleset = z.string().regex(/^[a-z][a-z0-9]{0,15}$/);
/** The sha256 of an original, lower-case hex: its file name in the store. */
const Digest = z.string().regex(/^[0-9a-f]{64}$/);

/** One model call: blocks seen, compressed, failed open; chars in and out; the originals stored. */
export const ContextFrame = z
  .strictObject({
    type: z.literal(CONTEXT_FRAME_TYPE),
    v: z.literal(1),
    ruleset: Ruleset,
    blocks: count,
    compressed: count,
    failed: count,
    chars_in: count,
    chars_out: count,
    digests: z.array(Digest).max(MAX_FRAME_DIGESTS),
    ms: count,
  })
  .refine((f) => f.compressed + f.failed <= f.blocks, {
    message: "compressed + failed exceeds blocks",
  });
export type ContextFrame = z.infer<typeof ContextFrame>;

/** A run's totals over its frames, as the terminal payload's `context`. */
export const ContextTotals = z.object({
  ruleset: Ruleset,
  calls: count,
  blocks: count,
  compressed: count,
  failed: count,
  chars_in: count,
  chars_out: count,
});
export type ContextTotals = z.infer<typeof ContextTotals>;

/** A frame from the record stream, or why it is not one. */
export function parseContextFrame(input: unknown): Result<ContextFrame> {
  const parsed = ContextFrame.safeParse(input);
  return parsed.success
    ? ok(parsed.data)
    : err({
        class: "validation",
        message: `not a context frame: ${z.prettifyError(parsed.error)}`,
        retryable: false,
      });
}

/**
 * The totals with one more frame folded in; `null` starts them. A session's ruleset is pinned at
 * spawn, so every frame of a run carries the same one; the totals keep the first frame's.
 */
export function foldContextFrame(
  totals: ContextTotals | null,
  frame: ContextFrame,
): ContextTotals {
  const base = totals ?? {
    ruleset: frame.ruleset,
    calls: 0,
    blocks: 0,
    compressed: 0,
    failed: 0,
    chars_in: 0,
    chars_out: 0,
  };
  return {
    ruleset: base.ruleset,
    calls: base.calls + 1,
    blocks: base.blocks + frame.blocks,
    compressed: base.compressed + frame.compressed,
    failed: base.failed + frame.failed,
    chars_in: base.chars_in + frame.chars_in,
    chars_out: base.chars_out + frame.chars_out,
  };
}
