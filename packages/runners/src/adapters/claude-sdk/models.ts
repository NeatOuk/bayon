// What a claude-sdk models row may be: the `validateModel` hook, pure. Unlike opencode
// (a closed set of provider/model pairs), the SDK's CLI is Anthropic's own and accepts a model
// string in a fixed shape without the adapter shipping every one in advance; this hook accepts any
// string of that shape (or one this adapter already registers), and judges the row's `context_tokens`
// against the CLI's window rule (window.ts) instead. It reads no other setting: this
// adapter's `spec.modelSettings` is unused, exactly as `acceptRegisteredModels` would refuse any.
import { err, ok, type Result } from "@bayon/core";
import { z } from "zod";
import type { ModelContext, ModelProposal } from "../../adapter.js";
import { frmError } from "../../errors.js";
import { DEFAULT_WINDOW, ONE_M_WINDOW, hasOneM } from "./window.js";

/**
 * A model string this runner's CLI could plausibly be given: `claude-`, then one or more
 * lowercase-alnum segments joined by `-`, with the CLI's own `[1m]` opt-in allowed at the end.
 * Permissive by design (§ risk in the plan): a typo certifies nowhere and fails conformance test 2
 * with the API's own error, never a false pass.
 */
export const MODEL_PATTERN = /^claude-[a-z0-9]+(-[a-z0-9]+)*(\[1m\])?$/;

/** The reasoning-effort settings this adapter's spawn accepts (adapter.ts's own `Flags.effort`). */
export const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof Effort>;

const invalid = (message: string): Result<never> =>
  err(frmError("validation", message));

/**
 * The hook: a model string matching `MODEL_PATTERN`, or one this adapter already registers (so a
 * shipped row is always accepted regardless of the pattern's shape); a valid `effort` or none; a
 * required `contextTokens` within the CLI's window rule for the string's `[1m]` opt-in; and no
 * settings, since this adapter reads none from a models row.
 */
export function validateClaudeSdkModel(
  row: ModelProposal,
  ctx: ModelContext,
): Result<void> {
  if (!MODEL_PATTERN.test(row.model) && !ctx.registered.includes(row.model)) {
    return invalid(
      `model ${JSON.stringify(row.model)} does not match ${MODEL_PATTERN.source} and is not one this runner already registers`,
    );
  }
  if (row.effort !== undefined) {
    const effort = Effort.safeParse(row.effort);
    if (!effort.success) {
      return invalid(
        `effort ${JSON.stringify(row.effort)} is not one of ${Effort.options.join(", ")}`,
      );
    }
  }
  const window = hasOneM(row.model) ? ONE_M_WINDOW : DEFAULT_WINDOW;
  if (row.contextTokens === undefined) {
    return invalid(
      `context_tokens is required: this runner's window depends on it (at most ${window} for ${JSON.stringify(row.model)})`,
    );
  }
  if (row.contextTokens > window) {
    return invalid(
      hasOneM(row.model)
        ? `context_tokens ${row.contextTokens} is past the CLI's [1m] ceiling of ${ONE_M_WINDOW}`
        : `context_tokens ${row.contextTokens} is past ${DEFAULT_WINDOW}: without the CLI's [1m] opt-in the session gets ${DEFAULT_WINDOW} at most`,
    );
  }
  const keys = Object.keys(row.settings);
  if (keys.length > 0) {
    return invalid(
      `this runner's models take no settings (got ${keys.join(", ")})`,
    );
  }
  return ok(undefined);
}

/**
 * The CLI's own words for a model it refuses by version (a model newer than the pinned CLI knows),
 * turned into a message naming the fix; null when `text` is not that refusal. Matched on the
 * message text alone (the plan's stated risk): if Anthropic rewords it, this returns null and the
 * suite's report degrades to its ordinary generic fails, never a false pass.
 */
export function requiredCliVersion(text: string): string | null {
  const m =
    /Claude Code (\S+) does not support this model; version (\S+) or newer is required/.exec(
      text,
    );
  return m === null
    ? null
    : `claude CLI ${m[1]} cannot run this model: version ${m[2]} or newer is required (update the pinned SDK/CLI)`;
}
