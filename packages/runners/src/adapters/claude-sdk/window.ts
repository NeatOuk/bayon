// The window a claude-sdk session gets, as the pinned CLI decides it (2.1.283, the same
// rule as 2.1.269), read from its bundle and checked on the binary (context-window-cli.test.ts):
// - a model string with the `[1m]` suffix gets 1M whatever the base URL: the CLI adds the
//   `context-1m-2025-08-07` beta and sends the bare id;
// - without it, a model the CLI's catalog marks native 1M (Sonnet 5, Opus 5, Opus 5.5) gets 1M only
//   against the first-party base URL, so never behind the context proxy (127.0.0.1); a model the
//   catalog does not know gets 200k anywhere. The CLI refuses a prompt past its window itself
//   ("Prompt is too long", `terminal_reason: blocking_limit`), before the API sees it.
// So a models row records 1M only with the suffix: the ceilings measure against what the CLI enforces.
import type { ModelRow } from "../../adapter.js";

/** The CLI's own 1M opt-in on a model string ("append [1m] to the model name for 1M"). */
export const ONE_M_SUFFIX = "[1m]";
/** The window the CLI gives a model with the suffix. */
export const ONE_M_WINDOW = 1_000_000;
/** The window the CLI gives every other model behind the context proxy: its default. */
export const DEFAULT_WINDOW = 200_000;

/** The model string opts into the 1M window. */
export const hasOneM = (model: string): boolean => model.endsWith(ONE_M_SUFFIX);

/** The id the API is sent and echoes in the stream's assistant frames: the string without the suffix. */
export const bareModel = (model: string): string =>
  hasOneM(model) ? model.slice(0, -ONE_M_SUFFIX.length) : model;

/**
 * Price rows under every name the stream uses. The result frame keys usage by the string spawned
 * (`…[1m]`), the assistant frames by the bare id, so a suffixed row also prices its bare id, after
 * every stored row: a bare row of its own is found first and wins.
 */
export function streamPrices(rows: readonly ModelRow[]): readonly ModelRow[] {
  const aliases = rows
    .filter((r) => hasOneM(r.model))
    .map((r) => ({ ...r, model: bareModel(r.model) }));
  return aliases.length === 0 ? rows : [...rows, ...aliases];
}
