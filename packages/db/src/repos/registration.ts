import { ok } from "@bayon/core";
import type { Insertable } from "kysely";
import { all, execute, qb, write, type Db, type R } from "../connection.js";
import type { ExecutorsTable, ModelsTable, RunnersTable } from "../schema.js";

/** A runner row as its adapter's registration() describes it. Conformance and enabled are the operator's. */
export type NewRunner = Omit<
  Insertable<RunnersTable>,
  | "conformance_version"
  | "conformance_passed_at"
  | "conformance_report_path"
  | "enabled"
>;
export type NewModel = Omit<
  Insertable<ModelsTable>,
  "runner_id" | "active" | "retired_at" | "source" | "settings_json"
>;
export type NewExecutor = Omit<
  Insertable<ExecutorsTable>,
  "health" | "health_checked_at" | "health_detail" | "enabled"
>;

export interface Registration {
  readonly runner: NewRunner;
  readonly models: readonly NewModel[];
}

/**
 * Upserts a runner and its models at supervisor boot (amendment 4). It keeps the runner's
 * conformance_* and enabled. Models it no longer lists are retired (active=0, retired_at), never
 * deleted. A listed row on standby (050) is written inactive and stays registered; two
 * listed rows of one tier that are not on standby is a conflict.
 *
 * The source rule (046): only `source='adapter'` rows are the registration's. A listed id
 * that an operator row holds is skipped — never overwritten, retired or deactivated — and a listed
 * model stays inactive while an operator row is active in its (runner, tier): the operator replaced
 * it. models_tier_idx therefore still holds one active row per (runner, tier).
 */
export function upsertRegistration(db: Db, r: Registration): R<void> {
  return write(db, (ix) => {
    const now = ix.clock.now();
    const { id: runnerId, ...runner } = r.runner;
    execute(
      ix,
      qb
        .insertInto("runners")
        .values({ id: runnerId, ...runner })
        .onConflict((oc) => oc.column("id").doUpdateSet(runner)),
    );
    // Retire and deactivate before upserting: models_tier_idx allows one active model per
    // (runner, tier), so upserting over live rows could trip it midway, e.g. in a tier swap.
    execute(
      ix,
      qb
        .updateTable("models")
        .set({ retired_at: now })
        .where("runner_id", "=", runnerId)
        .where("source", "=", "adapter")
        .where("active", "=", 1)
        .where(
          "id",
          "not in",
          r.models.map((m) => m.id),
        ),
    );
    execute(
      ix,
      qb
        .updateTable("models")
        .set({ active: 0 })
        .where("runner_id", "=", runnerId)
        .where("source", "=", "adapter"),
    );
    const operatorRows = all(
      ix,
      qb
        .selectFrom("models")
        .select(["id", "tier", "active"])
        .where("runner_id", "=", runnerId)
        .where("source", "=", "operator"),
    );
    const operatorIds = new Set(operatorRows.map((m) => m.id));
    const operatorTiers = new Set(
      operatorRows.filter((m) => m.active === 1).map((m) => m.tier),
    );
    for (const { id, ...model } of r.models) {
      if (operatorIds.has(id)) continue;
      const standby = model.standby ?? 0;
      const row = {
        ...model,
        runner_id: runnerId,
        active: operatorTiers.has(model.tier) || standby === 1 ? 0 : 1,
        retired_at: null,
        source: "adapter" as const,
        // Written every boot: a row that leaves standby must not keep a stored 1.
        standby,
      };
      // An id held by another runner's operator row is not this runner's to take over.
      execute(
        ix,
        qb
          .insertInto("models")
          .values({ id, ...row })
          .onConflict((oc) =>
            oc
              .column("id")
              .doUpdateSet(row)
              .where("models.source", "=", "adapter"),
          ),
      );
    }
    return ok(undefined);
  });
}

/**
 * Upserts an executor row; health and enabled are left as they are. `slots` is written only when
 * the row is first inserted: after that the capacity is the operator's, and boot never overwrites
 * it.
 */
export function upsertExecutor(db: Db, e: NewExecutor): R<void> {
  return write(db, (ix) => {
    const { id, slots, ...executor } = e;
    execute(
      ix,
      qb
        .insertInto("executors")
        .values({ id, slots, ...executor })
        .onConflict((oc) => oc.column("id").doUpdateSet(executor)),
    );
    return ok(undefined);
  });
}
