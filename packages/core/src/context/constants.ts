// Context compression's fixed numbers (spec M12 amendments, §8.5 / §8.7 / §8.3). Changing any value
// that shapes the output means a new CONTEXT_RULESET: a session pins its ruleset at spawn, a
// compression-on certification hashes it, and a re-sent history must come back byte-identical.

/** The ruleset every output of these rules belongs to. */
export const CONTEXT_RULESET = "ctx1";

/** A block over either threshold is compressed (§8.5's cap: 8 KB / 200 lines). KB = UTF-8 bytes. */
export const COMPRESS_MIN_BYTES = 8 * 1024;
export const COMPRESS_MIN_LINES = 200;

/** head-tail keeps these many lines at each end (§8.5). */
export const HEAD_LINES = 60;
export const TAIL_LINES = 60;

/** An error line keeps up to these many continuation lines after it (indented, or `at …`). */
export const STACK_CONTINUATION_LINES = 30;

/** A kept non-error line over this many UTF-8 bytes is cut, at a code-point boundary. */
export const LONG_LINE_BYTES = 2 * 1024;

/** A compressed block, marker included, is at most this share of the input's chars, or unchanged. */
export const MAX_OUTPUT_PERCENT = 70;

/** When the error lines (or error items) alone are over this many UTF-8 bytes, a rule declines. */
export const ERROR_BUDGET_BYTES = 16 * 1024;

/** dedupe: a run of at least this many similar lines collapses. */
export const DEDUPE_MIN_RUN = 3;

/** json-array: the array needs this many items, all objects; then keep head, tail and outliers. */
export const JSON_MIN_ITEMS = 8;
export const JSON_HEAD_ITEMS = 5;
export const JSON_TAIL_ITEMS = 3;
export const JSON_MAX_OUTLIERS = 10;

/**
 * json-array re-serialises what it keeps, so a number literal it cannot round-trip leaves the block
 * unchanged: this many mantissa digits (past 2^53), or an exponent this many digits long (overflow).
 */
export const PRECISION_DIGITS = 16;
export const PRECISION_EXPONENT_DIGITS = 3;

/**
 * The store of originals, relative to the session root that holds it, beside the session's worktrees
 * and outside every root the session writes; its entry name inside `.foreman/`.
 * A worktree's own `.foreman/ctx` (from an earlier build) is still disposable to the sweep.
 */
export const CONTEXT_STORE_NAME = "ctx";
export const CONTEXT_STORE_DIR = `.foreman/${CONTEXT_STORE_NAME}`;

/**
 * A line (or JSON string value) that reads as an error, a failure or a stack frame; such a line is
 * never dropped or folded. Case-insensitive, and neither `g` nor `y`, so `test` keeps no state. It
 * errs on the side of keeping: a false match costs gain, never content. Warnings are not errors.
 *
 * - `error`, `exception`, `fatal`, `panic`, `traceback`, `fail` anywhere: `TypeError`,
 *   `NullPointerException`, `panicked`, `FAIL`, `failed`, `failing`; Rust's `error[E0308]`, tsc's
 *   `error TS2322`, eslint's `3:5  error`; and npm's `ERR!`.
 * - The failure glyphs of test runners: `✕` (Jest), `×` (Vitest; Jest and Mocha on Windows), `✖`
 *   (Mocha, Node's test runner), `✗` (bats), `✘` (Playwright), `❌`; and TAP's `not ok` line.
 * - Stack frames: JS and Java (an indented `at` with a `:line`, or a native frame:
 *   `    at fn (file.js:1:2)`, `\tat a.B.c(B.java:42)`), Python (`  File "x.py", line 3`) and Go
 *   (`\t/src/main.go:8 +0x1d`).
 */
export const ERROR_PATTERN = new RegExp(
  [
    String.raw`error|exception|fatal|panic|traceback|fail|\berr!`,
    "[✕×✖✗✘❌]",
    String.raw`^\s*not ok\b`,
    String.raw`^\s+at\s.*(?::\d+|\((?:Native Method|Unknown Source)\))`,
    String.raw`^\s*File ".*", line \d+`,
    String.raw`^\s+\S+\.go:\d+`,
  ].join("|"),
  "i",
);

/**
 * The error shapes whose case matters, so they cannot go in ERROR_PATTERN: pytest's assertion
 * detail (`E       assert 90 == 81`: a capital E, then two or more spaces) and its pointer at the
 * failing source line (`>       assert total == 81`: `>`, then three or more spaces, which npm's
 * `> app@1.0.0 build` and a quoted `> text` never have).
 */
export const CASED_ERROR_PATTERN = /^E {2,}\S|^> {3,}\S/;

/** Whether a line (or JSON string value) is an error line: the one test every rule uses. */
export const isErrorLine = (text: string): boolean =>
  ERROR_PATTERN.test(text) || CASED_ERROR_PATTERN.test(text);
