// The notifier's three destination settings through the API: `notify.email.to`,
// `notify.email.from` and `notify.base_url`. an earlier change left them shell-only; the owner chose a GUI
// door with safeguards, and this is the writer half of it (§14). Exactly those three fields are
// accepted — the body's schema knows no other name — each is checked by the same core schema the
// shell door uses, and every change writes its `notify.config` audit row naming the field and both
// values, in the same transaction as the setting. A field already at its value writes neither row,
// so a repeated PUT is silent. The alert to the address that is losing the mail is the API's half.
import {
  NOTIFY_CONFIG_FIELDS,
  NOTIFY_CONFIG_KEY,
  NOTIFY_CONFIG_SCHEMA,
  err,
  ok,
  type NotifyConfigField,
} from "@bayon/core";
import { z } from "zod";
import {
  execute,
  first,
  qb,
  read,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import { insertAudit } from "./audit.js";

export const NOTIFY_CONFIG_ACTION = "notify.config";

export interface NotifyConfigChange {
  readonly field: NotifyConfigField;
  /** The `settings` row written. */
  readonly key: string;
  /** The value before; "" was unset, as is a row that was missing. */
  readonly from: string;
  readonly to: string;
  /** The audit row this change wrote: what the change alert's dedupe key is built from. */
  readonly auditId: number;
}

const Text = z.string();

/** A field's stored value, or "" when there is no row or it is not a string. */
function storedValue(ix: Internals, key: string): string {
  const row = first(
    ix,
    qb.selectFrom("settings").select("value_json").where("key", "=", key),
  );
  if (row === undefined) return "";
  try {
    const parsed = Text.safeParse(JSON.parse(row.value_json));
    return parsed.success ? parsed.data : "";
  } catch {
    return "";
  }
}

/** The three as they stand now; "" is unset. */
export async function getNotifyConfig(
  db: Db,
): R<Record<NotifyConfigField, string>> {
  return read(
    db,
    (ix) =>
      Object.fromEntries(
        NOTIFY_CONFIG_FIELDS.map((field) => [
          field,
          storedValue(ix, NOTIFY_CONFIG_KEY[field]),
        ]),
      ) as Record<NotifyConfigField, string>,
  );
}

/**
 * Sets the named destination settings, each change with its audit row, in one transaction. An
 * unknown field or a value its schema refuses writes nothing at all.
 */
export async function putNotifyConfig(
  db: Db,
  patch: Readonly<Record<string, unknown>>,
  /** Who: `operator`. */
  actor: string,
): R<NotifyConfigChange[]> {
  if (actor.trim() === "") {
    return err(failure("validation", "a destination change needs an actor"));
  }
  const known: readonly string[] = NOTIFY_CONFIG_FIELDS;
  const checked: {
    readonly field: NotifyConfigField;
    readonly value: string;
  }[] = [];
  for (const [field, value] of Object.entries(patch)) {
    if (!known.includes(field)) {
      return err(
        failure(
          "validation",
          `${field} is not a notification destination; the fields are ${NOTIFY_CONFIG_FIELDS.join(", ")}`,
        ),
      );
    }
    const name = field as NotifyConfigField;
    const parsed = NOTIFY_CONFIG_SCHEMA[name].safeParse(value);
    if (!parsed.success) {
      return err(
        failure("validation", `${name}: ${z.prettifyError(parsed.error)}`),
      );
    }
    checked.push({ field: name, value: parsed.data });
  }
  if (checked.length === 0) {
    return err(
      failure(
        "validation",
        `name at least one of ${NOTIFY_CONFIG_FIELDS.join(", ")}`,
      ),
    );
  }
  return write(db, (ix) => {
    const changes: NotifyConfigChange[] = [];
    const updated_at = ix.clock.now();
    for (const { field, value } of checked) {
      const key = NOTIFY_CONFIG_KEY[field];
      const from = storedValue(ix, key);
      if (from === value) continue;
      execute(
        ix,
        qb
          .insertInto("settings")
          .values({ key, value_json: JSON.stringify(value), updated_at })
          .onConflict((oc) =>
            oc
              .column("key")
              .doUpdateSet({ value_json: JSON.stringify(value), updated_at }),
          ),
      );
      const audit = insertAudit(ix, {
        actor,
        action: NOTIFY_CONFIG_ACTION,
        target_kind: "setting",
        target_id: key,
        payload: { field, from, to: value },
      });
      if (!audit.ok) return audit;
      changes.push({ field, key, from, to: value, auditId: audit.value.id });
    }
    return ok(changes);
  });
}
