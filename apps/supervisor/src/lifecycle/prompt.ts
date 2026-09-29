// A run's prompt (§8.2–§8.4), one path for run 1 and run n: compiled through a versioned template,
// fitted to the cap less the pre-flight margin, then counted and held to the cap.
import {
  TEMPLATES,
  compile,
  ok,
  preflight,
  promptBudget,
  type CompiledPrompt,
  type PromptInputs,
  type PromptTemplate,
  type Result,
  type RunClass,
  type RunTrigger,
  type SessionState,
  type TurnKind,
} from "@bayon/core";
import type { RunRow } from "@bayon/db";
import type { RunnerAdapter } from "@bayon/runners";
import type { Ctx } from "./context.js";

/** What opens run n: a template and its inputs, compiled at start, never concatenated. */
export interface RunRequest {
  /** The run's number, the session's last + 1. Its idempotency key is `<session id>:<seq>`. */
  readonly seq: number;
  readonly trigger: RunTrigger;
  readonly template: PromptTemplate;
  readonly inputs: PromptInputs;
  /** The prompt's token cap. Default: the session's run class context_tokens_cap (0: n/a). */
  readonly capTokens?: number;
  /**
   * The state the session must be in for the run to start. Default idle, and then the run moves
   * the session (idle → running → idle). A run started in any other state (a hand-off request
   * inside handoff_writing) leaves the session's state to its caller, whether it ends or fails.
   */
  readonly within?: SessionState;
  /** This run's wall clock, overriding the run class's. */
  readonly wallClockMs?: number;
  /**
   * Which run a live session starts, passed explicitly, never inferred from
   * `seq`: `run`, the default, is held to mayStartTurn; a spawn's `first` run and a `handoff`
   * packet never are.
   */
  readonly turn?: TurnKind;
  /**
   * Structured output (M3 contracts, SendSpec.output): the run's final answer, valid against
   * `schema`, goes to `outputFile(paths, seq)`, which startRun creates the directory for. Only a
   * runner declaring `outputSchema` honours it.
   */
  readonly output?: { readonly schema: Readonly<Record<string, unknown>> };
  /**
   * Told once the run has ended, with the run as stored: its terminal committed, or its wall clock
   * ran out (state `timeout`, once its process is torn down). Not called when startRun refuses.
   */
  readonly onEnded?: (run: RunRow) => void;
}

export interface CompiledRun {
  readonly compiled: CompiledPrompt;
  /** `runs.prompt_tokens_est`. */
  readonly tokens: number;
}

/** Compiles `req` and holds it to its cap: an over-budget prompt is `over_budget`, never sent. */
export async function compileRun(
  ctx: Ctx,
  adapter: RunnerAdapter,
  runClass: RunClass,
  req: RunRequest,
): Promise<Result<CompiledRun>> {
  const capTokens = req.capTokens ?? runClass.context_tokens_cap;
  const marginPct = ctx.settings["preflight.margin_pct"];
  const compiled = compile(req.template, req.inputs, {
    maxTokens: promptBudget(capTokens, marginPct),
  });
  if (!compiled.ok) return compiled;
  const counting = adapter.caps().tokenCounting;
  const counted = await preflight({
    compiled: compiled.value,
    runClass: runClass.name,
    capTokens,
    marginPct,
    ...(counting
      ? { estimate: (text: string) => adapter.estimateTokens(text) }
      : {}),
  });
  if (!counted.ok) return counted;
  if (counting && counted.value.counter === "local") {
    ctx.log.warn(
      { runnerId: adapter.id },
      "the runner did not count the prompt: pre-flight used the local approximation",
    );
  }
  return ok({ compiled: compiled.value, tokens: counted.value.tokens });
}

/** Run 1 of an operator spawn: the operator's prompt through the `operator` template. */
export const operatorRun = (
  task: string,
  mission: string | null,
): RunRequest => ({
  seq: 1,
  trigger: "operator",
  template: TEMPLATES.operator,
  inputs: { task, mission: mission ?? undefined },
});
