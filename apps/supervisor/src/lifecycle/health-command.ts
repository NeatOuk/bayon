// `executor.health` (§6.1): `POST /executors/:id/health` asks, and the
// supervisor runs the executor's check exactly as the reconciler does (§9.6 step 7), recording
// `health` and `health_detail`. Off the claim loop: a container's check can take its health_ms.
import { ok } from "@bayon/core";
import { getExecutor } from "@bayon/db";
import { ExecutorHealthPayload } from "@bayon/proto";
import type { Ctx } from "./context.js";
import { checkHealth } from "./health.js";
import type { CommandHandler } from "./ports.js";

export function executorHealthHandler(
  ctx: Ctx,
): CommandHandler<ExecutorHealthPayload> {
  return {
    type: "executor.health",
    payload: ExecutorHealthPayload,
    background: true,
    idempotent: true, // a re-check
    async handle(p) {
      const row = await getExecutor(ctx.db, p.executor_id);
      if (!row.ok) return row;
      const health = await checkHealth(ctx, row.value);
      return ok({ executor_id: p.executor_id, health });
    },
  };
}
