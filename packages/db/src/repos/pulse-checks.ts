import { newId, ok } from "@bayon/core";
import type { Insertable } from "kysely";
import { all, qb, write, type Db, type R } from "../connection.js";
import type { PulseCheckRow, PulseChecksTable } from "../schema-pulse.js";

// pulse_checks' writer (§9.5: the supervisor's). The probe runner returns results and writes
// nothing; the pulse scheduler and the probe.run handler record them here.

/** One probe's result, as the probe runner returns it: the row minus its id and pulse. */
export type NewPulseCheck = Omit<
  Insertable<PulseChecksTable>,
  "id" | "pulse_id"
>;

/** Records `checks` against `pulseId`, one row each, in one transaction. */
export function insertPulseChecks(
  db: Db,
  pulseId: string,
  checks: readonly NewPulseCheck[],
): R<PulseCheckRow[]> {
  if (checks.length === 0) return Promise.resolve(ok([]));
  return write(db, (ix) => {
    const now = ix.clock.now();
    return ok(
      all(
        ix,
        qb
          .insertInto("pulse_checks")
          .values(
            checks.map((c) => ({ ...c, id: newId(now), pulse_id: pulseId })),
          )
          .returningAll(),
      ),
    );
  });
}
