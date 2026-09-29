// Session S-A: run 1 `edit` (a real file change through a tool), run 2
// `plain` on the same handle. Tests 2–6 each judge their own evidence from it; a retry makes a
// fresh S-A for the retrying test alone.
import type { Result, RunnerCaps } from "@bayon/core";
import { z } from "zod";
import type { SuiteCtx } from "../harness.js";
import type { FileDiff, StoredEvent } from "../types.js";
import {
  callIds,
  check,
  define,
  endedWith,
  outcomeOf,
  runnerTerminals,
  sameIds,
  type Branch,
} from "./define.js";

export interface SessionAEvidence {
  readonly cwd: string;
  readonly runnerSessionId: string | undefined;
  /** The latest process ref after run 1, then after run 2. */
  readonly refs: readonly [string, string];
  readonly aliveBetween: boolean;
  readonly run1: readonly StoredEvent[];
  readonly run2: {
    readonly sent: Result<void>;
    readonly events: readonly StoredEvent[];
  };
  readonly diff: readonly FileDiff[];
  readonly inits: readonly StoredEvent[];
}

export async function driveSessionA(ctx: SuiteCtx): Promise<SessionAEvidence> {
  const live = await ctx.open({ scenario: "edit" });
  const handle = await live.spawn();
  const run1 = await live.run(live.turn(0));
  const ref1 = live.latestRef();
  const aliveBetween =
    (await ctx.call("probe", ctx.subject.executor.probe(ref1))) === "alive";
  const diff = await ctx.harness(
    "workspace diff",
    ctx.ports.workspace.diff(live.dirs.cwd),
  );
  const second = await live.start(live.turn(1));
  const run2 = second.sent.ok ? (await live.finish(second)).events : [];
  return {
    cwd: live.dirs.cwd,
    runnerSessionId: handle.runnerSessionId,
    refs: [ref1, live.latestRef()],
    aliveBetween,
    run1: run1.events,
    run2: { sent: second.sent, events: run2 },
    diff,
    inits: (await live.events()).filter((e) => e.kind === "session_init"),
  };
}

const sessionA = (ctx: SuiteCtx, attempt: number): Promise<SessionAEvidence> =>
  attempt === 0
    ? ctx.shared("S-A", () => driveSessionA(ctx))
    : driveSessionA(ctx);

export function judgeSpawn(
  e: SessionAEvidence,
  _branch: Branch,
  caps: RunnerCaps,
) {
  return [
    check("session_init_seen", e.inits.length > 0),
    check(
      "one_runner_terminal_ok",
      endedWith(e.run1, "ok"),
      `${runnerTerminals(e.run1).length} runner terminals, ${outcomeOf(e.run1)}`,
    ),
    check(
      "runner_session_id",
      !caps.resumable || (e.runnerSessionId ?? "") !== "",
      caps.resumable ? (e.runnerSessionId ?? "unset") : "not resumable",
    ),
  ];
}

export const t02 = define({
  id: 2,
  retries: 1,
  drive: (ctx, _branch, attempt) => sessionA(ctx, attempt),
  judge: judgeSpawn,
});

const runnerSessionIds = (inits: readonly StoredEvent[]): Set<string> =>
  new Set(
    inits.flatMap((i) =>
      i.kind === "session_init" ? [i.payload.runner_session_id] : [],
    ),
  );

export function judgeMultiTurn(
  e: SessionAEvidence,
  branch: Branch,
  caps: RunnerCaps,
) {
  const secondOk = e.run2.sent.ok && endedWith(e.run2.events, "ok");
  if (branch === "cap") {
    return [
      check("second_turn_ok", secondOk, outcomeOf(e.run2.events)),
      check(
        "no_respawn",
        e.refs[0] === e.refs[1] && e.aliveBetween,
        `${e.refs[0]} → ${e.refs[1]}, ${e.aliveBetween ? "alive" : "dead"} between runs`,
      ),
    ];
  }
  if (caps.resumable) {
    return [
      check(
        "resume_path_ok",
        secondOk && runnerSessionIds(e.inits).size <= 1,
        `${outcomeOf(e.run2.events)}, ${runnerSessionIds(e.inits).size} runner session ids`,
      ),
    ];
  }
  return [
    check(
      "second_send_refused",
      !e.run2.sent.ok,
      e.run2.sent.ok ? "the second send was accepted" : e.run2.sent.error.class,
    ),
  ];
}

export const t03 = define({
  id: 3,
  retries: 1,
  fallback: (caps) =>
    caps.resumable
      ? "multiTurnInProcess=false; turn 2 resumed the same runner session on one handle"
      : "multiTurnInProcess=false, resumable=false; a second send is refused",
  drive: (ctx, _branch, attempt) => sessionA(ctx, attempt),
  judge: judgeMultiTurn,
});

