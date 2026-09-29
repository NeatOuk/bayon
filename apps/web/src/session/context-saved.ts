import type { SessionView } from "@bayon/proto";

// What the session screen says of context compression (spec M12): how much large tool
// output its runs kept out of the model's input, as the supervisor estimated it (chars/4), and how
// many blocks were sent whole because compressing them failed.

/**
 * "context saved ≈ 12,345 tokens (85 %)": the tokens its runs kept out, and their share of the large
 * tool output they came from. "context compression on" before any run reported; null when the
 * session is not compressed.
 */
export function contextSavedLine(session: SessionView): string | null {
  if (session.context_ruleset === null) return null;
  const { context } = session;
  if (context === null || session.tokens_saved === null) {
    return "context compression on";
  }
  const pct =
    context.chars_in === 0
      ? 0
      : Math.round(
          (Math.max(0, context.chars_in - context.chars_out) * 100) /
            context.chars_in,
        );
  return `context saved ≈ ${session.tokens_saved.toLocaleString("en")} tokens (${pct} %)`;
}

/** Blocks the proxy sent whole because compressing them failed; 0 when none or not compressed. */
export const failedOpen = (session: SessionView): number =>
  session.context?.failed ?? 0;
