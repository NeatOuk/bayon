// A run's spend row (§8.9) from its winning terminal: the runner's per-run delta when it reports
// one, else core's usage fields, else zero (a supervisor-written terminal knows no spend). A run
// whose model calls went through the context proxy (spec M12) carries its totals as
// `payload.context`: its large tool output and what compression saved, estimated at chars/4.
import { ContextTotals, type RunState } from "@bayon/core";
import type { SessionRow } from "@bayon/db";
import type { NewSpend } from "@bayon/db/supervisor";
import { z } from "zod";

/** The model of a spend row whose runner named none and whose session has none. */
export const UNKNOWN_MODEL = "unknown";

/** §8.9: a run that failed or timed out bought nothing, so its spend is wasted. */
const WASTED_RUNS: ReadonlySet<RunState> = new Set(["failed", "timeout"]);

const count = z.int().nonnegative();
const usd = z.number().nonnegative();
const Tokens = z.object({
  tokens_in: count,
  tokens_out: count,
  tokens_cache_read: count,
  tokens_cache_write: count,
});
/** `terminal.payload.spend`, as the runners write it (a delta of their running totals). */
const WithSpend = z.looseObject({
  spend: Tokens.extend({
    cost_usd: usd,
    cost_source: z.enum(["reported", "estimated"]),
    model: z.string().min(1).optional(),
  }),
});
/** `terminal.payload.context` (core ContextTotals), when the run was proxied. */
const WithContext = z.looseObject({ context: ContextTotals });

/** The chars/4 token estimate the context totals are measured in (spec M12). */
export const CHARS_PER_TOKEN = 4;

/**
 * The run's large tool output (`tokens_tool_result`, §8.5's share) and the part compression kept
 * out of the model's input (`tokens_saved`), as estimated tokens; both null when it was not proxied.
 */
export function contextTokens(payload: unknown): {
  readonly tokens_tool_result: number | null;
  readonly tokens_saved: number | null;
} {
  const parsed = WithContext.safeParse(payload);
  if (!parsed.success) return { tokens_tool_result: null, tokens_saved: null };
  const { chars_in, chars_out } = parsed.data.context;
  return {
    tokens_tool_result: Math.round(chars_in / CHARS_PER_TOKEN),
    tokens_saved: Math.round(
      Math.max(0, chars_in - chars_out) / CHARS_PER_TOKEN,
    ),
  };
}

/** Core's terminal fields, for a runner that reports usage without a spend block. */
const WithUsage = z.looseObject({ usage: Tokens, cost_usd: usd.optional() });

type Totals = z.infer<typeof Tokens> & {
  readonly cost_usd: number;
  readonly cost_source: "reported" | "estimated";
  readonly model?: string;
};

const NOTHING: Totals = {
  tokens_in: 0,
  tokens_out: 0,
  tokens_cache_read: 0,
  tokens_cache_write: 0,
  cost_usd: 0,
  cost_source: "estimated",
};

function totalsOf(payload: unknown): Totals {
  const spend = WithSpend.safeParse(payload);
  if (spend.success) return spend.data.spend;
  const usage = WithUsage.safeParse(payload);
  if (usage.success) {
    return {
      ...usage.data.usage,
      cost_usd: usage.data.cost_usd ?? 0,
      cost_source: "reported",
    };
  }
  return NOTHING;
}

export function spendRow(o: {
  readonly runId: string;
  readonly session: SessionRow;
  readonly terminalPayload: unknown;
  /** The run's verdict, `runs.state`, which a run timer may have set before the terminal. */
  readonly runState: RunState;
  /** The pulse the run served (`spend.pulse_id`), or null. */
  readonly pulseId: string | null;
}): NewSpend {
  const t = totalsOf(o.terminalPayload);
  const input = t.tokens_in + t.tokens_cache_read + t.tokens_cache_write;
  return {
    run_id: o.runId,
    session_id: o.session.id,
    ticket_id: o.session.ticket_id,
    pulse_id: o.pulseId,
    phase: o.session.run_class,
    runner_id: o.session.runner_id,
    model: t.model ?? o.session.model ?? UNKNOWN_MODEL,
    tokens_in: t.tokens_in,
    tokens_out: t.tokens_out,
    tokens_cache_read: t.tokens_cache_read,
    tokens_cache_write: t.tokens_cache_write,
    ...contextTokens(o.terminalPayload),
    cost_usd: t.cost_usd,
    cost_source: t.cost_source,
    cache_hit_ratio: input === 0 ? null : t.tokens_cache_read / input,
    wasted: WASTED_RUNS.has(o.runState) ? 1 : 0,
  };
}
