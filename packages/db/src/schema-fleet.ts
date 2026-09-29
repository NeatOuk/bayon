import type { BudgetOnBreach, BudgetPeriod, BudgetScope } from "@bayon/core";
import type { Generated, Selectable } from "kysely";

// Hand-written Kysely types for 012_fleet (M4). schema-columns-fleet.ts restates them at runtime,
// and schema.test.ts checks that against PRAGMA table_info. Conventions as in schema.ts.

/**
 * A spend cap (§4, §13.4; M4 amendment). API-owned: the operator sets it through REST. What it
 * has spent is computed from `spend` at read time (listBudgets), never stored.
 */
export interface BudgetsTable {
  id: string;
  scope: BudgetScope;
  /** The agent of an agent budget; NULL for the fleet. */
  scope_ref: string | null;
  period: BudgetPeriod;
  cap_usd: number | null;
  /** Caps tokens_in + tokens_out. */
  cap_tokens: number | null;
  warn_pct: Generated<number>;
  on_breach: Generated<BudgetOnBreach>;
  updated_at: number;
}

/** How a backup attempt ended (§13.2). */
export type BackupOutcome = "ok" | "failed";

/** One finished backup attempt, the supervisor's to write (M4-k). The newest failed one is backup_failed. */
export interface BackupsTable {
  id: string;
  started_at: number;
  ended_at: number;
  outcome: BackupOutcome;
  /** The encrypted file an ok attempt wrote. */
  path: string | null;
  /** Why a failed attempt failed. */
  error: string | null;
}

/**
 * An operator's dismissal of a finished session's error from the attention strip (019).
 * API-owned: the operator writes it through REST. Only an error exit can be acknowledged — a stale
 * session is a live condition that clears itself — so the session alone is the key.
 */
export interface AttentionAcksTable {
  session_id: string;
  acked_at: number;
  /** Who dismissed it, as audit_log records the same act. */
  acked_by: string;
}

export interface FleetDB {
  budgets: BudgetsTable;
  backups: BackupsTable;
  attention_acks: AttentionAcksTable;
}

export type BudgetRow = Selectable<BudgetsTable>;
export type BackupRow = Selectable<BackupsTable>;
export type AttentionAckRow = Selectable<AttentionAcksTable>;
