// `frm executor disable|enable <id>`: a named writer for `executors.enabled`, the
// kill switch admission already honours (§9.1's `disabled` gate) and the disk view already filters
// on, which until now nothing but the INSERT in `frm executor add` could write. Through
// @bayon/db/operator, Invariant 5's one exception, beside setExecutorConfig. One transaction: the
// column, its audit row (the operator's, via frm) and the count of live sessions it leaves alone.
//
// It writes that one column and nothing else. Disabling is not decertifying: `runner_certifications`
// and `conformance_probes` are untouched, so re-enabling restores the executor exactly as it was —
// which is the whole point of disable being the reversible half (removal is out of scope, §9.5:
// every label-scoped object on a shared host is keyed to the registration).
import { err, ok, type Result } from "@bayon/core";
import {
  execute,
  first,
  qb,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import { insertAudit } from "./audit.js";
import { ENDED_STATES } from "./sessions.js";

export interface ExecutorEnabledChange {
  readonly id: string;
  /** What `executors.enabled` reads now. */
  readonly enabled: boolean;
  /** False when it already read that: nothing was written or audited. */
  readonly changed: boolean;
  /**
   * Sessions on it that have not ended (ENDED_STATES, as v_fleet spells them) when this was
   * written. A disable refuses new admissions only; these keep running and are reported, never
   * touched (§9.5: the supervisor owns `sessions`).
   */
  readonly live: number;
}

/** Live sessions placed on `id`: the ones a disable leaves alone. */
function liveSessions(ix: Internals, id: string): number {
  const row = first(
    ix,
    qb
      .selectFrom("sessions")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("executor_id", "=", id)
      .where("state", "not in", ENDED_STATES),
  );
  return row?.n ?? 0;
}

function writeEnabled(
  ix: Internals,
  id: string,
  enabled: boolean,
): Result<ExecutorEnabledChange> {
  const row = first(
    ix,
    qb.selectFrom("executors").select("enabled").where("id", "=", id),
  );
  if (row === undefined) {
    return err(failure("not_found", `executor ${id} does not exist`));
  }
  const live = liveSessions(ix, id);
  const next = enabled ? 1 : 0;
  if (row.enabled === next) {
    return ok({ id, enabled, changed: false, live });
  }
  execute(
    ix,
    qb.updateTable("executors").set({ enabled: next }).where("id", "=", id),
  );
  const audit = insertAudit(ix, {
    actor: "operator",
    action: enabled ? "executor.enable" : "executor.disable",
    target_kind: "executor",
    target_id: id,
    payload: { via: "frm", from: row.enabled === 1, to: enabled, live },
  });
  return audit.ok ? ok({ id, enabled, changed: true, live }) : audit;
}

/**
 * Enables or disables an executor, audited as the operator's via frm. A disabled one refuses new
 * spawns (admission's `disabled` gate names it) and is left out of the disk view; the sessions
 * already on it are only counted. The same state again writes nothing and audits nothing, and
 * still reports the count. An unknown id is `not_found`, an unnamed one `validation`; either way
 * nothing is written.
 */
export function setExecutorEnabledFromCli(
  db: Db,
  id: string,
  enabled: boolean,
): R<ExecutorEnabledChange> {
  if (id.trim() === "") {
    return Promise.resolve(
      err(failure("validation", "executor enable: name the executor")),
    );
  }
  return write(db, (ix) => writeEnabled(ix, id, enabled));
}
