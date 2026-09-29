import { UNTRUSTED_ROLES_KEY, UntrustedRoles, ok } from "@bayon/core";
import {
  getExecutor,
  getSettings,
  listExecutors,
  type Db,
  type ExecutorRow,
} from "@bayon/db";
import { ExecutorsView, type ExecutorView } from "@bayon/proto";
import { z } from "zod";
import { parseAs } from "./dto.js";
import type { ApiStore } from "./store.js";

// The executors half of the ApiStore: each row as the supervisor keeps it (it writes
// health, §9.5; the operator's frm writes config). The API only inserts executor.health.

export type ExecutorsStore = Pick<ApiStore, "executors" | "executorExists">;

const Json = z.json();

/** A JSON column; null when absent or unreadable, never an error for the page. */
function json(text: string | null): z.infer<typeof Json> | null {
  if (text === null) return null;
  try {
    const parsed = Json.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const view = (e: ExecutorRow): ExecutorView => ({
  id: e.id,
  kind: e.kind,
  trust: e.trust,
  egress_policy: e.egress_policy,
  slots: e.slots,
  enabled: e.enabled === 1,
  health: e.health,
  health_checked_at: e.health_checked_at,
  health_detail: json(e.health_detail),
  config: json(e.config_json),
});

export function executorsStore(db: Db): ExecutorsStore {
  return {
    async executors() {
      const rows = await listExecutors(db);
      if (!rows.ok) return rows;
      const settings = await getSettings(db, [UNTRUSTED_ROLES_KEY]);
      if (!settings.ok) return settings;
      // Read as the supervisor's trust rule reads it (lifecycle/spawn.ts): null, not an error, when bad.
      const roles = UntrustedRoles.safeParse(
        settings.value.get(UNTRUSTED_ROLES_KEY),
      );
      return parseAs(
        ExecutorsView,
        {
          executors: rows.value.map(view),
          untrusted_roles: roles.success ? roles.data : null,
        },
        "executors",
      );
    },
    async executorExists(id) {
      const row = await getExecutor(db, id);
      return row.ok ? ok(undefined) : row;
    },
  };
}
