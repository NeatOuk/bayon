// §15 #12 permission mapping, gated on `toolApprovalCallback`: a denied tool is actually denied
// (always), and with the cap an approval request surfaces and, unanswered, the tool never runs.
// Without the cap the deny check alone is the §5.1 static-deny fallback: N/A only if it holds.
import { join } from "node:path";
import { StepFailed } from "../harness.js";
import type { StoredEvent } from "../types.js";
import { check, define, type Branch } from "./define.js";

export interface PermissionEvidence {
  readonly deny: {
    readonly tool: string;
    readonly markerCreated: boolean;
    readonly run: readonly StoredEvent[];
    readonly inits: readonly StoredEvent[];
  };
  readonly approval?: {
    readonly surfaced: boolean;
    readonly markerCreated: boolean;
  };
}

export function judgePermissions(e: PermissionEvidence, branch: Branch) {
  const d = e.deny;
  const calls = new Set(
    d.run.flatMap((ev) =>
      ev.kind === "tool_call" && ev.tool_name === d.tool
        ? [ev.payload.call_id]
        : [],
    ),
  );
  const ran = d.run.filter(
    (ev) =>
      ev.kind === "tool_result" &&
      calls.has(ev.payload.call_id) &&
      ev.status === "ok",
  ).length;
  const unlisted = d.inits.some(
    (i) =>
      i.kind === "session_init" &&
      i.payload.tools !== undefined &&
      !i.payload.tools.includes(d.tool),
  );
  const checks = [
    check(
      "deny_attempted",
      calls.size > 0 || unlisted,
      unlisted
        ? `${d.tool} is not offered`
        : `${calls.size} calls to ${d.tool}`,
      { precondition: true },
    ),
    check(
      "deny_enforced",
      !d.markerCreated &&
        d.run.some((ev) => ev.kind === "terminal") &&
        ran === 0,
      `marker ${d.markerCreated ? "created" : "absent"}, ${ran} ok results`,
    ),
  ];
  if (branch === "fallback" || e.approval === undefined) return checks;
  return [
    ...checks,
    check("approval_surfaced", e.approval.surfaced, null, {
      precondition: true,
    }),
    check("approval_denied", !e.approval.markerCreated),
  ];
}

export const t12 = define({
  id: 12,
  retries: 1,
  fallback: () =>
    "toolApprovalCallback=false; the static deny held: the denied tool never ran",
  drive: async (ctx, branch): Promise<PermissionEvidence> => {
    const exists = (path: string) =>
      ctx.harness("workspace", ctx.ports.workspace.exists(path));
    const live = await ctx.open({ scenario: "deny" });
    const tool = live.scenario.deniedTool;
    if (tool === undefined)
      throw new StepFailed("kit", "the deny scenario names no deniedTool");
    await live.spawn();
    const end = await live.run(live.turn(0));
    const deny = {
      tool,
      markerCreated: await exists(join(live.dirs.cwd, live.vars.marker)),
      run: end.events,
      inits: (await live.events()).filter((e) => e.kind === "session_init"),
    };
    if (branch === "fallback") return { deny };
    const a = await ctx.open({ scenario: "approval" });
    await a.spawn();
    const s = await a.start(a.turn(0));
    const request = s.sent.ok
      ? await a.waitFor(
          (e) => e.run_id === s.runId && e.kind === "approval_request",
          ctx.budgets.turnMs,
        )
      : undefined;
    await ctx.call("interrupt", ctx.subject.adapter.interrupt(a.handle));
    await s.done;
    return {
      deny,
      approval: {
        surfaced: request !== undefined,
        markerCreated: await exists(join(a.dirs.cwd, a.vars.marker)),
      },
    };
  },
  judge: judgePermissions,
});
