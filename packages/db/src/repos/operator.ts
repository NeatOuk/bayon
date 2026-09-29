import {
  RESERVED_MIRROR_PREFIX,
  canonicalJson,
  checkSeededSetting,
  err,
  isReservedRepoId,
  ok,
  type JsonValue,
  type Result,
} from "@bayon/core";
import type { Insertable } from "kysely";
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
import { storedJson } from "./fleet-control.js";
import { putOperatorModelIn, type OperatorModel } from "./operator-models.js";
import type {
  AgentsTable,
  ExecutorsTable,
  ProfilesTable,
  ReposTable,
  RunClassesTable,
  WorkspaceReposTable,
  WorkspacesTable,
} from "../schema.js";

// The operator's configuration (§4): what an operator sets up before any session runs. Only config
// tables: never sessions, runs, events, spend or commands (§9.5), never runners, which come from
// each adapter's registration() at supervisor boot (amendment 4), and never missions or
// `agents.mission_id`, which the API writes (POST /missions, M1 amendment 6). Models only as the
// operator's own rows (046), which boot never touches.

export interface ConfigRows {
  readonly executors?: readonly Insertable<ExecutorsTable>[];
  readonly repos?: readonly Insertable<ReposTable>[];
  readonly workspaces?: readonly Insertable<WorkspacesTable>[];
  readonly workspace_repos?: readonly Insertable<WorkspaceReposTable>[];
  readonly profiles?: readonly Insertable<ProfilesTable>[];
  readonly agents?: readonly Omit<Insertable<AgentsTable>, "mission_id">[];
  readonly run_classes?: readonly Insertable<RunClassesTable>[];
  /**
   * Upserted as the operator's (`source='operator'`), each checked by its runner's adapter first
   * (the caller's job) and audited `model.put` when it changes (operator-models.ts).
   */
  readonly models?: readonly OperatorModel[];
  /** Upserted: `settings` keys, each value stored as canonical JSON. */
  readonly settings?: Readonly<Record<string, JsonValue>>;
}

/**
 * Inserts `rows` in one transaction, parents before children. A missing parent (such as a runner
 * not registered yet) is `validation`, a repeated id `conflict`; either way nothing is written.
 * Run classes and settings are upserted instead, so a seeded one can be tuned.
 */
export function seedConfig(db: Db, rows: ConfigRows): R<void> {
  // Every governed setting is checked first, as PUT /settings checks it; fleet.paused is refused
  // (core checkSeededSetting). A refusal writes nothing.
  const settings: SeededSetting[] = [];
  for (const [key, value] of Object.entries(rows.settings ?? {})) {
    const kind = checkSeededSetting(key, value);
    if (!kind.ok) return Promise.resolve(kind);
    settings.push({ key, value, governed: kind.value === "governed" });
  }
  // An executor's own mirrors take this prefix; a repo with it would share one (H1).
  const reserved = (rows.repos ?? []).find((r) => isReservedRepoId(r.id));
  if (reserved !== undefined) {
    return Promise.resolve(
      err(
        failure(
          "validation",
          `repo id ${reserved.id}: the prefix ${RESERVED_MIRROR_PREFIX} is reserved for executor mirrors`,
        ),
      ),
    );
  }
  return write(db, (ix) => {
    for (const r of rows.executors ?? [])
      execute(ix, qb.insertInto("executors").values(r));
    for (const r of rows.repos ?? [])
      execute(ix, qb.insertInto("repos").values(r));
    for (const r of rows.workspaces ?? [])
      execute(ix, qb.insertInto("workspaces").values(r));
    for (const r of rows.workspace_repos ?? [])
      execute(ix, qb.insertInto("workspace_repos").values(r));
    for (const r of rows.profiles ?? [])
      execute(ix, qb.insertInto("profiles").values(r));
    for (const r of rows.agents ?? [])
      execute(ix, qb.insertInto("agents").values(r));
    // Upserted like settings: an operator tunes a seeded class (002) in place.
    for (const r of rows.run_classes ?? [])
      execute(
        ix,
        qb
          .insertInto("run_classes")
          .values(r)
          .onConflict((oc) => oc.column("name").doUpdateSet(r)),
      );
    for (const m of rows.models ?? []) {
      const put = putOperatorModelIn(ix, m, { via: "frm", mode: "upsert" });
      if (!put.ok) return put;
    }
    return writeSettings(ix, settings);
  });
}

interface SeededSetting {
  readonly key: string;
  readonly value: JsonValue;
  /** Checked by core; written only when it changes, with its settings.put audit row. */
  readonly governed: boolean;
}

/**
 * Upserts each setting as canonical JSON. A governed one is written only when its value changes,
 * with a `settings.put` audit row (the operator's, via frm) in the same transaction.
 */
function writeSettings(
  ix: Internals,
  settings: readonly SeededSetting[],
): Result<void> {
  const updated_at = ix.clock.now();
  for (const { key, value, governed } of settings) {
    const value_json = canonicalJson(value);
    if (governed) {
      const row = first(
        ix,
        qb.selectFrom("settings").select("value_json").where("key", "=", key),
      );
      if (row?.value_json === value_json) continue;
      const audit = insertAudit(ix, {
        actor: "operator",
        action: "settings.put",
        target_kind: "setting",
        target_id: key,
        payload: {
          via: "frm",
          from: row === undefined ? null : storedJson(row.value_json),
          to: value,
        },
      });
      if (!audit.ok) return audit;
    }
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
  return ok(undefined);
}

/** Replaces an executor's config_json: `frm executor image` records the image it built. */
export function setExecutorConfig(
  db: Db,
  id: string,
  config: JsonValue,
): R<void> {
  return write(db, (ix) => {
    const row = first(
      ix,
      qb
        .updateTable("executors")
        .set({ config_json: canonicalJson(config) })
        .where("id", "=", id)
        .returning("id"),
    );
    return row === undefined
      ? err(failure("not_found", `executor ${id} does not exist`))
      : ok(undefined);
  });
}
