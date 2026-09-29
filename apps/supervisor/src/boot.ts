// Boot-time rows (amendment 4): every adapter's runner and model rows, and the local executor,
// upserted after migrations and before the lifecycle and the claimer start. Runner names come
// only from the adapters' registration() (Invariant 1).
import {
  canonicalJson,
  err,
  LOGIN_IN_PLACE_KEY,
  LoginInPlace,
  ok,
  readsGrantedLogin,
  type Result,
} from "@bayon/core";
import { getRunner, getSettings, type Db } from "@bayon/db";
import {
  upsertExecutor,
  upsertRegistration,
  type Registration as RegistrationRows,
} from "@bayon/db/supervisor";
import type { Decertification } from "@bayon/db/supervisor";
import type { Registration } from "@bayon/runners";
import type { Logger } from "pino";
import { z } from "zod";
import { decertifyStale, type KitOf } from "./conformance/decertify.js";

export const LOCAL_EXECUTOR_ID = "local";
/**
 * The local row's slots when it is first inserted. After that `executors.slots` is the
 * operator's: boot never overwrites it, and admission re-reads it.
 */
export const LOCAL_EXECUTOR_SLOTS = 4;

/**
 * The daemon's own job runners are exempt from admission's `uncertified` gate only (design
 *). None may be a registry runner, whose certification admission always checks.
 */
export function assertJobRunners(
  jobRunners: ReadonlySet<string>,
  registryIds: readonly string[],
): Result<void> {
  const clash = [...jobRunners].filter((id) => registryIds.includes(id));
  return clash.length === 0
    ? ok(undefined)
    : err({
        class: "validation",
        message: `job runners ${clash.join(", ")} are registry runners: their certification can never be skipped`,
        retryable: false,
      });
}

const Json = z.json();

/**
 * The tiers where more than one row is not on standby: models_tier_idx allows one
 * active row per (runner, tier), so the registration must say which one is.
 */
function crowdedTiers(r: Registration): string[] {
  const active = r.models.filter((m) => m.standby !== true).map((m) => m.tier);
  return [...new Set(active.filter((t, i) => active.indexOf(t) !== i))];
}

/**
 * An adapter's registration() as the db's runner and model rows; defaults must be JSON, and each
 * tier has one row that is not on standby.
 */
export function registrationRows(r: Registration): Result<RegistrationRows> {
  const defaults = Json.safeParse(r.runner.defaults);
  if (!defaults.success) {
    return err({
      class: "validation",
      message: `runner ${r.runner.id} defaults are not JSON: ${z.prettifyError(defaults.error)}`,
      retryable: false,
    });
  }
  const crowded = crowdedTiers(r);
  if (crowded.length > 0) {
    return err({
      class: "validation",
      message: `runner ${r.runner.id} registers more than one active model in tier ${crowded.join(", ")}: put all but one on standby`,
      retryable: false,
    });
  }
  return ok({
    runner: {
      id: r.runner.id,
      kind: r.runner.kind,
      adapter: r.runner.adapter,
      version_detected: r.runner.versionDetected,
      caps_json: canonicalJson(r.runner.caps),
      defaults_json: canonicalJson(defaults.data),
    },
    models: r.models.map((m) => ({
      id: m.id,
      tier: m.tier,
      model: m.model,
      effort: m.effort ?? null,
      price_in_per_mtok: m.priceInPerMtok,
      price_out_per_mtok: m.priceOutPerMtok,
      price_cache_read_per_mtok: m.priceCacheReadPerMtok,
      price_cache_write_per_mtok: m.priceCacheWritePerMtok,
      context_tokens: m.contextTokens,
      standby: m.standby === true ? 1 : 0,
    })),
  });
}

export interface BootRowsOptions {
  readonly registrations: readonly Registration[];
  readonly localSlots?: number;
  /** Conformance kits by runner id; default the registry's. */
  readonly kits?: KitOf;
  /** Told of each pair a registration decertified (§15). */
  readonly onDecertified?: (d: Decertification) => void;
}

