// The kill switch and the operator's settings (§12.1, M4: POST /fleet/pause|resume and PUT
// /settings). Both write operator-owned `settings` rows, each change with its audit_log
// row in the same transaction; an unchanged value writes neither, so `fleet.paused`'s updated_at
// stays the moment of the last real pause or resume (core FleetHold.resumedAt). The API writes
// through setFleetPaused and putOperatorSettings; `frm pause|resume`, when the API does not
// answer, through setFleetPausedFromCli (@bayon/db/operator, Invariant 5's one exception).
import {
  FLEET_PAUSED_KEY,
  checkOperatorSetting,
  err,
  fleetHoldOf,
  ok,
  type JsonValue,
  type OperatorSettingKey,
  type Result,
} from "@bayon/core";
import { z } from "zod";
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

/** Which door the operator came through: REST, or frm's database fallback. */
export type PauseVia = "rest" | "frm";

export interface PauseRequest {
  readonly paused: boolean;
  /** Who: `operator`. */
  readonly actor: string;
  readonly via: PauseVia;
}

export interface FleetPauseChange {
  readonly paused: boolean;
  /** False when the fleet already was in that state: nothing was written or audited. */
  readonly changed: boolean;
  /** When `fleet.paused` was last written. */
  readonly updated_at: number;
}

const Json = z.json();

/** A stored value_json for an audit payload: its JSON, or the raw text when it is not JSON. */
export function storedJson(text: string): JsonValue {
  try {
    const parsed = Json.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : text;
  } catch {
    return text;
  }
}

function settingRow(ix: Internals, key: string) {
  return first(
    ix,
    qb
      .selectFrom("settings")
      .select(["value_json", "updated_at"])
      .where("key", "=", key),
  );
}

/** One settings row written or replaced. Shared with `frm settings set`. */
export function upsertSetting(
  ix: Internals,
  key: string,
  value_json: string,
  updated_at: number,
): void {
  execute(
    ix,
    qb
      .insertInto("settings")
      .values({ key, value_json, updated_at })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({ value_json, updated_at }),
      ),
  );
}

/** Whether `fleet.paused` reads 1 inside a transaction (the Fleet overview's `paused`). */
export function pausedIn(ix: Internals): Result<boolean> {
  const row = settingRow(ix, FLEET_PAUSED_KEY);
  const hold = fleetHoldOf(
    row === undefined
      ? undefined
      : { value: storedJson(row.value_json), updated_at: row.updated_at },
  );
  return hold.ok
    ? ok(hold.value.paused)
    : err(failure("internal", hold.error.message));
}

function writePause(ix: Internals, r: PauseRequest): Result<FleetPauseChange> {
  if (r.actor.trim() === "") {
    return err(failure("validation", "a pause or resume needs an actor"));
  }
  const row = settingRow(ix, FLEET_PAUSED_KEY);
  // A row that does not read as 0 or 1 is overwritten: pause and resume repair it.
  const current =
    row === undefined
      ? undefined
      : fleetHoldOf({
          value: storedJson(row.value_json),
          updated_at: row.updated_at,
        });
  if (
    row !== undefined &&
    current?.ok === true &&
    current.value.paused === r.paused
  ) {
    return ok({ paused: r.paused, changed: false, updated_at: row.updated_at });
  }
  const updated_at = ix.clock.now();
  upsertSetting(ix, FLEET_PAUSED_KEY, r.paused ? "1" : "0", updated_at);
  const audit = insertAudit(ix, {
    actor: r.actor,
    action: r.paused ? "fleet.pause" : "fleet.resume",
    target_kind: "setting",
    target_id: FLEET_PAUSED_KEY,
    payload: { via: r.via },
  });
  return audit.ok ? ok({ paused: r.paused, changed: true, updated_at }) : audit;
}

/** Pauses or resumes the fleet, audited; the same state again changes nothing. */
export function setFleetPaused(db: Db, r: PauseRequest): R<FleetPauseChange> {
  return write(db, (ix) => writePause(ix, r));
}

/** `frm pause|resume` straight into the database, the operator's, when the API does not answer. */
export function setFleetPausedFromCli(
  db: Db,
  paused: boolean,
): R<FleetPauseChange> {
  return setFleetPaused(db, { paused, actor: "operator", via: "frm" });
}

export interface SettingChange {
  readonly key: OperatorSettingKey;
  /** The value before, null when there was no row. */
  readonly from: JsonValue | null;
  readonly to: number;
}

/**
 * Sets whitelisted settings (core OPERATOR_SETTINGS) in one transaction, each change with its
 * `settings.put` audit row. Every key and value is checked first, so an unknown key or a value out
 * of bounds writes nothing. A key already at its value is not rewritten; the changes are returned.
 */
export async function putOperatorSettings(
  db: Db,
  patch: Readonly<Record<string, unknown>>,
  /** Who: `operator`. */
  actor: string,
): R<SettingChange[]> {
  if (actor.trim() === "") {
    return err(failure("validation", "a settings change needs an actor"));
  }
  const checked: {
    readonly key: OperatorSettingKey;
    readonly value: number;
  }[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const one = checkOperatorSetting(key, value);
    if (!one.ok) return one;
    checked.push(one.value);
  }
  if (checked.length === 0) {
    return err(failure("validation", "name at least one setting"));
  }
  return write(db, (ix) => {
    const changes: SettingChange[] = [];
    const updated_at = ix.clock.now();
    for (const { key, value } of checked) {
      const row = settingRow(ix, key);
      const value_json = JSON.stringify(value);
      if (row?.value_json === value_json) continue;
      upsertSetting(ix, key, value_json, updated_at);
      const from = row === undefined ? null : storedJson(row.value_json);
      const audit = insertAudit(ix, {
        actor,
        action: "settings.put",
        target_kind: "setting",
        target_id: key,
        payload: { via: "rest", from, to: value },
      });
      if (!audit.ok) return audit;
      changes.push({ key, from, to: value });
    }
    return ok(changes);
  });
}
