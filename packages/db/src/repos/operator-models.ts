import { err, ok, type JsonValue, type Result } from "@bayon/core";
import {
  all,
  execute,
  first,
  qb,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import type { ModelRow, ModelsTable } from "../schema.js";

type ModelTier = ModelsTable["tier"];
import { insertAudit } from "./audit.js";

// The operator's models (046): one writer behind both doors — `frm config apply`'s
// (through seedConfig, @bayon/db/operator) and the REST one (@bayon/db/api, a §9.5 carve-out like
// createExecutor). Every row it writes is `source='operator'`, which boot never touches.
//
// The tier rule: models_tier_idx allows one active row per (runner, tier). Activating an operator
// row in a tier whose active row is the adapter's deactivates that row (the operator replaces it);
// one whose active row is another operator row is refused. Deactivating an operator row re-activates
// the tier's registered adapter row, as the next boot would (the one not on standby, 050). A row's model string is fixed once
// stored: a certificate is pinned to it and only boot compares the two.
//
// The caller has validated the row with its runner's adapter (validateModel) and canonicalized
// settings_json; nothing here reads inside it (Invariant 1).

export interface OperatorModel {
  readonly id: string;
  readonly runner_id: string;
  readonly tier: ModelTier;
  readonly model: string;
  readonly effort: string | null;
  readonly price_in_per_mtok: number | null;
  readonly price_out_per_mtok: number | null;
  readonly price_cache_read_per_mtok: number | null;
  readonly price_cache_write_per_mtok: number | null;
  readonly context_tokens: number | null;
  /** Canonical JSON of an object: the adapter's own settings for this row. */
  readonly settings_json: string;
  readonly active: boolean;
}

/** Which door wrote it, for the audit row. */
export type ModelVia = "frm" | "rest";

export interface ModelWrite {
  readonly via: ModelVia;
  /** `create` refuses an id that exists (POST); `upsert` writes over it (a config file, PATCH). */
  readonly mode: "create" | "upsert";
}

/** What a put did: `changed` false when the stored row already was exactly this one. */
export interface ModelPut {
  readonly changed: boolean;
  /** Adapter rows this put deactivated to make room in the tier. */
  readonly replaced: readonly string[];
}

const FIELDS = [
  "tier",
  "model",
  "effort",
  "price_in_per_mtok",
  "price_out_per_mtok",
  "price_cache_read_per_mtok",
  "price_cache_write_per_mtok",
  "context_tokens",
  "settings_json",
] as const;

/** The audit payload's view of a row: every field the operator sets, settings as JSON. */
function summary(r: OperatorModel | ModelRow): JsonValue {
  const settings = JSON.parse(r.settings_json) as JsonValue;
  return {
    tier: r.tier,
    model: r.model,
    effort: r.effort,
    price_in_per_mtok: r.price_in_per_mtok,
    price_out_per_mtok: r.price_out_per_mtok,
    price_cache_read_per_mtok: r.price_cache_read_per_mtok,
    price_cache_write_per_mtok: r.price_cache_write_per_mtok,
    context_tokens: r.context_tokens,
    settings,
    active: r.active === true || r.active === 1,
  };
}

const same = (stored: ModelRow, m: OperatorModel): boolean =>
  stored.source === "operator" &&
  stored.retired_at === null &&
  (stored.active === 1) === m.active &&
  FIELDS.every((f) => stored[f] === m[f]);

function storedModel(ix: Internals, id: string): ModelRow | undefined {
  return first(ix, qb.selectFrom("models").selectAll().where("id", "=", id));
}

/** Makes room for an active row in (runner, tier): adapter rows go inactive, an operator row refuses. */
function makeRoom(ix: Internals, m: OperatorModel): Result<readonly string[]> {
  const holders = all(
    ix,
    qb
      .selectFrom("models")
      .select(["id", "source"])
      .where("runner_id", "=", m.runner_id)
      .where("tier", "=", m.tier)
      .where("active", "=", 1)
      .where("id", "!=", m.id),
  );
  const operator = holders.find((h) => h.source === "operator");
  if (operator !== undefined) {
    return err(
      failure(
        "conflict",
        `runner ${m.runner_id} already runs operator model ${operator.id} in tier ${m.tier}: one active model per runner and tier — deactivate ${operator.id} first`,
      ),
    );
  }
  const replaced = holders.map((h) => h.id);
  if (replaced.length > 0) {
    execute(
      ix,
      qb.updateTable("models").set({ active: 0 }).where("id", "in", replaced),
    );
  }
  return ok(replaced);
}

/**
 * A tier left with no active row gets its registered adapter row back, as the next boot would: the
 * one not on standby (050), then the lowest id.
 */
function refill(ix: Internals, runnerId: string, tier: ModelTier): void {
  const held = first(
    ix,
    qb
      .selectFrom("models")
      .select("id")
      .where("runner_id", "=", runnerId)
      .where("tier", "=", tier)
      .where("active", "=", 1),
  );
  if (held !== undefined) return;
  const registered = first(
    ix,
    qb
      .selectFrom("models")
      .select("id")
      .where("runner_id", "=", runnerId)
      .where("tier", "=", tier)
      .where("source", "=", "adapter")
      .where("retired_at", "is", null)
      .orderBy("standby")
      .orderBy("id")
      .limit(1),
  );
  if (registered !== undefined) {
    execute(
      ix,
      qb
        .updateTable("models")
        .set({ active: 1 })
        .where("id", "=", registered.id),
    );
  }
}

function checkAgainstStored(
  stored: ModelRow | undefined,
  m: OperatorModel,
  w: ModelWrite,
): Result<void> {
  if (stored === undefined) return ok(undefined);
  if (w.mode === "create") {
    return err(
      failure(
        "conflict",
        `model ${m.id} exists: change it instead of adding it again`,
      ),
    );
  }
  if (stored.runner_id !== m.runner_id) {
    return err(
      failure(
        "conflict",
        `model ${m.id} is runner ${stored.runner_id}'s, not ${m.runner_id}'s`,
      ),
    );
  }
  if (stored.model !== m.model) {
    return err(
      failure(
        "validation",
        `model ${m.id} runs ${stored.model}; a models row's model string is fixed once stored (its certificates are pinned to it): add a new id for ${m.model}`,
      ),
    );
  }
  return ok(undefined);
}

/**
 * Writes one operator model inside the caller's transaction, with its `model.put` audit row. An
 * identical stored operator row writes nothing (no audit row): applying a file twice is a no-op.
 */
export function putOperatorModelIn(
  ix: Internals,
  m: OperatorModel,
  w: ModelWrite,
): Result<ModelPut> {
  const stored = storedModel(ix, m.id);
  const checked = checkAgainstStored(stored, m, w);
  if (!checked.ok) return checked;
  if (stored !== undefined && same(stored, m))
    return ok({ changed: false, replaced: [] });
  const room = m.active ? makeRoom(ix, m) : ok([]);
  if (!room.ok) return room;
  const { id, active, ...fields } = m;
  const row = {
    ...fields,
    active: active ? 1 : 0,
    retired_at: null,
    source: "operator" as const,
  };
  execute(
    ix,
    qb
      .insertInto("models")
      .values({ id, ...row })
      .onConflict((oc) => oc.column("id").doUpdateSet(row)),
  );
  if (stored !== undefined && stored.active === 1 && stored.tier !== m.tier)
    refill(ix, m.runner_id, stored.tier);
  if (!m.active) refill(ix, m.runner_id, m.tier);
  const audit = insertAudit(ix, {
    actor: "operator",
    action: "model.put",
    target_kind: "model",
    target_id: m.id,
    payload: {
      via: w.via,
      runner_id: m.runner_id,
      from: stored === undefined ? null : summary(stored),
      to: summary(m),
      replaced: [...room.value],
    },
  });
  return audit.ok ? ok({ changed: true, replaced: room.value }) : audit;
}

/** `putOperatorModelIn` in its own transaction: the REST door's POST and PATCH. */
export function putOperatorModel(
  db: Db,
  m: OperatorModel,
  w: ModelWrite,
): R<ModelPut> {
  return write(db, (ix) => putOperatorModelIn(ix, m, w));
}

/**
 * Deactivates `runnerId`'s model `id`, which becomes the operator's (so the next boot keeps it
 * off), and gives its tier back to the registered adapter row. Audited `model.deactivate`; one
 * already inactive and the operator's writes nothing.
 */
export function deactivateOperatorModel(
  db: Db,
  runnerId: string,
  id: string,
  via: ModelVia,
): R<{ readonly changed: boolean }> {
  return write(db, (ix) => {
    const stored = storedModel(ix, id);
    if (stored === undefined || stored.runner_id !== runnerId) {
      return err(failure("not_found", `runner ${runnerId} has no model ${id}`));
    }
    if (stored.active === 0 && stored.source === "operator")
      return ok({ changed: false as boolean });
    execute(
      ix,
      qb
        .updateTable("models")
        .set({ active: 0, source: "operator" })
        .where("id", "=", id),
    );
    refill(ix, runnerId, stored.tier);
    const audit = insertAudit(ix, {
      actor: "operator",
      action: "model.deactivate",
      target_kind: "model",
      target_id: id,
      payload: { via, runner_id: runnerId, from: summary(stored) },
    });
    return audit.ok ? ok({ changed: true }) : audit;
  });
}
