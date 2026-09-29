import { err, ok, type Result } from "../errors.js";

// The house rule for every operator-declared command: it is run as an
// **argv, with no shell** (`pulse/probe-shell.ts`: "argv through the executor, never a shell
// string"), so the words are split on whitespace and nothing else is interpreted.
//
// Two columns carry such a command today — `repos.lint_cmd` and `workspaces.qa_cmd` — and each
// refuses with its own wording, naming its own column and its own fix. What is shared is the rule
// itself, which is here so the two cannot drift: a metacharacter set that loosened on one side and
// not the other would be a hole in exactly the place the rule exists to close.

/**
 * Characters that mean something to a shell. A value carrying any of these would be run literally,
 * as arguments, and would fail in a way that looks like the command failing rather than like the
 * misconfiguration it is; so it is refused instead, with the fix named.
 */
export const SHELL_META = /[&|;()<>$`"'\\*?[\]{}!#~\n\r]/;

/**
 * `SHELL_META` without the braces, for a command whose own syntax spends them (`qaArgv`'s
 * placeholders). The caller that uses this **must** account for every `{` and `}` itself: a brace
 * left unaccounted for is a brace the shell would have eaten, and this set no longer refuses it.
 */
export const SHELL_META_NO_BRACES = /[&|;()<>$`"'\\*?[\]!#~\n\r]/;

/** The most argv words a declared command may have: a guard against a pasted script, not a real limit. */
export const ARGV_WORDS_MAX = 32;

/** What a caller says when each of the three checks refuses; each names its own column and fix. */
export interface ArgvMessages {
  /** No command at all. */
  readonly empty: string;
  /** `text` carries a shell metacharacter. */
  readonly compound: (text: string) => string;
  /** `words` is over ARGV_WORDS_MAX. */
  readonly tooLong: (words: number) => string;
}

export interface ArgvRule extends ArgvMessages {
  /** The metacharacters refused; the default is SHELL_META. */
  readonly meta?: RegExp;
}

const refuse = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

/**
 * A declared command as an argv: whitespace-separated words, no shell. `pnpm -w lint` is an argv;
 * `eslint . && prettier --check .` is a package script, and the refusal says so rather than running
 * half of it.
 */
export function commandArgv(
  cmd: string | null | undefined,
  rule: ArgvRule,
): Result<string[]> {
  const text = (cmd ?? "").trim();
  if (text === "") return refuse(rule.empty);
  if ((rule.meta ?? SHELL_META).test(text)) {
    return refuse(rule.compound(text));
  }
  const argv = text.split(/\s+/);
  return argv.length > ARGV_WORDS_MAX
    ? refuse(rule.tooLong(argv.length))
    : ok(argv);
}

/** An argv as one readable line, for a finding, a log and `GateEvidence.command`. */
export const commandLineOf = (argv: readonly string[]): string =>
  argv.join(" ");

/** The most of a failing command's output a finding carries inline (Invariant 9: the rest is a path). */
export const COMMAND_TAIL_LINES = 40;
export const COMMAND_TAIL_CHARS = 4_000;

/**
 * The end of a command's output, capped both ways: the last lines are where a linter or a test
 * runner puts its summary, and the whole of it is on disk at the path the finding names. Never the
 * head — a thousand complaints would push the count off the inline copy entirely.
 */
export function commandTail(output: string): string {
  const lines = output.replace(/\s+$/, "").split("\n");
  const tail = lines.slice(Math.max(0, lines.length - COMMAND_TAIL_LINES));
  const text = tail.join("\n");
  return text.length <= COMMAND_TAIL_CHARS
    ? text
    : `…\n${text.slice(text.length - COMMAND_TAIL_CHARS)}`;
}
