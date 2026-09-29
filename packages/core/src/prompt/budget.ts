// Pre-flight (§8.4): count the compiled prompt, add the margin, and refuse it over the run class's
// cap with every section's size. A cap of 0 means n/a (run_classes).
import { err, ok, type FrmError, type Result } from "../errors.js";
import type { CompiledPrompt } from "./compile.js";

export const CHARS_PER_TOKEN = 4;
/** `preflight.margin_pct` when its settings row is absent. */
export const DEFAULT_MARGIN_PCT = 15;

/** The local approximation (§5.1): ~4 characters a token, no margin. Deterministic, so cuts are. */
export const localTokens = (text: string): number =>
  Math.ceil(text.length / CHARS_PER_TOKEN);

/** A runner's `estimateTokens`. */
export type TokenEstimator = (text: string) => Promise<number>;

/** What compile() fits a prompt into: the cap less the margin, in local tokens. 0: no budget. */
export const promptBudget = (capTokens: number, marginPct: number): number =>
  Math.floor((capTokens * 100) / (100 + marginPct));

export type PreflightInput = {
  readonly compiled: CompiledPrompt;
  readonly runClass: string;
  readonly capTokens: number;
  readonly marginPct: number;
  /** The runner's count, when it declares `tokenCounting`; else the local approximation. */
  readonly estimate?: TokenEstimator;
};

export type PreflightCount = {
  /** The estimate before the margin: `runs.prompt_tokens_est`. */
  readonly tokens: number;
  /** `local` when no runner count was given, or it failed or was not a count. */
  readonly counter: "runner" | "local";
};

/** The prompt's count when it fits; `over_budget` with the section sizes when it does not. */
export async function preflight(
  p: PreflightInput,
): Promise<Result<PreflightCount>> {
  const counted = await count(p.compiled.text, p.estimate);
  const padded = Math.ceil((counted.tokens * (100 + p.marginPct)) / 100);
  return p.capTokens === 0 || padded <= p.capTokens
    ? ok(counted)
    : err(overBudget(p, counted.tokens, padded));
}

async function count(
  text: string,
  estimate: TokenEstimator | undefined,
): Promise<PreflightCount> {
  if (estimate !== undefined) {
    const n = await estimate(text).catch(() => Number.NaN);
    if (Number.isFinite(n) && n >= 0) {
      return { tokens: Math.ceil(n), counter: "runner" };
    }
  }
  return { tokens: localTokens(text), counter: "local" };
}

function overBudget(
  p: PreflightInput,
  tokens: number,
  padded: number,
): FrmError {
  const { compiled } = p;
  const sizes = compiled.sections.map((s) => {
    const cut = compiled.truncated.find((t) => t.section === s.name);
    const from = cut === undefined ? "" : ` (cut from ${cut.tokens_before})`;
    return `${s.name} ${s.tokens}${from}`;
  });
  return {
    class: "over_budget",
    message:
      `prompt ${compiled.templateId} is over the ${p.runClass} budget: ${padded} tokens ` +
      `(${tokens} + ${p.marginPct} % margin) > cap ${p.capTokens}; ` +
      `sections, in local tokens: ${sizes.join(", ")}`,
    retryable: false,
    cause: {
      template_id: compiled.templateId,
      run_class: p.runClass,
      cap_tokens: p.capTokens,
      tokens,
      margin_pct: p.marginPct,
      sections: compiled.sections,
      truncated: compiled.truncated,
    },
  };
}
