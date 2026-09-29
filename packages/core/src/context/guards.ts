// Blocks the rules must never touch, whatever their size (spec M12, §8.5 "never compressed").

/**
 * Unified diff or patch output: a `diff --git` (or combined `--cc`) header, or a hunk header,
 * at the start of any line. Cutting a hunk would misstate the change, so such a block goes whole.
 */
const DIFF_LINE = /^(?:diff --(?:git|cc|combined) |@@+ -\d+(?:,\d+)? [-+]\d+)/m;

export const isUnifiedDiff = (text: string): boolean => DIFF_LINE.test(text);

/**
 * The store of originals (`.foreman/ctx`), however the slashes are written — JSON-escaped ones
 * included — and not a longer name that merely starts the same.
 */
const STORE = /\.foreman[\\/]+ctx(?![\w.-])/;

/**
 * Whether a tool's input names the store of originals: its result is never compressed, or an agent
 * reading an original could never see it whole.
 */
export const mentionsContextStore = (input: string): boolean =>
  STORE.test(input);
