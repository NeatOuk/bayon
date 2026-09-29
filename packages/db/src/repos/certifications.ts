// Conformance certification per (runner, executor, model, compression) (§15;
// 045; 049) and the probe tokens test 11 calls /mcp with (009_conformance). The
// supervisor writes both (§9.5); the API reads them. A certificate holds for the one model it was
// earned on, and for sessions whose context is compressed exactly when it was earned compressed.
import { err, newId, ok } from "@bayon/core";
import { sql, type Selectable } from "kysely";
import { z } from "zod";
import {
  all,
  execute,
  first,
  qb,
  read,
  returningOne,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import type {
  ConformanceProbesTable,
  RunnerCertificationsTable,
} from "../schema.js";

export type RunnerCertificationRow = Selectable<RunnerCertificationsTable>;
export type ConformanceProbeRow = Selectable<ConformanceProbesTable>;

/** A certifiable result's row: the caller derives the flags from core certify(), never elsewhere. */
export interface NewCertification {
  readonly runner_id: string;
  readonly executor_id: string;
  /** The models row the suite ran (045): part of the key. */
  readonly model_id: string;
  /**
   * Earned with context compression on (049, spec M12): part of the key. The caller takes it from
   * the result's own `compression`, never from what was asked. Absent: off.
   */
  readonly compression?: boolean;
  /** Its model string as the suite spawned it: a pin. */
  readonly model: string;
  readonly runner_version: string;
  readonly suite_version: string;
  readonly kit_hash: string;
  readonly caps_hash: string;
  readonly result_json: string;
  readonly report_path: string | null;
  readonly gate_eligible: boolean;
  readonly passed_at: number | null;
}

export interface Decertification {
  readonly runner_id: string;
  readonly executor_id: string;
  readonly model_id: string;
  /** Which of the model's two certificates (049): with compression on, or off. */
  readonly compression: boolean;
  readonly reason: string;
}

/** A runner as eligible on one executor with one model: pickReviewer's ReviewerRunner, from that
 * triple alone. */
export interface RunnerEligibility {
  readonly id: string;
  readonly enabled: number;
  readonly gate_eligible: number;
  readonly conformance_passed_at: number | null;
}

const Summary = z.object({ summary: z.json() });

/** The stored result's summary as JSON text, for runners.conformance_json; null if unreadable. */
function summaryOf(resultJson: string): string | null {
  try {
    const parsed = Summary.safeParse(JSON.parse(resultJson));
    return parsed.success ? JSON.stringify(parsed.data.summary) : null;
  } catch {
    return null;
  }
}

/**
 * The runners row as a roll-up of its live certificates (009, 045): gate eligible and unattended
 * on at least one (executor, model), and the latest certification's version, report and summary.
 * Compression-off certificates only (049): the row is the runner's normal badge, and a
 * compression-on certificate is shown as such where it is asked for.
 */
function rollUp(ix: Internals, runnerId: string): void {
  const pairs = all(
    ix,
    qb
      .selectFrom("runner_certifications")
      .selectAll()
      .where("runner_id", "=", runnerId)
      .where("compression", "=", 0)
      .where("decertified_at", "is", null)
      .orderBy("certified_at", "desc")
      .orderBy("executor_id")
      .orderBy("model_id"),
  );
  const latest = pairs[0];
  const passed = pairs.flatMap((p) =>
    p.passed_at === null ? [] : [p.passed_at],
  );
  execute(
    ix,
    qb
      .updateTable("runners")
      .set({
        gate_eligible: pairs.some((p) => p.gate_eligible === 1) ? 1 : 0,
        conformance_passed_at: passed.length === 0 ? null : Math.max(...passed),
        conformance_version: latest?.runner_version ?? null,
        conformance_report_path: latest?.report_path ?? null,
        conformance_json:
          latest === undefined ? null : summaryOf(latest.result_json),
      })
      .where("id", "=", runnerId),
  );
}

/** Stores the key's certification, replacing its last and clearing any decertification. */
export function storeCertification(
  db: Db,
  c: NewCertification,
): R<RunnerCertificationRow> {
  return write(db, (ix) => {
    const row = {
      model: c.model,
      runner_version: c.runner_version,
      suite_version: c.suite_version,
      kit_hash: c.kit_hash,
      caps_hash: c.caps_hash,
      result_json: c.result_json,
      report_path: c.report_path,
      gate_eligible: c.gate_eligible ? 1 : 0,
      passed_at: c.passed_at,
      certified_at: ix.clock.now(),
      decertified_at: null,
      decertified_reason: null,
    };
    const stored = returningOne(
      ix,
      qb
        .insertInto("runner_certifications")
        .values({
          runner_id: c.runner_id,
          executor_id: c.executor_id,
          model_id: c.model_id,
          compression: c.compression === true ? 1 : 0,
          ...row,
        })
        .onConflict((oc) =>
          oc
            .columns(["runner_id", "executor_id", "model_id", "compression"])
            .doUpdateSet(row),
        )
        .returningAll(),
    );
    if (!stored.ok) return stored;
    rollUp(ix, c.runner_id);
    return ok(stored.value);
  });
}

/**
 * Clears each live pair's flags and records why; the result stays for the record. A pair already
 * decertified keeps its first reason. Returns the pairs it decertified: one another writer got to
 * first is not among them, so each decertification is reported once.
 */
export function decertifyPairs(
  db: Db,
  pairs: readonly Decertification[],
): R<Decertification[]> {
  return write(db, (ix) => {
    const now = ix.clock.now();
    const changed: Decertification[] = [];
    for (const p of pairs) {
      const hit = first(
        ix,
        qb
          .updateTable("runner_certifications")
          .set({
            gate_eligible: 0,
            passed_at: null,
            decertified_at: now,
            decertified_reason: p.reason,
          })
          .where("runner_id", "=", p.runner_id)
          .where("executor_id", "=", p.executor_id)
          .where("model_id", "=", p.model_id)
          .where("compression", "=", p.compression ? 1 : 0)
          .where("decertified_at", "is", null)
          .returning("runner_id"),
      );
      if (hit === undefined) continue;
      changed.push(p);
      rollUp(ix, p.runner_id);
    }
    return ok(changed);
  });
}

export function listRunnerCertifications(db: Db): R<RunnerCertificationRow[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("runner_certifications")
        .selectAll()
        .orderBy("runner_id")
        .orderBy("executor_id")
        .orderBy("model_id")
        .orderBy("compression"),
    ),
  );
}

