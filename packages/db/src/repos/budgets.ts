import {
  BudgetOnBreach,
  BudgetPeriod,
  BudgetScope,
  budgetWindow,
  err,
  newId,
  ok,
  type BudgetWindow,
  type JsonValue,
  type Result,
} from "@bayon/core";
import { sql } from "kysely";
import { z } from "zod";
import { allOk, check } from "../checks.js";
import {
  all,
  first,
  qb,
  read,
  returningOne,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import type { BudgetRow } from "../schema-fleet.js";
import { insertAudit } from "./audit.js";

// budgets (§4, §13.4; M4 amendment): API-owned config that the operator sets through REST (§12.1
// GET/PUT/DELETE /budgets), each write audited in its transaction. What a budget has spent is
// computed here at read time from `spend`, over the UTC day or month holding the Db's clock and
// within its scope; nothing stores it. The budget_warn attention arm (attentionAt, 044) computes
// the same sums over the same windows of the same clock.

/** Why `on_breach: 'kill'` is refused: §13.4's kill is deferred past M4. */
export const KILL_DEFERRED =
  "on_breach 'kill' is refused: it is deferred past M4 (§13.4)";

/** PUT /budgets: one budget per scope and period, replaced whole. */
export interface BudgetPut {
  readonly scope: string;
  /** The agent id of an agent budget; omitted or null for the fleet. */
  readonly scope_ref?: string | null;
  readonly period: string;
  readonly cap_usd?: number | null;
  /** Caps tokens_in + tokens_out. */
  readonly cap_tokens?: number | null;
  /** Omitted: the column default (70). */
  readonly warn_pct?: number;
  /** Omitted: the column default (pause_admission). `kill` is refused. */
  readonly on_breach?: string;
}

/** A budget with what it has spent in its current window, computed at read time. */
export interface BudgetStatus extends BudgetRow {
  readonly window_start: number;
  readonly window_end: number;
  readonly spent_usd: number;
  /** tokens_in + tokens_out. */
  readonly spent_tokens: number;
}

const Put = z.object({
  scope: BudgetScope,
  scope_ref: z.string().min(1).nullable(),
  period: BudgetPeriod,
  cap_usd: z.number().nonnegative().nullable(),
  cap_tokens: z.int().nonnegative().nullable(),
  warn_pct: z.int().min(1).max(100).optional(),
  on_breach: BudgetOnBreach.optional(),
});
type Put = z.infer<typeof Put>;

function parsePut(b: BudgetPut, by: string): Result<Put> {
  if (b.on_breach === "kill") return err(failure("validation", KILL_DEFERRED));
  const parsed = Put.safeParse({
    ...b,
    scope_ref: b.scope_ref ?? null,
    cap_usd: b.cap_usd ?? null,
    cap_tokens: b.cap_tokens ?? null,
  });
  if (!parsed.success) {
    const why = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    return err(failure("validation", `invalid budget: ${why}`));
  }
  const p = parsed.data;
  const checked = allOk(
    check(
      (p.scope === "fleet") === (p.scope_ref === null),
      "a fleet budget names no scope_ref, and an agent budget names its agent",
    ),
    check(
      p.cap_usd !== null || p.cap_tokens !== null,
      "a budget needs cap_usd, cap_tokens or both",
    ),
    check(by.trim().length > 0, "a budget write needs an actor"),
  );
  return checked.ok ? ok(p) : checked;
}

/** What an audit row records of a budget. */
const describe = (b: BudgetRow): JsonValue => ({
  scope: b.scope,
  scope_ref: b.scope_ref,
  period: b.period,
  cap_usd: b.cap_usd,
  cap_tokens: b.cap_tokens,
  warn_pct: b.warn_pct,
  on_breach: b.on_breach,
});

function agentExists(ix: Internals, id: string | null): Result<void> {
  if (id === null) return ok(undefined);
  const found = first(
    ix,
    qb.selectFrom("agents").select("id").where("id", "=", id),
  );
  return found === undefined
    ? err(failure("not_found", `agent ${id} does not exist`))
    : ok(undefined);
}

/**
 * Creates or replaces the budget for its scope and period, keeping its id, and audits it as
 * `budget.put` in the same transaction. Refuses `kill` (deferred past M4).
 */
export async function putBudget(
  db: Db,
  b: BudgetPut,
  /** Who set it: `operator`. */
  by: string,
): R<BudgetStatus> {
  const parsed = parsePut(b, by);
  if (!parsed.ok) return parsed;
  const p = parsed.value;
  return write(db, (ix) => {
    const agent = agentExists(ix, p.scope_ref);
    if (!agent.ok) return agent;
    const now = ix.clock.now();
    const row = returningOne(
      ix,
      qb
        .insertInto("budgets")
        .values({
          id: newId(now),
          scope: p.scope,
          scope_ref: p.scope_ref,
          period: p.period,
          cap_usd: p.cap_usd,
          cap_tokens: p.cap_tokens,
          ...(p.warn_pct === undefined ? {} : { warn_pct: p.warn_pct }),
          ...(p.on_breach === undefined ? {} : { on_breach: p.on_breach }),
          updated_at: now,
        })
        // budgets_scope_idx: the scope and period's budget is replaced, its id kept. An omitted
        // warn_pct or on_breach takes the column default through `excluded`.
        .onConflict((oc) =>
          oc
            .expression(sql`scope, coalesce(scope_ref, ''), period`)
            .doUpdateSet((eb) => ({
              cap_usd: eb.ref("excluded.cap_usd"),
              cap_tokens: eb.ref("excluded.cap_tokens"),
              warn_pct: eb.ref("excluded.warn_pct"),
              on_breach: eb.ref("excluded.on_breach"),
              updated_at: eb.ref("excluded.updated_at"),
            })),
        )
        .returningAll(),
    );
    if (!row.ok) return row;
    const audit = insertAudit(ix, {
      actor: by,
      action: "budget.put",
      target_kind: "budget",
      target_id: row.value.id,
      payload: describe(row.value),
    });
    // The spend in the same transaction as the write: what comes back is exactly what a read
    // right after it would see, with no window for another writer in between.
    return audit.ok
      ? ok(withSpend(ix, row.value, budgetWindow(row.value.period, now)))
      : audit;
  });
}

/** Deletes a budget and audits it as `budget.delete`; a missing one is not_found. */
export async function deleteBudget(
  db: Db,
  id: string,
  by: string,
): R<BudgetStatus> {
  const checked = check(by.trim().length > 0, "a budget write needs an actor");
  if (!checked.ok) return checked;
  return write(db, (ix) => {
    const row = first(
      ix,
      qb.deleteFrom("budgets").where("id", "=", id).returningAll(),
    );
    if (row === undefined) {
      return err(failure("not_found", `budget ${id} does not exist`));
    }
    const audit = insertAudit(ix, {
      actor: by,
      action: "budget.delete",
      target_kind: "budget",
      target_id: id,
      payload: describe(row),
    });
    // What the budget had spent when it was deleted: the row is gone after this transaction, so
    // this is the caller's only chance to see it.
    return audit.ok
      ? ok(withSpend(ix, row, budgetWindow(row.period, ix.clock.now())))
      : audit;
  });
}

/** Spend in `w` within the budget's scope: all of it for the fleet, the agent's sessions' else. */
function withSpend(ix: Internals, b: BudgetRow, w: BudgetWindow): BudgetStatus {
  // scope_ref is NULL exactly for a fleet budget (a CHECK in 012_fleet).
  const agentId = b.scope_ref;
  const inWindow = qb
    .selectFrom("spend as sp")
    .select((eb) => [
      eb.fn.sum<number | null>("sp.cost_usd").as("usd"),
      eb.fn
        .sum<number | null>(eb("sp.tokens_in", "+", eb.ref("sp.tokens_out")))
        .as("tokens"),
    ])
    .where("sp.ts", ">=", w.start)
    .where("sp.ts", "<", w.end);
  const scoped =
    agentId === null
      ? inWindow
      : inWindow.where((eb) =>
          eb(
            "sp.session_id",
            "in",
            eb
              .selectFrom("sessions as s")
              .select("s.id")
              .where("s.agent_id", "=", agentId),
          ),
        );
  const sums = first(ix, scoped);
  return {
    ...b,
    window_start: w.start,
    window_end: w.end,
    spent_usd: sums?.usd ?? 0,
    spent_tokens: sums?.tokens ?? 0,
  };
}

/**
 * Every budget with its spend, inside the caller's transaction, so a read that wants budgets
 * beside other rows (the Fleet overview) sees one snapshot rather than two.
 */
export function budgetsIn(ix: Internals): BudgetStatus[] {
  const now = ix.clock.now();
  return all(
    ix,
    qb
      .selectFrom("budgets")
      .selectAll()
      .orderBy("scope")
      .orderBy("scope_ref")
      .orderBy("period"),
  ).map((b) => withSpend(ix, b, budgetWindow(b.period, now)));
}

/** Every budget with its spend in the window holding the Db's clock, by scope, agent and period. */
export function listBudgets(db: Db): R<BudgetStatus[]> {
  return read(db, (ix) => budgetsIn(ix));
}
