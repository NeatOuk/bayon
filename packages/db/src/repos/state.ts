// supervisor_state as a key → JSON store the supervisor owns (§9.5), e.g. ingest's durable run
// bindings. The heartbeat (fleet.ts) lives in the same table under HEARTBEAT_KEY.
import { canonicalJson, err, ok, type JsonValue } from "@bayon/core";
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

const badKey = (key: string) =>
  err(
    failure(
      "validation",
      `supervisor_state key must be non-empty, not "${key}"`,
    ),
  );

/** Stores `value` under `key`, replacing any earlier value. */
export async function setSupervisorState(
  db: Db,
  key: string,
  value: JsonValue,
): R<void> {
  if (key.length === 0) return badKey(key);
  const value_json = canonicalJson(value);
  return write(db, (ix) => {
    const updated_at = ix.clock.now();
    execute(
      ix,
      qb
        .insertInto("supervisor_state")
        .values({ key, value_json, updated_at })
        .onConflict((oc) =>
          oc.column("key").doUpdateSet({ value_json, updated_at }),
        ),
    );
    return ok(undefined);
  });
}

/** The parsed value under `key`, or null if none. A value that is not JSON is `internal`. */
export async function getSupervisorState(db: Db, key: string): R<unknown> {
  if (key.length === 0) return badKey(key);
  const found = await read(db, (ix) =>
    first(
      ix,
      qb
        .selectFrom("supervisor_state")
        .select("value_json")
        .where("key", "=", key),
    ),
  );
  if (!found.ok) return found;
  if (found.value === undefined) return ok(null);
  try {
    return ok(JSON.parse(found.value.value_json) as unknown);
  } catch {
    return err(failure("internal", `supervisor_state ${key} is not JSON`));
  }
}
