import { budgetWindow } from "@bayon/core";
import { sql, type SqlBool } from "kysely";
import { qb } from "../connection.js";
import type { NeedsAttentionRow } from "../schema-work.js";

// The one door to v_needs_attention (§4.1; 044). The view reads no clock: a timed arm
// carries the timestamp its wait runs from (`since`) and how long that wait is (`after_ms`), and
// budget_warn, a sum over the window holding now, is not in it. This adds both at `now`, the
// caller's injected clock (a reader passes its Db's, `ix.clock.now()`), so the arms age on the
// same clock as everything else — never on SQLite's own, which a fake clock cannot move.
// Every reader selects `attentionAt(now).as("v")`; attention.test.ts fails any other that selects
// from the raw view, which lists timed rows at any age.

/**
 * budget_warn at `now` (§4.1, §13.4): a budget at warn_pct of a cap or past it. Spent is summed
 * over the UTC day or month holding now — core's budgetWindow, as listBudgets reads it — and within
 * the budget's scope (the fleet, or the agent's sessions). 043's arm, the windows bound.
 */
function budgetWarnAt(now: number) {
  const day = budgetWindow("day", now);
  const month = budgetWindow("month", now);
  return sql<NeedsAttentionRow>`SELECT 'budget_warn' AS why, b.id AS ref, NULL AS ticket_id FROM (
      SELECT bu.id, bu.scope, bu.scope_ref, bu.cap_usd, bu.cap_tokens, bu.warn_pct,
             CASE bu.period WHEN 'day' THEN ${day.start} ELSE ${month.start} END AS window_start,
             CASE bu.period WHEN 'day' THEN ${day.end} ELSE ${month.end} END AS window_end
      FROM budgets bu) b
    LEFT JOIN spend sp ON sp.ts >= b.window_start AND sp.ts < b.window_end
      AND (b.scope = 'fleet'
           OR sp.session_id IN (SELECT s.id FROM sessions s WHERE s.agent_id = b.scope_ref))
    GROUP BY b.id
    HAVING (b.cap_usd IS NOT NULL
            AND coalesce(sum(sp.cost_usd), 0) >= b.cap_usd * b.warn_pct / 100.0)
        OR (b.cap_tokens IS NOT NULL
            AND coalesce(sum(sp.tokens_in + sp.tokens_out), 0) >= b.cap_tokens * b.warn_pct / 100.0)`;
}

/**
 * The rows on v_needs_attention at `now` (epoch ms): each arm's rows past their wait, and the
 * budgets at their warn mark. A subquery: select it `.as("v")` where the view was read.
 */
export function attentionAt(now: number) {
  return qb
    .selectFrom("v_needs_attention")
    .select(["why", "ref", "ticket_id"])
    .where(sql<SqlBool>`(after_ms IS NULL OR since < ${now} - after_ms)`)
    .unionAll(budgetWarnAt(now));
}
