// finding_resolve (§10.3, §11.1): a builder marks a review finding on its own
// ticket fixed. The fixing run is the caller's open run, derived by the server, never named by the
// model; the writer refuses a finding on another ticket (its run works this one) in its transaction.
import { LawRefusalCause } from "@bayon/core";
import { MCP_INPUTS } from "@bayon/proto";
import {
  done,
  failed,
  refused,
  type Handler,
  type ToolCtx,
} from "./tool-kit.js";

const auditOf = (ctx: ToolCtx, findingId: string) =>
  ctx.audit("finding", findingId);

export const findingResolve: Handler = async (ctx, raw) => {
  const input = MCP_INPUTS.finding_resolve.parse(raw);
  const run = await ctx.store.openRun(ctx.session.id);
  if (!run.ok) return failed(run.error);
  if (run.value === null) {
    return refused({
      reason: "missing_evidence",
      rule: "finding_resolve",
      detail:
        "this session has no open run: a resolution names the run that fixed it",
    });
  }
  const resolved = await ctx.store.resolveFinding(
    {
      finding_id: input.finding,
      run_id: run.value,
      note: input.note,
      by: { actor_kind: "session", actor_id: ctx.session.id },
    },
    auditOf(ctx, input.finding),
  );
  if (resolved.ok) {
    return done({
      finding_id: resolved.value.id,
      status: resolved.value.status,
      resolved_by_run_id: resolved.value.resolved_by_run_id,
    });
  }
  const e = resolved.error;
  const cause = LawRefusalCause.safeParse(e.cause);
  if (e.class === "law_refused" && cause.success) {
    return refused({
      reason: "cross_ticket_write",
      rule: "finding_resolve",
      detail: cause.data.detail,
    });
  }
  if (e.class === "conflict") {
    return refused({
      reason: "illegal_transition",
      rule: "finding_resolve",
      detail: e.message,
    });
  }
  if (e.class === "not_found") {
    return refused({ reason: "not_found", detail: e.message });
  }
  return failed(e);
};
