// `frm settings set <key> <value>`: one governed setting from a shell, through the
// operator door (@bayon/db/operator, Invariant 5's one exception) — the same shape as // executors.enabled writer, and the same audit trail the API's PUT /settings leaves, with
// `via: 'frm'` instead of `'rest'`.
//
// Why a shell door at all: the two security controls (`admission.require_certified`,
// `executors.untrusted_roles`) are deliberately outside the GUI's whitelist, since the GUI can be
// served on the LAN with the operator's bearer added by its proxy (§12.1, core operator-settings).
// Until now "shell-only" meant nobody could change them one at a time at all.
//
// Every key and value is checked first by core (checkSeededSetting, the same check
// `seedConfig`/`PUT /settings` make), so an unknown key, `fleet.paused` or a value out of bounds
// writes nothing. A key already at its value is not rewritten and not audited.
import {
  canonicalJson,
  checkSeededSetting,
  err,
  isGovernedSettingKey,
  GOVERNED_SETTING_KEYS,
  ok,
  type JsonValue,
  type Result,
} from "@bayon/core";
import {
  first,
  qb,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import { insertAudit } from "./audit.js";
import { storedJson, upsertSetting } from "./fleet-control.js";

export interface SettingWrite {
  readonly key: string;
  /** The value before, null when there was no row. */
  readonly from: JsonValue | null;
  readonly to: JsonValue;
  /** False when the key already held that value: nothing was written or audited. */
  readonly changed: boolean;
}

function writeSetting(
  ix: Internals,
  key: string,
  value: JsonValue,
): Result<SettingWrite> {
  const row = first(
    ix,
    qb.selectFrom("settings").select("value_json").where("key", "=", key),
  );
  const from = row === undefined ? null : storedJson(row.value_json);
  const value_json = canonicalJson(value);
  if (row?.value_json === value_json) {
    return ok({ key, from, to: value, changed: false });
  }
  upsertSetting(ix, key, value_json, ix.clock.now());
  const audit = insertAudit(ix, {
    actor: "operator",
    action: "settings.put",
    target_kind: "setting",
    target_id: key,
    payload: { via: "frm", from, to: value },
  });
  return audit.ok ? ok({ key, from, to: value, changed: true }) : audit;
}

/**
 * Sets one governed setting, audited as the operator's via frm. Refused, writing nothing
 * (`validation`): `fleet.paused` (it has `frm pause` | `frm resume`), a key no schema governs, and
 * a value the key's own schema refuses.
 */
export function setSettingFromCli(
  db: Db,
  key: string,
  value: JsonValue,
): R<SettingWrite> {
  const checked = checkGoverned(key, value);
  if (!checked.ok) return Promise.resolve(checked);
  return write(db, (ix) => writeSetting(ix, key, value));
}

/** Core's check of the key and value, and that the key is a governed one. */
function checkGoverned(key: string, value: JsonValue): Result<void> {
  const checked = checkSeededSetting(key, value);
  if (!checked.ok) return checked;
  return checked.value === "governed" && isGovernedSettingKey(key)
    ? ok(undefined)
    : err(
        failure(
          "validation",
          `${key} is not a governed setting; the keys are ${GOVERNED_SETTING_KEYS.join(", ")}`,
        ),
      );
}

/**
 * `setSettingFromCli` as a read-modify-write in one transaction (`frm roots add|remove`): `next`
 * gets the stored value (null when there is no row) and returns the whole new value, checked and
 * audited exactly as setSettingFromCli's. A refusal from `next` or the check writes nothing, and no
 * other writer can change the row between the read and the write.
 */
export function updateSettingFromCli(
  db: Db,
  key: string,
  next: (from: JsonValue | null) => Result<JsonValue>,
): R<SettingWrite> {
  return write(db, (ix) => {
    const row = first(
      ix,
      qb.selectFrom("settings").select("value_json").where("key", "=", key),
    );
    const value = next(row === undefined ? null : storedJson(row.value_json));
    if (!value.ok) return value;
    const checked = checkGoverned(key, value.value);
    return checked.ok ? writeSetting(ix, key, value.value) : checked;
  });
}
