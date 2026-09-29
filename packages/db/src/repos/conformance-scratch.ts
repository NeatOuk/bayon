// The conformance suite's scratch database (the supervisor's real ingest on a
// scratch DB): the agent its sessions hang off. Never the system of record, where agents are the
// operator's config: a database that already holds a session is refused.
import { err, ok } from "@bayon/core";
import { execute, first, qb, write, type Db, type R } from "../connection.js";
import { failure } from "../errors.js";

export interface ScratchIdentity {
  readonly agent_id: string;
  /** Registered already (upsertRegistration), as is the executor (upsertExecutor). */
  readonly runner_id: string;
  readonly executor_id: string;
}

export function seedConformanceScratch(db: Db, s: ScratchIdentity): R<void> {
  return write(db, (ix) => {
    const used = first(ix, qb.selectFrom("sessions").select("id").limit(1));
    if (used !== undefined) {
      return err(
        failure("validation", "not a scratch database: it holds sessions"),
      );
    }
    execute(
      ix,
      qb.insertInto("agents").values({
        id: s.agent_id,
        name: s.agent_id,
        kind: "util",
        runner_id: s.runner_id,
        executor_id: s.executor_id,
        created_at: ix.clock.now(),
      }),
    );
    return ok(undefined);
  });
}
