// The §15 suite for a runner on the smoke's executor, asked over REST as frm does. Moved here from
// m3-reads.ts: 012's admission.require_certified=1 refuses an uncertified
// runner, so every smoke certifies the runners it spawns first, and --m3 its reviewer too.
// Certification is per model: one run per model of the tiers the smoke's sessions run.
import { existsSync } from "node:fs";
import { err, newId, ok, type ModelTier } from "@bayon/core";
import { RunnerConformanceResult } from "@bayon/proto";
import { z } from "zod";
import { M3_CONFORMANCE_TIMEOUT_MS } from "./budget.js";
import { SMOKE } from "./config.js";
import { refuse, verdict } from "./harness.js";
import { conformanceProblems } from "./m3-assertions.js";
import { commandDone, type World } from "./phases.js";

/** Every tier: a runner whose suite is free (the fixture) is certified on all of its models. */
export const ALL_TIERS: readonly ModelTier[] = ["complex", "standard", "cheap"];

/**
 * Certifies `runnerId` on the smoke's executor, on each of its models of `tiers` (default the
 * cheapest, which the smoke's sessions of a real runner run); `step` prefixes the step names.
 */
export async function certify(
  w: World,
  runnerId: string,
  step = "",
  tiers: readonly ModelTier[] = ["cheap"],
): Promise<void> {
  const models = await w.h.step(
    `${step}GET /runners: ${runnerId}'s models of ${tiers.join(", ")}`,
    async () => {
      const runners = await w.api.runners();
      if (!runners.ok) return runners;
      const found = (
        runners.value.runners.find((r) => r.id === runnerId)?.models ?? []
      ).filter((m) => (tiers as readonly string[]).includes(m.tier));
      return found.length === 0
        ? err(refuse(`${runnerId} has no active model of ${tiers.join(", ")}`))
        : ok(found.map((m) => m.id));
    },
  );
  for (const modelId of models) await certifyModel(w, runnerId, modelId, step);
}

async function certifyModel(
  w: World,
  runnerId: string,
  modelId: string,
  step: string,
): Promise<void> {
  const executor = SMOKE.executor;
  const key = `smoke:conformance:${runnerId}:${modelId}:${newId(w.h.clock.now())}`;
  const done = await w.h.step(
    `${step}POST /runners/${runnerId}/conformance on ${executor} with ${modelId}: the suite ran`,
    async () => {
      const accepted = await w.api.runnerConformance(
        runnerId,
        { executor_id: executor, model_id: modelId },
        key,
      );
      if (!accepted.ok) return accepted;
      return commandDone(
        w,
        accepted.value.command_id,
        M3_CONFORMANCE_TIMEOUT_MS,
      );
    },
  );
  await w.h.step(
    `${step}${runnerId} with ${modelId} on ${executor}: a report, certified, gate_eligible=1 in GET /runners`,
    async () => {
      const r = RunnerConformanceResult.safeParse(done.result);
      if (!r.success)
        return err(
          refuse(
            `the command's result is not a conformance result: ${z.prettifyError(r.error)}`,
          ),
        );
      const runners = await w.api.runners();
      if (!runners.ok) return runners;
      const s = r.data.summary;
      w.h.note(
        `conformance ${runnerId}: ${s.passed.length} pass, ${s.na.length} N/A, report ${r.data.report_path}`,
      );
      return verdict(
        conformanceProblems(
          r.data,
          runners.value.runners.find((v) => v.id === runnerId),
          executor,
          existsSync(r.data.report_path),
        ),
      );
    },
  );
}