export function judgeToolCalls(e: SessionAEvidence) {
  const calls = callIds(e.run1, "tool_call");
  const results = callIds(e.run1, "tool_result");
  return [
    check("tool_call_seen", calls.length > 0, `${calls.length} tool calls`, {
      precondition: true,
    }),
    check(
      "call_ids_paired",
      sameIds(calls, results),
      `${calls.length} calls, ${results.length} results`,
    ),
  ];
}

export const t04 = define({
  id: 4,
  retries: 1,
  drive: (ctx, _branch, attempt) => sessionA(ctx, attempt),
  judge: judgeToolCalls,
});

interface Change {
  readonly path: string;
  readonly change: FileDiff["change"];
  readonly added: number | undefined;
  readonly removed: number | undefined;
}

const relative = (cwd: string, path: string): string =>
  path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;

const sum = (xs: readonly (number | undefined)[]): number =>
  xs.reduce<number>((n, x) => n + (x ?? 0), 0);

export function judgeFileChanges(e: SessionAEvidence) {
  const changes: readonly Change[] = e.run1.flatMap((ev) =>
    ev.kind === "file_change"
      ? [
          {
            path: relative(e.cwd, ev.payload.path),
            change: ev.payload.change,
            added: ev.payload.lines_added,
            removed: ev.payload.lines_removed,
          },
        ]
      : [],
  );
  const byPath = Map.groupBy(changes, (c) => c.path);
  const eventPaths = [...byPath.keys()];
  const diffPaths = e.diff.map((d) => d.path);
  const kindsMatch = e.diff.every(
    (d) => byPath.get(d.path)?.[0]?.change === d.change,
  );
  const countsMatch = e.diff.every((d) => {
    const reported = byPath.get(d.path) ?? [];
    const counted = reported.every(
      (c) => c.added !== undefined && c.removed !== undefined,
    );
    return (
      reported.length === 0 ||
      !counted ||
      (sum(reported.map((c) => c.added)) === d.added &&
        sum(reported.map((c) => c.removed)) === d.removed)
    );
  });
  return [
    check(
      "file_change_seen",
      changes.length > 0,
      `${changes.length} file changes`,
      { precondition: true },
    ),
    check(
      "paths_match",
      sameIds(eventPaths, diffPaths) && kindsMatch,
      `events [${eventPaths.join(", ")}] vs git [${e.diff.map((d) => `${d.path}:${d.change}`).join(", ")}]`,
    ),
    check("line_counts_match", countsMatch),
  ];
}

export const t05 = define({
  id: 5,
  retries: 1,
  drive: (ctx, _branch, attempt) => sessionA(ctx, attempt),
  judge: judgeFileChanges,
});

const SpendShape = z.looseObject({
  tokens_in: z.number(),
  tokens_out: z.number(),
  cost_usd: z.number(),
  cost_source: z.string(),
});

export interface UsageEvidence {
  readonly a: SessionAEvidence;
  readonly estimate: number;
}

export function judgeUsage(e: UsageEvidence, branch: Branch) {
  const terminal = runnerTerminals(e.a.run1).find((t) => t.kind === "terminal");
  const parsed = SpendShape.safeParse(
    terminal?.kind === "terminal" ? terminal.payload["spend"] : undefined,
  );
  const s = parsed.success ? parsed.data : undefined;
  const shown =
    s === undefined
      ? "no spend on the terminal"
      : `${s.tokens_in}+${s.tokens_out} tokens, $${s.cost_usd} ${s.cost_source}`;
  const usage =
    branch === "cap"
      ? check(
          "reported_usage",
          s !== undefined &&
            s.tokens_in + s.tokens_out > 0 &&
            s.cost_usd >= 0 &&
            s.cost_source === "reported",
          shown,
        )
      : check(
          "estimated_usage",
          s !== undefined && s.cost_source === "estimated" && s.cost_usd > 0,
          shown,
        );
  return [
    usage,
    check(
      "estimate_tokens",
      Number.isInteger(e.estimate) && e.estimate > 0,
      String(e.estimate),
    ),
  ];
}

export const t06 = define({
  id: 6,
  retries: 1,
  fallback: () =>
    "costReporting=false; spend was estimated from the model prices",
  drive: async (ctx, _branch, attempt): Promise<UsageEvidence> => {
    const a = await sessionA(ctx, attempt);
    const text = ctx.subject.kit.scenario("plain", ctx.vars()).turns[0] ?? "";
    return {
      a,
      estimate: await ctx.call(
        "estimateTokens",
        ctx.subject.adapter.estimateTokens(text || "Reply with OK."),
      ),
    };
  },
  judge: judgeUsage,
});
