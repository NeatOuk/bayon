import type { Clock } from "@bayon/core";

/** True if `promise` settles within `ms` of `clock`'s time. The timer is cancelled either way. */
export async function settlesWithin(
  promise: Promise<unknown>,
  clock: Clock,
  ms: number,
): Promise<boolean> {
  const timer = new AbortController();
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      clock.after(ms, timer.signal).then(
        () => false,
        () => false,
      ),
    ]);
  } finally {
    timer.abort();
  }
}

/**
 * A stream read to its end as text. A read error ends it, noted in the text. With `maxChars`, the
 * read stops once the text is longer than that: `onOverflow` is told once (to stop the writer), and
 * the text comes back cut to `maxChars + 1` characters, so a caller can tell it overran.
 */
export async function readText(
  stream: AsyncIterable<Uint8Array>,
  maxChars?: number,
  onOverflow?: () => void,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  try {
    for await (const chunk of stream) {
      text += decoder.decode(chunk, { stream: true });
      if (maxChars !== undefined && text.length > maxChars) {
        onOverflow?.();
        return text.slice(0, maxChars + 1);
      }
    }
  } catch (e) {
    return `${text}\n[read failed: ${String(e)}]`;
  }
  return text + decoder.decode();
}
