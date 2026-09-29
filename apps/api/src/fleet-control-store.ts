import {
  OPERATOR_SETTINGS,
  OPERATOR_SETTING_KEYS,
  REQUIRE_CERTIFIED_KEY,
  SettingFlag,
  ok,
  operatorSettingSchema,
  type Result,
} from "@bayon/core";
import {
  getSettingRows,
  listAuditPage,
  type AuditRow,
  type Db,
} from "@bayon/db";
import {
  ackAttention,
  putOperatorSettings,
  setFleetPaused,
} from "@bayon/db/api";
import {
  AttentionAck,
  AuditPage,
  FleetPauseState,
  OperatorSettingsView,
} from "@bayon/proto";
import { jsonColumn, parseAs } from "./dto.js";
import type { ApiStore } from "./store.js";

// The kill switch, the whitelisted settings and the audit log in the ApiStore (M4 §12.1).
// REST callers are the operator; every write here is audited in its own transaction (@bayon/db/api).

export type FleetControlStore = Pick<
  ApiStore,
  | "setFleetPaused"
  | "operatorSettings"
  | "putOperatorSettings"
  | "audit"
  | "ackAttention"
>;

const OPERATOR = "operator";

async function settingsView(db: Db): Promise<Result<OperatorSettingsView>> {
  const rows = await getSettingRows(db, [
    ...OPERATOR_SETTING_KEYS,
    REQUIRE_CERTIFIED_KEY,
  ]);
  if (!rows.ok) return rows;
  const certified = SettingFlag.safeParse(
    rows.value.get(REQUIRE_CERTIFIED_KEY)?.value,
  );
  return parseAs(
    OperatorSettingsView,
    {
      require_certified: certified.success ? certified.data : null,
      settings: OPERATOR_SETTING_KEYS.map((key) => {
        const def = OPERATOR_SETTINGS[key];
        const row = rows.value.get(key);
        return {
          key,
          value: typeof row?.value === "number" ? row.value : null,
          valid:
            row !== undefined &&
            operatorSettingSchema(def).safeParse(row.value).success,
          default: def.default,
          updated_at: row?.updated_at ?? null,
        };
      }),
    },
    "operator settings",
  );
}

function auditItems(rows: readonly AuditRow[]): Result<unknown[]> {
  const items: unknown[] = [];
  for (const row of rows) {
    const payload = jsonColumn(row.payload_json, `audit row ${row.id}`);
    if (!payload.ok) return payload;
    items.push({
      id: row.id,
      ts: row.ts,
      actor: row.actor,
      action: row.action,
      target_kind: row.target_kind,
      target_id: row.target_id,
      payload: payload.value,
    });
  }
  return ok(items);
}

export function fleetControlStore(db: Db): FleetControlStore {
  return {
    async setFleetPaused(paused) {
      const changed = await setFleetPaused(db, {
        paused,
        actor: OPERATOR,
        via: "rest",
      });
      return changed.ok
        ? parseAs(FleetPauseState, changed.value, "fleet pause")
        : changed;
    },
    async ackAttention(sessionId) {
      const acked = await ackAttention(db, sessionId, OPERATOR);
      return acked.ok
        ? parseAs(AttentionAck, acked.value, `attention ack ${sessionId}`)
        : acked;
    },
    operatorSettings: () => settingsView(db),
    async putOperatorSettings(patch) {
      const put = await putOperatorSettings(db, patch, OPERATOR);
      return put.ok ? settingsView(db) : put;
    },
    async audit({ before, limit, actor, action }) {
      const page = await listAuditPage(db, {
        limit,
        ...(before === undefined ? {} : { before }),
        ...(actor === undefined ? {} : { actor }),
        ...(action === undefined ? {} : { action }),
      });
      if (!page.ok) return page;
      const items = auditItems(page.value.rows);
      if (!items.ok) return items;
      const last = page.value.rows.at(-1);
      return parseAs(
        AuditPage,
        {
          items: items.value,
          next_cursor:
            page.value.hasMore && last !== undefined ? last.id : null,
          has_more: page.value.hasMore,
        },
        "audit page",
      );
    },
  };
}
