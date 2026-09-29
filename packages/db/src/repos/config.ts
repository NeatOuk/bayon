import {
  canonicalJson,
  err,
  ok,
  type JsonValue,
  type ModelTier,
} from "@bayon/core";
import { all, first, qb, read, write, type Db, type R } from "../connection.js";
import { failure, orNotFound } from "../errors.js";
import type {
  AgentRow,
  ExecutorRow,
  MissionRow,
  ModelRow,
  ProfileRow,
  RepoRow,
  RunnerRow,
  WorkspaceRow,
} from "../schema.js";

// The operator's configuration, as the supervisor reads it to resolve a spawn (§9.1), plus the
// executor health the reconciler records (§9.6 step 7).

export async function getAgent(db: Db, id: string): R<AgentRow> {
  const found = await read(db, (ix) =>
    first(ix, qb.selectFrom("agents").selectAll().where("id", "=", id)),
  );
  return orNotFound(found, `agent ${id}`);
}

export async function getProfile(db: Db, id: string): R<ProfileRow> {
  const found = await read(db, (ix) =>
    first(ix, qb.selectFrom("profiles").selectAll().where("id", "=", id)),
  );
  return orNotFound(found, `profile ${id}`);
}

export async function getRunner(db: Db, id: string): R<RunnerRow> {
  const found = await read(db, (ix) =>
    first(ix, qb.selectFrom("runners").selectAll().where("id", "=", id)),
  );
  return orNotFound(found, `runner ${id}`);
}

export async function getExecutor(db: Db, id: string): R<ExecutorRow> {
  const found = await read(db, (ix) =>
    first(ix, qb.selectFrom("executors").selectAll().where("id", "=", id)),
  );
  return orNotFound(found, `executor ${id}`);
}

export async function getMission(db: Db, id: string): R<MissionRow> {
  const found = await read(db, (ix) =>
    first(ix, qb.selectFrom("missions").selectAll().where("id", "=", id)),
  );
  return orNotFound(found, `mission ${id}`);
}

export async function getRepo(db: Db, id: string): R<RepoRow> {
  const found = await read(db, (ix) =>
    first(ix, qb.selectFrom("repos").selectAll().where("id", "=", id)),
  );
  return orNotFound(found, `repo ${id}`);
}

export async function getWorkspace(db: Db, id: string): R<WorkspaceRow> {
  const found = await read(db, (ix) =>
    first(ix, qb.selectFrom("workspaces").selectAll().where("id", "=", id)),
  );
  return orNotFound(found, `workspace ${id}`);
}

/** A workspace's repo, with where it sits under the session root. */
export type WorkspaceRepo = RepoRow & {
  readonly rel_path: string;
  readonly role: string;
  readonly submodule_path: string | null;
};

export function getWorkspaceRepos(
  db: Db,
  workspaceId: string,
): R<WorkspaceRepo[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("workspace_repos as wr")
        .innerJoin("repos as r", "r.id", "wr.repo_id")
        .selectAll("r")
        .select(["wr.rel_path", "wr.role", "wr.submodule_path"])
        .where("wr.workspace_id", "=", workspaceId)
        .orderBy("wr.rel_path"),
    ),
  );
}

/** The runner's active model in `tier`; models_tier_idx allows at most one. */
export async function getActiveModel(
  db: Db,
  runnerId: string,
  tier: ModelTier,
): R<ModelRow> {
  const found = await read(db, (ix) =>
    first(
      ix,
      qb
        .selectFrom("models")
        .selectAll()
        .where("runner_id", "=", runnerId)
        .where("tier", "=", tier)
        .where("active", "=", 1),
    ),
  );
  return orNotFound(found, `an active ${tier} model of runner ${runnerId}`);
}

/** One models row by id, active or retired. */
export async function getModel(db: Db, id: string): R<ModelRow> {
  const found = await read(db, (ix) =>
    first(ix, qb.selectFrom("models").selectAll().where("id", "=", id)),
  );
  return orNotFound(found, `model ${id}`);
}

/** The settings rows among `keys`, JSON-parsed. A key with no row is absent from the map. */
export async function getSettings(
  db: Db,
  keys: readonly string[],
): R<ReadonlyMap<string, unknown>> {
  if (keys.length === 0) return ok(new Map());
  const rows = await read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("settings")
        .select(["key", "value_json"])
        .where("key", "in", keys),
    ),
  );
  if (!rows.ok) return rows;
  const parsed = new Map<string, unknown>();
  for (const { key, value_json } of rows.value) {
    try {
      parsed.set(key, JSON.parse(value_json) as unknown);
    } catch {
      return err(failure("validation", `setting ${key} is not JSON`));
    }
  }
  return ok(parsed);
}

/** A settings row: its JSON-parsed value and when it was last written. */
export interface SettingRow {
  readonly value: unknown;
  readonly updated_at: number;
}

/**
 * The settings rows among `keys` with when each was last written; a key with no row is absent.
 * A value that is not JSON is `validation`, as in getSettings.
 */
export async function getSettingRows(
  db: Db,
  keys: readonly string[],
): R<ReadonlyMap<string, SettingRow>> {
  if (keys.length === 0) return ok(new Map());
  const rows = await read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("settings")
        .select(["key", "value_json", "updated_at"])
        .where("key", "in", keys),
    ),
  );
  if (!rows.ok) return rows;
  const parsed = new Map<string, SettingRow>();
  for (const { key, value_json, updated_at } of rows.value) {
    try {
      parsed.set(key, { value: JSON.parse(value_json) as unknown, updated_at });
    } catch {
      return err(failure("validation", `setting ${key} is not JSON`));
    }
  }
  return ok(parsed);
}

export type ExecutorHealth = "unknown" | "healthy" | "unhealthy";

/** Records an executor's health check, stamped by the clock, with what it measured (JSON;
 * null for a check that measures nothing, which clears the previous detail). */
export function setExecutorHealth(
  db: Db,
  id: string,
  health: ExecutorHealth,
  detail: JsonValue | null = null,
): R<ExecutorRow> {
  return write(db, (ix) => {
    const row = first(
      ix,
      qb
        .updateTable("executors")
        .set({
          health,
          health_checked_at: ix.clock.now(),
          health_detail: detail === null ? null : canonicalJson(detail),
        })
        .where("id", "=", id)
        .returningAll(),
    );
    return row === undefined
      ? err(failure("not_found", `executor ${id} does not exist`))
      : ok(row);
  });
}
