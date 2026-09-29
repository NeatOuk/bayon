// The pulse's budget gate (§13.4; M4-c). M2 read `budget.daily_cap_usd` through getDailyBudget;
// this reads `budgets` — the fleet's and this agent's, over a UTC day or month — through the same
// budgetBreach that admission uses, so a pulse and a spawn agree on what a breach is. Nothing here
// rolls a window: spend is computed at read time, so a breach lifts by itself when the window
// rolls or the cap is raised.
import { budgetBreach, dedupeKey, type SystemHumanRequest } from "@bayon/core";
import { listBudgets, type BudgetStatus, type Db } from "@bayon/db";
import { insertSystemHumanRequest } from "@bayon/db/supervisor";
import type { Log } from "../lifecycle/index.js";
import type { PulseGate } from "./ports.js";

/** What the request offers: the two ways a breach lifts (§13.4). Neither is this pulse's to do. */
const OPTIONS = ["raise the cap", "wait for the window to roll"];

/** The question, naming whose budget it is and what it has spent. */
function question(b: BudgetStatus, detail: string): string {
  const whose = b.scope === "fleet" ? "the fleet" : `agent ${b.scope_ref}`;
  return `A pulse is blocked: ${whose}'s ${b.period} budget is spent (${detail}).`;
}

/**
 * Denies every pulse while a `pause_admission` budget in scope is spent to its cap, recording
 * skipped(over_budget).
 *
 * Two dedupes, deliberately different. The human_request is one per budget and window: its key
 * `budget_pulse:<budget>:<window start>` sits under a unique index (014), so a breach lasting all
 * day asks the operator once, not once a pulse — and it survives a restart, which an in-memory
 * guard would not. The skipped row stays one per agent and window, as M2 recorded one per agent
 * per day: a fleet budget blocks every agent, and `pulses` would otherwise say only the first one
 * was skipped.
 *
 * A budget it cannot read denies too: a pulse is spend.
 */
export function budgetGate(o: {
  readonly db: Db;
  readonly log: Log;
}): PulseGate {
  let recorded: ReadonlySet<string> = new Set();
  return async ({ agentId }) => {
    const budgets = await listBudgets(o.db);
    if (!budgets.ok) {
      o.log.error(
        { agentId, error: budgets.error },
        "pulse gate: cannot read the budgets; no pulse",
      );
      return { allow: false };
    }
    const breach = budgetBreach(budgets.value, agentId);
    if (breach === null) return { allow: true };
    // budgetBreach takes the BudgetFact its own gate reads, so the window comes from the row.
    const budget = budgets.value.find((b) => b.id === breach.budget.id);
    if (budget === undefined) {
      o.log.error(
        { agentId, budgetId: breach.budget.id },
        "pulse gate: the breached budget vanished from its own list; no pulse",
      );
      return { allow: false };
    }

    const request: SystemHumanRequest = {
      rule: "budget_pulse",
      subject: budget.id,
      window: String(budget.window_start),
      question: question(budget, breach.detail),
      context_md: "",
      options: OPTIONS,
    };
    const filed = await insertSystemHumanRequest(o.db, request);
    if (!filed.ok) {
      // The request is how the operator learns of this; losing it must not lose the refusal too.
      o.log.error(
        { agentId, budgetId: budget.id, error: filed.error },
        "pulse gate: the budget is spent and its human_request could not be filed",
      );
    } else if (filed.value.created) {
      o.log.warn(
        { agentId, budgetId: budget.id, key: dedupeKey(request) },
        "pulse gate: the budget is spent; asked the operator and skipped the pulse",
      );
    }

    const seen = `${agentId}:${budget.id}:${budget.window_start}`;
    if (recorded.has(seen)) return { allow: false };
    recorded = new Set([...recorded, seen]);
    return { allow: false, record: "over_budget" };
  };
}
