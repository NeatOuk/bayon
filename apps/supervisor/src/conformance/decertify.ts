// Decertification (§15, at boot, on each registration and on each health
// pass: a (runner, executor, model, compression) certificate loses its flags
// when its runner's
// version or caps, its kit or the suite changed, when the model registered under its models row
// changed or is no longer registered, when its stored result no longer certifies, or when the version a
// health pass re-detected on its executor differs from the one its result pins — the runner's
// version, or on a container executor the image the runner lives inside. A
// compression-on certificate's kit hash covers this build's context ruleset (spec M12), so a new
// ruleset lapses those alone; a compression-off one hashes as it always did. Core
// staleCertification and observationDrift trust nothing stored.
import {
  CONTEXT_RULESET,
  SUITE_VERSION,
  capsHash,
  certifyStored,
  observationDrift,
  ok,
  staleCertification,
  type CertificationKey,
  type PairObservation,
  type Result,
} from "@bayon/core";
import {
  listModels,
  listRunnerCertifications,
  type Db,
  type RunnerCertificationRow,
} from "@bayon/db";
import { decertifyPairs, type Decertification } from "@bayon/db/supervisor";
import type { Registration } from "@bayon/runners";
import { z } from "zod";
import {
  conformanceKit,
  kitHash,
  type ConformanceKit,
} from "@bayon/runners/conformance";

/** A runner's conformance kit by id: the registry's, or a test's. */
export type KitOf = (runnerId: string) => Result<ConformanceKit>;

/**
 * What a certification of this runner on `model` (a model string it registers) must be pinned to
 * now; the kit hash covers the model, and for a compression-on certificate this build's
 * context ruleset. No kit: none can hold.
 */
export async function currentKey(
  r: Registration,
  model: string,
  kits: KitOf = conformanceKit,
  /** The models row's own settings: the kit hash covers them when there are any. */
  modelSettings: Readonly<Record<string, unknown>> = {},
  /** The certificate was earned with context compression on (049). */
  compression = false,
): Promise<CertificationKey> {
  const kit = kits(r.runner.id);
  const version = r.runner.versionDetected.trim();
  return {
    model,
    runner_version: version === "" ? "unknown" : version,
    suite_version: SUITE_VERSION,
    kit_hash: kit.ok
      ? await kitHash(
          kit.value,
          model,
          modelSettings,
          compression ? { ruleset: CONTEXT_RULESET } : undefined,
        )
      : "no kit",
    caps_hash: await capsHash(r.runner.caps),
  };
}

const pairId = (runnerId: string, executorId: string): string =>
  `${runnerId}\0${executorId}`;

/** A models row as a certificate is judged against it: its string and its adapter settings. */
interface CurrentModel {
  readonly model: string;
  /** The operator row's settings; `{}` for the registration's own rows. */
  readonly settings: Readonly<Record<string, unknown>>;
  /** The stored settings_json, to name in a reason; null for the registration's rows. */
  readonly settingsJson: string | null;
}

interface Current {
  readonly registration: Registration;
  /** The runner's models, by id: the registration's, then the operator's own rows. */
  readonly models: ReadonlyMap<string, CurrentModel>;
}

const SettingsObject = z.record(z.string(), z.unknown());

/** An operator row's settings_json as an object; `{}` when it is not one (never trusted blindly). */
function settingsOf(json: string): Readonly<Record<string, unknown>> {
  try {
    const parsed = SettingsObject.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** Why the row no longer holds against the runner as registered now; null if it holds. */
async function againstRegistration(
  row: RunnerCertificationRow,
  current: Current,
  kits: KitOf,
): Promise<string | null> {
  const model = current.models.get(row.model_id);
  if (model === undefined) {
    return `model ${row.model_id} is no longer registered for runner ${row.runner_id}`;
  }
  const reason = await staleCertification(
    row,
    await currentKey(
      current.registration,
      model.model,
      kits,
      model.settings,
      row.compression === 1,
    ),
  );
  // An operator row's kit hash covers its settings: a drift there may be a changed provider URL.
  return reason !== null &&
    model.settingsJson !== null &&
    reason.includes("kit_hash")
    ? `${reason} (the kit hash covers the model's settings, now ${model.settingsJson}: a changed setting such as the provider URL lapses the certificate)`
    : reason;
}

/** What a health pass saw of the pair against what its stored result pins; null without one. */
function observedDrift(
  row: RunnerCertificationRow,
  seen: PairObservation | undefined,
): string | null {
  if (seen === undefined) return null;
  const result = certifyStored(row.result_json);
  return result.ok ? observationDrift(result.value, seen) : null;
}

/**
 * Decertifies every live pair that no longer holds and returns the pairs it decertified (one a
 * concurrent pass got to first is not among them). A pair is judged on its runner's current key
 * when `registrations` names the runner (boot, a registration), and on what a health pass
 * re-detected on its executor when `observed` names the pair. A pair neither names is
 * left alone: nothing to compare it with.
 */
export async function decertifyStale(
  db: Db,
  registrations: readonly Registration[],
  kits: KitOf = conformanceKit,
  observed: readonly PairObservation[] = [],
): Promise<Result<readonly Decertification[]>> {
  const rows = await listRunnerCertifications(db);
  if (!rows.ok) return rows;
  // The operator's own rows are the runner's models as much as its registration's:
  // their certificates are judged on the string stored, never lapsed as "no longer registered".
  const stored = registrations.length === 0 ? ok([]) : await listModels(db);
  if (!stored.ok) return stored;
  const keys = new Map<string, Current>();
  for (const r of registrations) {
    const operator = stored.value.filter(
      (m) => m.runner_id === r.runner.id && m.source === "operator",
    );
    keys.set(r.runner.id, {
      registration: r,
      models: new Map<string, CurrentModel>([
        ...r.models.map(
          (m) =>
            [
              m.id,
              { model: m.model, settings: {}, settingsJson: null },
            ] as const,
        ),
        ...operator.map(
          (m) =>
            [
              m.id,
              {
                model: m.model,
                settings: settingsOf(m.settings_json),
                settingsJson: m.settings_json,
              },
            ] as const,
        ),
      ]),
    });
  }
  const seen = new Map(
    observed.map((o) => [pairId(o.runner_id, o.executor_id), o]),
  );
  const stale: Decertification[] = [];
  for (const row of rows.value) {
    if (row.decertified_at !== null) continue;
    const current = keys.get(row.runner_id);
    const reason =
      (current === undefined
        ? null
        : await againstRegistration(row, current, kits)) ??
      observedDrift(row, seen.get(pairId(row.runner_id, row.executor_id)));
    if (reason !== null) {
      stale.push({
        runner_id: row.runner_id,
        executor_id: row.executor_id,
        model_id: row.model_id,
        compression: row.compression === 1,
        reason,
      });
    }
  }
  return stale.length === 0 ? ok([]) : decertifyPairs(db, stale);
}
