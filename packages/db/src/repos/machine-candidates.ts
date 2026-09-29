import { MACHINE_STATUSES, err } from "@bayon/core";
import { z } from "zod";
import { all, qb, read, type Db, type R } from "../connection.js";
import { failure } from "../errors.js";

// The reconciler's machine-step sweep reads this: tickets resting in a status a gate
// decides, with no gate of theirs running, oldest update first. A decision takes its machine step
// in its own transaction; the sweep is for the steps no decision will come to take — the operator
// waived the last failed gate, a ticket came back from blocked after its gates decided, a restart
// fell between the two. Keyset-paged on (updated_at, id), so a fleet with more resting tickets than
// one tick's cap still has every ticket looked at in turn, rather than the same oldest ones for ever.

/** Where the previous page ended: the last ticket it returned. */
export interface MachineCursor {
  readonly updated_at: number;
  readonly id: string;
}

export interface MachineCandidate extends MachineCursor {
  readonly status: string;
}

const Query = z.object({
  limit: z.int().min(1).max(1_000),
  after: z.object({ updated_at: z.int(), id: z.string().min(1) }).nullable(),
});

/** Up to `limit` resting tickets after `after` (null: from the start), by updated_at then id. */
export async function listMachineCandidates(
  db: Db,
  q: { readonly limit: number; readonly after: MachineCursor | null },
): R<MachineCandidate[]> {
  const parsed = Query.safeParse(q);
  if (!parsed.success) {
    return err(
      failure(
        "validation",
        `listMachineCandidates: ${z.prettifyError(parsed.error)}`,
      ),
    );
  }
  const { limit, after } = parsed.data;
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("tickets as t")
        .select(["t.id", "t.status", "t.updated_at"])
        .where("t.status", "in", [...MACHINE_STATUSES])
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom("gates as g")
                .select("g.id")
                .whereRef("g.ticket_id", "=", "t.id")
                .where("g.state", "=", "running"),
            ),
          ),
        )
        .$call((b) =>
          after === null
            ? b
            : b.where((eb) =>
                eb.or([
                  eb("t.updated_at", ">", after.updated_at),
                  eb.and([
                    eb("t.updated_at", "=", after.updated_at),
                    eb("t.id", ">", after.id),
                  ]),
                ]),
              ),
        )
        .orderBy("t.updated_at")
        .orderBy("t.id")
        .limit(limit),
    ),
  );
}
