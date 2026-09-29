import { err } from "@bayon/core";
import { z } from "zod";
import { all, first, qb, read, type Db, type R } from "../connection.js";
import { failure, orNotFound } from "../errors.js";
import type {
  ProbeRow,
  PulseCheckRow,
  PulseRow,
  PulseState,
} from "../schema-pulse.js";

// Pulse reads (@bayon/db, M2). pulses and pulse_checks are the supervisor's to write (§9.5);
// probes are operator config. Their writers come with the scheduler and the probe runner.

/** The states that hold an agent's single-flight lease: pulses_lease_idx allows one such row. */
export const LIVE_PULSE_STATES = [
  "leased",
  "running",
] as const satisfies readonly PulseState[];

export async function getPulse(db: Db, id: string): R<PulseRow> {
  const found = await read(db, (ix) =>
    first(ix, qb.selectFrom("pulses").selectAll().where("id", "=", id)),
  );
  return orNotFound(found, `pulse ${id}`);
}

/** The agent's live pulse (LIVE_PULSE_STATES), or null. The lease index allows at most one. */
export function findLivePulse(db: Db, agentId: string): R<PulseRow | null> {
  return read(
    db,
    (ix) =>
      first(
        ix,
        qb
          .selectFrom("pulses")
          .selectAll()
          .where("agent_id", "=", agentId)
          .where("state", "in", LIVE_PULSE_STATES),
      ) ?? null,
  );
}

/** The pulse a session runs, or null: how pulse_report and probe_run find the caller's pulse. */
export function findPulseBySession(
  db: Db,
  sessionId: string,
): R<PulseRow | null> {
  return read(
    db,
    (ix) =>
      first(
        ix,
        qb
          .selectFrom("pulses")
          .selectAll()
          .where("session_id", "=", sessionId)
          .orderBy("scheduled_at", "desc")
          .orderBy("id", "desc"),
      ) ?? null,
  );
}

const PulseQueryShape = z.object({
  agent_id: z.string().min(1).optional(),
  limit: z.int().min(1).max(1000),
});
export type PulseQuery = z.input<typeof PulseQueryShape>;

/** Pulses newest first (scheduled_at, then id), optionally one agent's only. */
export async function listPulses(db: Db, query: PulseQuery): R<PulseRow[]> {
  const parsed = PulseQueryShape.safeParse(query);
  if (!parsed.success) {
    return err(
      failure(
        "validation",
        `bad pulse query: ${z.prettifyError(parsed.error)}`,
      ),
    );
  }
  const { agent_id, limit } = parsed.data;
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("pulses")
        .selectAll()
        .$if(agent_id !== undefined, (b) =>
          b.where("agent_id", "=", agent_id ?? ""),
        )
        .orderBy("scheduled_at", "desc")
        .orderBy("id", "desc")
        .limit(limit),
    ),
  );
}

/** The probes by name; `enabledOnly` leaves out the disabled ones. */
export function listProbes(
  db: Db,
  o: { readonly enabledOnly?: boolean } = {},
): R<ProbeRow[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("probes")
        .selectAll()
        .$if(o.enabledOnly === true, (b) => b.where("enabled", "=", 1))
        .orderBy("name"),
    ),
  );
}

export async function getProbe(db: Db, name: string): R<ProbeRow> {
  const found = await read(db, (ix) =>
    first(ix, qb.selectFrom("probes").selectAll().where("name", "=", name)),
  );
  return orNotFound(found, `probe ${name}`);
}

/** A pulse's probe runs in id order: ULIDs, so oldest first. */
export function listPulseChecks(db: Db, pulseId: string): R<PulseCheckRow[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("pulse_checks")
        .selectAll()
        .where("pulse_id", "=", pulseId)
        .orderBy("id"),
    ),
  );
}