/**
 * The one predicate for a certificate unattended runs may use (§15): tests 9, 10 and 14 passed on
 * a certifiable run, and not decertified since. Admission (getLiveCertification) and reviewer
 * selection (listRunnerEligibility) share it, so they can never disagree.
 * It names the table `rc`.
 */
const LIVE_PAIR = sql<boolean>`rc.passed_at IS NOT NULL AND rc.decertified_at IS NULL`;

/**
 * The certification of (runner, executor, model, compression) when it is live (LIVE_PAIR); null
 * when none holds. Only that model's: a certificate earned on another model of the runner never
 * answers (045). Only that compression's (049): a session whose context is compressed is admitted on
 * a certificate earned compressed, and one whose context is not on one earned without.
 */
export async function getLiveCertification(
  db: Db,
  runnerId: string,
  executorId: string,
  modelId: string,
  compression: boolean,
): R<RunnerCertificationRow | null> {
  const found = await read(db, (ix) =>
    first(
      ix,
      qb
        .selectFrom("runner_certifications as rc")
        .selectAll()
        .where("rc.runner_id", "=", runnerId)
        .where("rc.executor_id", "=", executorId)
        .where("rc.model_id", "=", modelId)
        .where("rc.compression", "=", compression ? 1 : 0)
        .where(LIVE_PAIR),
    ),
  );
  return found.ok ? ok(found.value ?? null) : found;
}

/**
 * Every runner as eligible on `executorId` with the model it would run there ( * pickReviewer input; 045): the live certificate of (runner, executor, model) for the one model of
 * `modelIds` that is the runner's, its gate_eligible and passed_at (LIVE_PAIR). A runner none of
 * `modelIds` belongs to, or with no live certificate of that model there, is not eligible. A model
 * id is one runner's (models.runner_id), so each runner joins at most one certificate: the
 * compression-on one for a model in `compressedModelIds` (its session would run compressed, 049),
 * else the compression-off one.
 */
export function listRunnerEligibility(
  db: Db,
  executorId: string,
  modelIds: readonly string[],
  compressedModelIds: readonly string[] = [],
): R<RunnerEligibility[]> {
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("runners")
        .leftJoin("runner_certifications as rc", (j) =>
          j
            .onRef("rc.runner_id", "=", "runners.id")
            .on("rc.executor_id", "=", executorId)
            .on(
              modelIds.length === 0
                ? sql<boolean>`0`
                : sql<boolean>`rc.model_id IN (${sql.join(modelIds)})`,
            )
            .on(
              compressedModelIds.length === 0
                ? sql<boolean>`rc.compression = 0`
                : sql<boolean>`rc.compression = (rc.model_id IN (${sql.join(compressedModelIds)}))`,
            )
            .on(LIVE_PAIR),
        )
        .select([
          "runners.id",
          "runners.enabled",
          "rc.gate_eligible",
          "rc.passed_at",
        ])
        .orderBy("runners.id"),
    ).map((r) => ({
      id: r.id,
      enabled: r.enabled,
      gate_eligible: r.gate_eligible ?? 0,
      conformance_passed_at: r.passed_at,
    })),
  );
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface NewConformanceProbe {
  readonly token_hash: string;
  readonly toolset_hash: string;
  readonly runner_id: string;
  readonly executor_id: string;
  /** The run's model (045); null when the caller runs none of the runner's rows. */
  readonly model_id?: string | null;
  readonly expires_at: number;
}

/** A probe token for one suite run: /mcp serves it conformance_echo until expires_at. */
export function openConformanceProbe(
  db: Db,
  p: NewConformanceProbe,
): R<ConformanceProbeRow> {
  if (!SHA256_HEX.test(p.token_hash)) {
    return Promise.resolve(
      err(failure("validation", "a token hash is 64 lowercase hex characters")),
    );
  }
  return write(db, (ix) => {
    const now = ix.clock.now();
    return returningOne(
      ix,
      qb
        .insertInto("conformance_probes")
        .values({
          ...p,
          model_id: p.model_id ?? null,
          id: newId(now),
          created_at: now,
        })
        .returningAll(),
    );
  });
}

/** Ends a probe now: its token stops working. An ended or unknown probe is left as it is. */
export function closeConformanceProbe(db: Db, id: string): R<void> {
  return write(db, (ix) => {
    const now = ix.clock.now();
    execute(
      ix,
      qb
        .updateTable("conformance_probes")
        .set({ expires_at: now })
        .where("id", "=", id)
        .where("expires_at", ">", now),
    );
    return ok(undefined);
  });
}

/** The unexpired probe holding `tokenHash`, or null: the API's /mcp auth for test 11. */
export function findLiveConformanceProbe(
  db: Db,
  tokenHash: string,
): R<ConformanceProbeRow | null> {
  return read(
    db,
    (ix) =>
      first(
        ix,
        qb
          .selectFrom("conformance_probes")
          .selectAll()
          .where("token_hash", "=", tokenHash)
          .where("expires_at", ">", ix.clock.now()),
      ) ?? null,
  );
}
