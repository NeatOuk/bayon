// §15 #8 kill + adopt: kill -9 mid-run (after the run's tool_call is stored; a turn-per-process
// runner has no idle process), then adopt by the runner session id: run 3 recalls what run 1 was
// told. Run 2's own outcome is test 9's business. Fallback: adopt is a typed error.
import { err, type Result } from "@bayon/core";
import type { SessionHandle } from "../../adapter.js";
import { frmError } from "../../errors.js";
import { settlesWithin } from "../../wait.js";
import { probesDeadWithin } from "../groups.js";
import type { StoredEvent } from "../types.js";
import { check, define, endedWith, outcomeOf, type Branch } from "./define.js";

export type KillAdoptEvidence =
  | {
      readonly branch: "cap";
      readonly nonce: string;
      readonly remembered: readonly StoredEvent[];
      readonly toolCallSeen: boolean;
      readonly dead: boolean;
      readonly reclaim: Result<unknown> | undefined;
      readonly adopted: Result<SessionHandle> | undefined;
      readonly recalled: readonly StoredEvent[];
    }
  | {
      readonly branch: "fallback";
      readonly adopted: Result<SessionHandle>;
    };

export function judgeKillAdopt(e: KillAdoptEvidence) {
  if (e.branch === "fallback") {
    return [
      check(
        "adopt_refused",
        !e.adopted.ok,
        e.adopted.ok ? "adopt started a fresh session" : e.adopted.error.class,
      ),
    ];
  }
  const seen = check("tool_call_seen", e.toolCallSeen, null, {
    precondition: true,
  });
  const texts = e.recalled.flatMap((ev) =>
    ev.kind === "assistant_text" ? [ev.text] : [],
  );
  return [
    check(
      "remember_ok",
      endedWith(e.remembered, "ok"),
      outcomeOf(e.remembered),
    ),
    seen,
    check("process_dead", e.dead),
    check(
      "reclaim_ok",
      e.reclaim?.ok === true,
      e.reclaim === undefined || e.reclaim.ok ? null : e.reclaim.error.message,
    ),
    check(
      "adopt_ok",
      e.adopted?.ok === true,
      e.adopted === undefined || e.adopted.ok ? null : e.adopted.error.message,
    ),
    check("recall_ok", endedWith(e.recalled, "ok"), outcomeOf(e.recalled)),
    check(
      "nonce_recalled",
      texts.some((t) => t.includes(e.nonce)),
      `${texts.length} replies`,
    ),
  ];
}

export const t08 = define({
  id: 8,
  retries: 1,
  fallback: () => "resumable=false; adopt is refused with a typed error",
  drive: async (ctx, branch: Branch): Promise<KillAdoptEvidence> => {
    const { executor, adapter } = ctx.subject;
    if (branch === "fallback") {
      const live = await ctx.open({ scenario: "plain" });
      const home = await live.prepareHome();
      const adopted = home.ok
        ? await live.adopt("frm-conformance-no-such-session")
        : err(frmError("internal", home.error.message));
      return { branch, adopted };
    }
    const live = await ctx.open({ scenario: "resume" });
    await live.spawn();
    const remembered = (await live.run(live.turn(0))).events;
    const slow = await live.start(live.turn(1));
    const call = slow.sent.ok
      ? await live.waitFor(
          (e) => e.run_id === slow.runId && e.kind === "tool_call",
          ctx.budgets.turnMs,
        )
      : undefined;
    const base = {
      branch,
      nonce: live.vars.nonce,
      remembered,
      toolCallSeen: call !== undefined,
      dead: false,
      reclaim: undefined,
      adopted: undefined,
      recalled: [],
    } as const;
    if (call === undefined) return base;
    const ref = live.latestRef();
    executor.kill9(live.dirs.cwd);
    const exited = executor.exitedOf(live.dirs.cwd);
    const gone =
      exited !== undefined &&
      (await settlesWithin(exited, ctx.clock, ctx.budgets.callMs));
    await ctx.call("ingest ended", ctx.ports.ingest.ended(live.sessionId));
    await slow.done;
    const dead =
      gone &&
      (await probesDeadWithin(
        () => ctx.call("probe", executor.probe(ref)),
        ctx.clock,
        ctx.budgets.callMs,
      ));
    const resumeId = live.handle.runnerSessionId;
    const reclaim = await live.prepareHome();
    const adopted =
      resumeId === undefined
        ? err(frmError("validation", "the handle carries no runner session id"))
        : await live.adopt(resumeId);
    const recalled = adopted.ok ? (await live.run(live.turn(2))).events : [];
    void adapter;
    return { ...base, dead, reclaim, adopted, recalled };
  },
  judge: judgeKillAdopt,
});
