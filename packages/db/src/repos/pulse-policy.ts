import { err, ok } from "@bayon/core";
import { z } from "zod";
import { first, qb, write, type Db, type R } from "../connection.js";
import { failure } from "../errors.js";
import type { AgentRow } from "../schema.js";
import { audited, type AuditEntry } from "./audit.js";

// PATCH /agents/:id/pulse-policy (§12.1): the API's write to the agents' pulse_* columns (plan M2
// contracts). The scheduler re-reads the policy on every tick, so a change lands within a
// minute. The proto schema carries the operator-facing bounds; this guards the columns.

const nonNegative = z.int().nonnegative();

const PulsePolicyShape = z
  .strictObject({
    mode: z.enum(["interval", "on_idle", "hybrid", "manual"]).optional(),
    interval_ms: z.int().positive().optional(),
    debounce_ms: nonNegative.optional(),
    min_gap_ms: nonNegative.optional(),
    max_per_hour: z.int().positive().optional(),
    jitter_pct: z.int().min(0).max(100).optional(),
  })
  .refine(
    (p) => Object.values(p).some((v) => v !== undefined),
    "a pulse policy change sets at least one field",
  );
export type PulsePolicyUpdate = z.input<typeof PulsePolicyShape>;

/** Sets the given pulse_* columns of one agent and returns its row; an unknown agent is not_found. */
export async function setPulsePolicy(
  db: Db,
  agentId: string,
  update: PulsePolicyUpdate,
  /** The operator's audit entry, committed with the write. */
  audit?: AuditEntry,
): R<AgentRow> {
  const parsed = PulsePolicyShape.safeParse(update);
  if (!parsed.success) {
    return err(
      failure(
        "validation",
        `bad pulse policy: ${z.prettifyError(parsed.error)}`,
      ),
    );
  }
  const p = parsed.data;
  const columns = {
    ...(p.mode === undefined ? {} : { pulse_mode: p.mode }),
    ...(p.interval_ms === undefined
      ? {}
      : { pulse_interval_ms: p.interval_ms }),
    ...(p.debounce_ms === undefined
      ? {}
      : { pulse_debounce_ms: p.debounce_ms }),
    ...(p.min_gap_ms === undefined ? {} : { pulse_min_gap_ms: p.min_gap_ms }),
    ...(p.max_per_hour === undefined
      ? {}
      : { pulse_max_per_hour: p.max_per_hour }),
    ...(p.jitter_pct === undefined ? {} : { pulse_jitter_pct: p.jitter_pct }),
  };
  return write(db, (ix) => {
    const row = first(
      ix,
      qb
        .updateTable("agents")
        .set(columns)
        .where("id", "=", agentId)
        .returningAll(),
    );
    return audited(
      ix,
      row === undefined
        ? err(failure("not_found", `agent ${agentId} does not exist`))
        : ok(row),
      audit,
    );
  });
}
