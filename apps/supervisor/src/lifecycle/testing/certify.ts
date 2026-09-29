// Test-only: a certified (runner, executor) pair on each of its models, stored the way
// the conformance command stores one: a passing draft through core certify(), then the supervisor
// writer. Nothing here bypasses certify(); rigs call it so they run on 012's
// real require_certified=1.
import {
  CONFORMANCE_TEST_NAMES,
  CONTEXT_RULESET,
  GATING_CAP,
  SUITE_VERSION,
  capsHash,
  certificationFlags,
  certify,
  expectedTestIds,
  type RunnerCaps,
} from "@bayon/core";
import { listModels, type Db } from "@bayon/db";
import { storeCertification } from "@bayon/db/supervisor";
import { FAKE_IMAGE_ID } from "@bayon/executors/testing";

export interface PairToCertify {
  readonly runnerId: string;
  readonly runnerVersion: string;
  readonly caps: RunnerCaps;
  readonly executorId: string;
  readonly executorKind?: "local" | "container";
  readonly at: number;
  /**
   * The image the pair was certified inside. A container pair certifies for unattended work only
   * with one: on a container it is the only pin there is, so the rigs give one
   * the way a real run does. Pass null to store the pair a rig means to be uncertifiable.
   */
  readonly imageId?: string | null;
  /**
   * The kit hash the certification pins. Default a placeholder, which the next boot's
   * re-registration lapses (decertify.ts): a rig that restarts a supervisor passes the real one,
   * from currentKey (plug test).
   */
  readonly kitHash?: string;
  /**
   * The models rows to certify, by id (certification is per model). Default: every
   * active model of the runner, so a rig's sessions are admitted whatever tier they run.
   */
  readonly modelIds?: readonly string[];
  /**
   * Earned with context compression on: test 17 passes too, and the row is the
   * compression-on certificate a project that compresses needs. Default off.
   */
  readonly compression?: boolean;
}

/**
 * What a rig's container pair pins when it names no image of its own: the id the
 * loopback's stand-in docker reports, so the rig's pair holds through a health pass the way a real
 * one does — a pair pinned to any other id is decertified on the first re-detect, which is the
 * point of pinning it.
 */
export const RIG_IMAGE_ID = FAKE_IMAGE_ID;

/**
 * Stores a live certification for the pair on each model: every test passes, or is N/A where its
 * cap is absent.
 */
export async function certifyPair(db: Db, p: PairToCertify): Promise<void> {
  const models = await listModels(db);
  if (!models.ok) throw new Error(models.error.message);
  const mine = models.value.filter(
    (m) =>
      m.runner_id === p.runnerId &&
      (p.modelIds === undefined ? m.active === 1 : p.modelIds.includes(m.id)),
  );
  if (mine.length === 0) {
    throw new Error(
      `runner ${p.runnerId} has no model to certify: register it (or seed its models) first`,
    );
  }
  for (const m of mine) await certifyOne(db, p, m.id, m.model);
}

async function certifyOne(
  db: Db,
  p: PairToCertify,
  modelId: string,
  model: string,
): Promise<void> {
  const kind = p.executorKind ?? "local";
  const compression =
    p.compression === true ? { ruleset: CONTEXT_RULESET } : undefined;
  const draft = {
    schema: 1,
    suite_version: SUITE_VERSION,
    runner_id: p.runnerId,
    runner_version: p.runnerVersion,
    model,
    executor: {
      id: p.executorId,
      kind,
      image_id:
        p.imageId !== undefined
          ? p.imageId
          : kind === "container"
            ? RIG_IMAGE_ID
            : null,
    },
    started_at: p.at,
    finished_at: p.at,
    kit_hash: p.kitHash ?? "sha256:rig-kit",
    ...(compression === undefined ? {} : { compression }),
    ports: {
      ingest: "supervisor",
      watchdog: "supervisor",
      mcp: "supervisor",
      workspace: "supervisor",
    },
    caps: p.caps,
    spend: { tokens_in: 0, tokens_out: 0, cost_usd: 0 },
    tests: expectedTestIds(compression !== undefined).map((id) => {
      const cap = GATING_CAP[id];
      const na = cap !== undefined && !p.caps[cap];
      return {
        id,
        name: CONFORMANCE_TEST_NAMES[id],
        status: na ? "na" : "pass",
        attempts: 1,
        duration_ms: 1,
        fallback: na ? "the fallback held" : null,
        checks: [{ name: "held", ok: true, detail: null }],
      };
    }),
  };
  const result = certify(draft);
  if (!result.ok) throw new Error(result.error.message);
  const flags = certificationFlags(result.value);
  const stored = await storeCertification(db, {
    runner_id: p.runnerId,
    executor_id: p.executorId,
    model_id: modelId,
    compression: compression !== undefined,
    model,
    runner_version: p.runnerVersion,
    suite_version: SUITE_VERSION,
    kit_hash: draft.kit_hash,
    caps_hash: await capsHash(result.value.caps),
    result_json: JSON.stringify(result.value),
    report_path: null,
    gate_eligible: flags.gate_eligible,
    passed_at: flags.passed_at,
  });
  if (!stored.ok) throw new Error(stored.error.message);
}