/**
 * Upserts the runner, model and local-executor rows. Idempotent: every boot runs it. The local
 * executor is this host: trusted, with open egress (M3 trust rule); roles in
 * executors.untrusted_roles go to a trust='untrusted' executor instead. Only the local row is
 * written, so an operator's other executors keep their trust and egress. Each registration then
 * decertifies the pairs its version, caps, kit or the suite no longer match (§15).
 */
export async function upsertBootRows(
  db: Db,
  o: BootRowsOptions,
): Promise<Result<void>> {
  for (const r of o.registrations) {
    const rows = registrationRows(r);
    if (!rows.ok) return rows;
    const done = await upsertRegistration(db, rows.value);
    if (!done.ok) return done;
  }
  const stale = await decertifyStale(db, o.registrations, o.kits);
  if (!stale.ok) return stale;
  for (const d of stale.value) o.onDecertified?.(d);
  return upsertExecutor(db, {
    id: LOCAL_EXECUTOR_ID,
    kind: "local",
    trust: "trusted",
    egress_policy: "open",
    slots: o.localSlots ?? LOCAL_EXECUTOR_SLOTS,
    // What the reconciler's health check runs (step 7): this very Node.
    config_json: canonicalJson({ healthArgv: [process.execPath, "-e", ""] }),
  });
}

/** A login grant no session can use: its runner is not registered, or cannot read one. */
export interface UnusableGrant {
  readonly runnerId: string;
  readonly reason: "unregistered" | "cannot_read";
}

/**
 * The grants in `settings.runners.login_in_place` that every spawn of their runner would refuse,
 * read once at boot after the runner rows are registered, so the operator hears of one then and
 * not only from a refused spawn. The value is read, never a login file. A row that is not a grant
 * map is left to the spawn, which refuses it with the schema's own message.
 */
export async function unusableGrants(
  db: Db,
): Promise<Result<readonly UnusableGrant[]>> {
  const rows = await getSettings(db, [LOGIN_IN_PLACE_KEY]);
  if (!rows.ok) return rows;
  const grants = LoginInPlace.safeParse(rows.value.get(LOGIN_IN_PLACE_KEY));
  if (!grants.success) return ok([]);
  const found: UnusableGrant[] = [];
  for (const runnerId of Object.keys(grants.data)) {
    const runner = await getRunner(db, runnerId);
    if (!runner.ok) {
      if (runner.error.class !== "not_found") return runner;
      found.push({ runnerId, reason: "unregistered" });
    } else if (!readsGrantedLogin(jsonOrNothing(runner.value.defaults_json))) {
      found.push({ runnerId, reason: "cannot_read" });
    }
  }
  return ok(found);
}

function jsonOrNothing(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * One warning per unusable grant, at boot. Never fatal: the spawn refuses such a grant
 * whatever happens here, and a supervisor that would not start over a setting could not be told.
 */
export async function warnUnusableGrants(db: Db, log: Logger): Promise<void> {
  const found = await unusableGrants(db);
  if (!found.ok) {
    log.warn(
      { setting: LOGIN_IN_PLACE_KEY, error: found.error },
      "the login grants could not be checked at boot",
    );
    return;
  }
  for (const g of found.value) {
    log.warn(
      { setting: LOGIN_IN_PLACE_KEY, runner: g.runnerId, reason: g.reason },
      g.reason === "unregistered"
        ? `${LOGIN_IN_PLACE_KEY} grants ${g.runnerId} a login, and no runner ${g.runnerId} is registered: the grant is used by nothing`
        : `${LOGIN_IN_PLACE_KEY} grants ${g.runnerId} a login, and ${g.runnerId} cannot read a login in place: every spawn and conformance run of it is refused until the grant is revoked`,
    );
  }
}
