// Wires the QA checker into a running supervisor, the lint checker's shape: no command
// handler and no timer, since the gate engine starts it from a `qa_harness` gate `pass_review`
// opened. All that is left is its runner row, which `registrations()` cannot produce -- that only
// knows packages/runners' own FACTORIES map (Invariant 1) -- so its adapter's rows go in with a
// second, equally idempotent upsertBootRows call.
//
// Its agent, profile and run class are operator rows (§4: config over code), seeded by
// `frm config apply`; without them the gate fails `no_reviewer` with a readable detail rather than
// running as somebody else.
import type { RunnerAdapter } from "@bayon/runners";
import type { Db } from "@bayon/db";
import type { Result } from "@bayon/core";
import { upsertBootRows } from "../boot.js";

/** Upserts the QA job's runner and model rows. Idempotent: every boot runs it. */
export const registerQaRunner = (
  db: Db,
  qaAdapter: RunnerAdapter,
): Promise<Result<void>> =>
  upsertBootRows(db, { registrations: [qaAdapter.registration()] });
