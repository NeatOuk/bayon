import { err, ok } from "@bayon/core";
import {
  execute,
  first,
  qb,
  read,
  write,
  type Db,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import { insertAudit } from "./audit.js";
import { storedJson } from "./fleet-control.js";
import { DAILY_CAP_KEY, DailyCap } from "./fleet-overview.js";

// The operator's daily budget cap (§12.1 GET/PUT /settings; amendment 8): the API's read and its
// only write. getFleetOverview reads the same settings row for the Fleet snapshot.

/** The daily cap in `settings.budget.daily_cap_usd`; a missing row or null both mean no cap. */
export async function getBudgetCap(db: Db): R<number | null> {
  const found = await read(db, (ix) =>
    first(
      ix,
      qb
        .selectFrom("settings")
        .select("value_json")
        .where("key", "=", DAILY_CAP_KEY),
    ),
  );
  if (!found.ok) return found;
  if (found.value === undefined) return ok(null);
  let value: unknown;
  try {
    value = JSON.parse(found.value.value_json);
  } catch {
    return err(failure("internal", `${DAILY_CAP_KEY} is not JSON`));
  }
  const cap = DailyCap.safeParse(value);
  return cap.success
    ? ok(cap.data)
    : err(
        failure(
          "internal",
          `${DAILY_CAP_KEY} must be a non-negative number or null`,
        ),
      );
}

/**
 * Sets the daily cap, stamped by the clock; null clears it (no cap). Rejects anything that is not
 * a finite non-negative number or null (NaN, Infinity, a negative number, or the wrong type)
 * before it ever reaches SQL, and returns the value as stored.
 *
 * Audited in the same transaction as the settings row, the way fleet-control.ts audits
 * its own: the cap is the one control that stops runaway spend, so raising or clearing it must
 * leave a trace of who did it and what it was before. A cap already at its value writes neither
 * row, matching putOperatorSettings — an unchanged value is not a change to audit.
 */
export async function setBudgetCap(
  db: Db,
  usd: number | null,
  /** Who: `operator`. */
  actor: string,
): R<number | null> {
  const parsed = DailyCap.safeParse(usd);
  if (!parsed.success) {
    return err(
      failure(
        "validation",
        `daily cap must be a non-negative number or null, not ${JSON.stringify(usd)}`,
      ),
    );
  }
  if (actor.trim() === "") {
    return err(failure("validation", "a budget cap change needs an actor"));
  }
  return write(db, (ix) => {
    const value_json = JSON.stringify(parsed.data);
    const row = first(
      ix,
      qb
        .selectFrom("settings")
        .select("value_json")
        .where("key", "=", DAILY_CAP_KEY),
    );
    if (row?.value_json === value_json) return ok(parsed.data);
    const updated_at = ix.clock.now();
    execute(
      ix,
      qb
        .insertInto("settings")
        .values({ key: DAILY_CAP_KEY, value_json, updated_at })
        .onConflict((oc) =>
          oc.column("key").doUpdateSet({ value_json, updated_at }),
        ),
    );
    const audit = insertAudit(ix, {
      actor,
      action: "budget.put",
      target_kind: "setting",
      target_id: DAILY_CAP_KEY,
      payload: {
        via: "rest",
        from: row === undefined ? null : storedJson(row.value_json),
        to: parsed.data,
      },
    });
    if (!audit.ok) return audit;
    return ok(parsed.data);
  });
}
