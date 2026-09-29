// Every judge on canned evidence: the verdict logic without processes.
import { err, ok, type CanonicalEvent, type RunnerCaps } from "@bayon/core";
import { describe, expect, test } from "vitest";
import type { StoredEvent } from "../types.js";
import { isInterruptExit, runnerTerminals } from "./define.js";
import {
  judgeMultiTurn,
  judgeUsage,
  type SessionAEvidence,
} from "./session-a.js";
import { judgeVersion } from "./t01-version.js";
import { judgeInterrupt } from "./t07-interrupt.js";
import { judgeKillAdopt } from "./t08-kill-adopt.js";
import { judgeNoTerminal } from "./t09-no-terminal.js";
import { judgeUnknown } from "./t10-unknown.js";
import { judgeMcp } from "./t11-mcp.js";
import { judgePermissions } from "./t12-permissions.js";
import { judgeReview } from "./t13-review.js";
import { judgeHomeClaim } from "./t14-home.js";
import { judgeConcurrentHome } from "./t15-concurrent-home.js";
import { judgeRoots } from "./t16-roots.js";

const CAPS: RunnerCaps = {
  structuredEvents: true,
  multiTurnInProcess: true,
  resumable: true,
  concurrentSessions: true,
  costReporting: true,
  tokenCounting: false,
  toolApprovalCallback: false,
  sandboxModes: false,
  mcpClient: true,
  hooks: false,
  pty: false,
  outputSchema: false,
  imageInput: false,
  subagents: false,
};

let seq = 0;
function stored(
  e: Omit<CanonicalEvent, "ts" | "runner_type">,
  source: StoredEvent["source"] = "runner",
): StoredEvent {
  seq += 1;
  return { ts: seq, runner_type: "t", ...e, source, seq } as StoredEvent;
}
const terminal = (
  outcome: string,
  extra: object = {},
  source?: StoredEvent["source"],
) =>
  stored({ kind: "terminal", payload: { outcome, ...extra } } as never, source);
const text = (t: string) =>
  stored({ kind: "assistant_text", text: t, payload: {} } as never);
const call = (id: string, tool = "shell") =>
  stored({
    kind: "tool_call",
    tool_name: tool,
    payload: { call_id: id },
  } as never);
const result = (id: string, status: "ok" | "error" = "ok", tool = "shell") =>
  stored({
    kind: "tool_result",
    tool_name: tool,
    status,
    payload: { call_id: id },
  } as never);
const names = (checks: readonly { name: string; ok: boolean }[]) =>
  Object.fromEntries(checks.map((c) => [c.name, c.ok]));

const sessionA = (o: Partial<SessionAEvidence> = {}): SessionAEvidence => ({
  cwd: "/w",
  runnerSessionId: "rs",
  refs: ["r1", "r1"],
  aliveBetween: true,
  run1: [
    terminal("ok", {
      spend: {
        tokens_in: 1,
        tokens_out: 1,
        cost_usd: 0.1,
        cost_source: "reported",
      },
    }),
  ],
  run2: { sent: ok(undefined), events: [terminal("ok")] },
  diff: [],
  inits: [],
  ...o,
});

describe("judges", () => {
  test("1: a version, and health answering with one", () => {
    expect(
      names(judgeVersion({ version: "1.0", health: ok({ version: "1.0" }) })),
    ).toEqual({ version_captured: true, health_ok: true });
    expect(
      names(
        judgeVersion({
          version: " ",
          health: err({ class: "not_found", message: "x", retryable: false }),
        }),
      ),
    ).toEqual({ version_captured: false, health_ok: false });
  });

  test("3: a respawn fails the in-process branch; the fallbacks are resume or refusal", () => {
    expect(
      names(judgeMultiTurn(sessionA({ refs: ["r1", "r2"] }), "cap", CAPS)),
    ).toEqual({ second_turn_ok: true, no_respawn: false });
    expect(names(judgeMultiTurn(sessionA(), "fallback", CAPS))).toEqual({
      resume_path_ok: true,
    });
    const refused = sessionA({
      run2: {
        sent: err({ class: "conflict", message: "x", retryable: false }),
        events: [],
      },
    });
    expect(
      names(judgeMultiTurn(refused, "fallback", { ...CAPS, resumable: false })),
    ).toEqual({ second_send_refused: true });
    expect(
      names(
        judgeMultiTurn(sessionA(), "fallback", { ...CAPS, resumable: false }),
      ),
    ).toEqual({ second_send_refused: false });
  });

  test("6: reported spend for the cap, estimated spend for the fallback", () => {
    expect(names(judgeUsage({ a: sessionA(), estimate: 3 }, "cap"))).toEqual({
      reported_usage: true,
      estimate_tokens: true,
    });
    expect(
      names(judgeUsage({ a: sessionA(), estimate: 0 }, "fallback")),
    ).toEqual({ estimated_usage: false, estimate_tokens: false });
  });

  test("7: an interrupt+exit terminal from the adapter counts, and a leaked call id fails", () => {
    const base = {
      toolCallSeen: true,
      interrupt: ok(undefined),
      endedInTime: true,
      elapsedMs: 100,
      interruptMs: 5_000,
      run1: [call("c1"), terminal("interrupted", { basis: "interrupt+exit" })],
      run2: { sent: ok(undefined), events: [result("c1"), terminal("ok")] },
    };
    expect(names(judgeInterrupt(base))).toMatchObject({
      interrupted_within_5s: true,
      no_cross_run_attribution: false,
    });
    expect(judgeInterrupt({ ...base, toolCallSeen: false })).toEqual([
      expect.objectContaining({
        name: "tool_call_seen",
        ok: false,
        precondition: true,
      }),
    ]);
  });

  test("8: the fallback wants a refused adopt", () => {
    expect(
      names(
        judgeKillAdopt({
          branch: "fallback",
          adopted: err({ class: "validation", message: "x", retryable: false }),
        }),
      ),
    ).toEqual({ adopt_refused: true });
  });

  test("9: interrupt+exit is allowed after the stall, never after a bare kill -9", () => {
    const e = {
      sentAt: 0,
      hangMs: 100,
      watch: {
        by: "watchdog" as const,
        outcome: "timeout" as const,
        firedAt: 100,
      },
      firstEventSeen: true,
      aliveAtFire: true,
      deadAfter: true,
      midRun: true,
      stalled: [
        terminal("timeout", {}, "supervisor"),
        stored({
          kind: "runner_native",
          payload: {
            raw: { outcome: "interrupted", basis: "interrupt+exit" },
            demoted_kind: "terminal",
          },
        } as never),
      ],
      killed: [
        terminal(
          "failed",
          {
            error: {
              class: "runner_exited_without_terminal",
              message: "x",
              retryable: false,
            },
          },
          "supervisor",
        ),
      ],
    };
    expect(isInterruptExit(e.stalled[1] as StoredEvent)).toBe(true);
    expect(runnerTerminals(e.stalled)).toHaveLength(1);
    expect(names(judgeNoTerminal(e))).toMatchObject({
      no_runner_terminal: true,
      closed_without_terminal: true,
    });
    const lied = {
      ...e,
      killed: [
        terminal("interrupted", { basis: "interrupt+exit" }),
        ...e.killed,
      ],
    };
    expect(names(judgeNoTerminal(lied))).toMatchObject({
      no_runner_terminal: false,
      closed_without_terminal: false,
    });
  });

  test("10: each nonce once, as runner_native", () => {
    const native = (nonce: string) =>
      stored({ kind: "runner_native", payload: { raw: { nonce } } } as never);
    const e = {
      nonces: [
        { nonce: "n0", lines: 1 },
        { nonce: "n1", lines: 1 },
      ],
      fatal: false,
      events: [
        text("a"),
        native("n0"),
        native("n1"),
        text("b"),
        terminal("ok"),
      ],
    };
    expect(names(judgeUnknown(e))).toEqual({
      unknown_stored: true,
      events_after_injection: true,
      own_terminal_ok: true,
      ingest_alive: true,
    });
    expect(
      names(
        judgeUnknown({ ...e, events: [text("a"), text("b"), terminal("ok")] }),
      ),
    ).toMatchObject({ unknown_stored: false });
  });

  test("11: the token must not be in argv, the raw log or an event", () => {
    const e = {
      branch: "cap" as const,
      nonce: "n",
      token: "tok-0123456789abcdef",
      calls: [
        { tool: "conformance_echo", args: { nonce: "n" }, bearerOk: true },
      ],
      run: [
        stored({
          kind: "mcp_call",
          tool_name: "conformance_echo",
          payload: { server: "s", outcome: "ok" },
        } as never),
        terminal("ok"),
      ],
      all: [],
      argv: [["node", "x"]] as const,
      raw: "",
    };
    expect(names(judgeMcp(e))).toEqual({
      mcp_attempted: true,
      probe_call_ok: true,
      stream_call_ok: true,
      token_absent: true,
    });
    const leaked = judgeMcp({
      ...e,
      argv: [["node", `--token=${e.token}`]],
      raw: e.token,
    });
    expect(leaked.find((c) => c.name === "token_absent")).toMatchObject({
      ok: false,
      detail: "the token is in the argv, raw log",
    });
    expect(
      names(judgeMcp({ branch: "fallback", run: [terminal("ok")] })),
    ).toEqual({ plain_ok: true, no_mcp_call: true });
  });

  test("12: the deny check alone for the fallback; approval checks with the cap", () => {
    const deny = {
      tool: "shell",
      markerCreated: false,
      run: [call("d"), result("d", "error"), terminal("ok")],
      inits: [],
    };
    expect(names(judgePermissions({ deny }, "fallback"))).toEqual({
      deny_attempted: true,
      deny_enforced: true,
    });
    expect(
      names(
        judgePermissions(
          { deny: { ...deny, run: [call("d"), result("d"), terminal("ok")] } },
          "fallback",
        ),
      ),
    ).toMatchObject({ deny_enforced: false });
    expect(
      names(
        judgePermissions(
          { deny, approval: { surfaced: true, markerCreated: true } },
          "cap",
        ),
      ),
    ).toEqual({
      deny_attempted: true,
      deny_enforced: true,
      approval_surfaced: true,
      approval_denied: false,
    });
  });

  test("13: the cap reads only the output file; a missing file fails output_file", () => {
    expect(
      names(judgeReview({ source: "output_file", text: undefined })),
    ).toEqual({ output_file: false });
    const json = JSON.stringify({
      summary: "s",
      findings: [
        {
          severity: "major",
          summary: "subtracts",
          file: "add.js",
          line: 3,
          category: null,
          detail_md: null,
        },
      ],
    });
    expect(names(judgeReview({ source: "output_file", text: json }))).toEqual({
      output_file: true,
      schema_findings: true,
    });
    expect(
      names(
        judgeReview({
          source: "assistant_text",
          text: "[major] add.js:3 — subtracts",
        }),
      ),
    ).toEqual({ review_text_seen: true, heuristic_findings: true });
  });

  test("14: only one session may claim a home, and the first may reclaim it", () => {
    const conflict = err({
      class: "conflict" as const,
      message: "x",
      retryable: false,
    });
    const e = { first: ok(undefined), second: conflict, again: ok(undefined) };
    expect(names(judgeHomeClaim(e))).toEqual({
      first_claim_ok: true,
      second_claim_refused: true,
      reclaim_ok: true,
    });
    // A runner that hands the same home to a second session fails, non-negotiably.
    expect(
      names(judgeHomeClaim({ ...e, second: ok(undefined) })),
    ).toMatchObject({ second_claim_refused: false });
    // A refusal of another class is not a claim being held.
    expect(
      names(
        judgeHomeClaim({
          ...e,
          second: err({
            class: "spawn_failed" as const,
            message: "x",
            retryable: false,
          }),
        }),
      ),
    ).toMatchObject({ second_claim_refused: false });
  });

  test("15: a written decoy HOME fails private_state, with one session or two", () => {
    const snap = (entries: [string, string][]) => new Map(entries);
    const written = { before: snap([]), after: snap([["state", "1"]]) };
    const e = {
      decoy: { before: snap([]), after: snap([]) },
      homes: [written, written],
      runs: [[terminal("ok")], [terminal("ok")]],
    };
    expect(names(judgeConcurrentHome(e))).toEqual({
      both_ok: true,
      private_state: true,
    });
    expect(
      names(judgeConcurrentHome({ ...e, decoy: { ...written } })),
    ).toMatchObject({ private_state: false });
    // The fallback branch drives one session and is judged the same way.
    expect(
      names(
        judgeConcurrentHome({
          decoy: { before: snap([]), after: snap([]) },
          homes: [written],
          runs: [[terminal("ok")]],
        }),
      ),
    ).toEqual({ both_ok: true, private_state: true });
    // A session that wrote nothing into its own home kept its state somewhere else.
    expect(
      names(
        judgeConcurrentHome({
          decoy: { before: snap([]), after: snap([]) },
          homes: [{ before: snap([]), after: snap([]) }],
          runs: [[terminal("ok")]],
        }),
      ),
    ).toMatchObject({ private_state: false });
    // No run at all is not a pass.
    expect(
      names(
        judgeConcurrentHome({
          decoy: { before: snap([]), after: snap([]) },
          homes: [],
          runs: [],
        }),
      ),
    ).toMatchObject({ both_ok: false });
  });
  test("16: a root that was not written, or anything written outside them, fails", () => {
    const granted = [
      { root: "/w/extra-a", ok: true },
      { root: "/w/extra-b", ok: true },
    ];
    const attempt = [call("c1"), terminal("ok")];
    const e = { written: granted, outside: [], attempt };
    expect(names(judgeRoots(e, "cap"))).toEqual({
      attempted: true,
      roots_written: true,
      outside_refused: true,
    });
    expect(
      names(
        judgeRoots(
          {
            ...e,
            written: [
              { root: "/w/extra-a", ok: true },
              { root: "/w/extra-b", ok: false },
            ],
          },
          "cap",
        ),
      ),
    ).toMatchObject({ roots_written: false });
    expect(
      names(judgeRoots({ ...e, outside: ["FRM_ROOT.txt"] }, "cap")),
    ).toMatchObject({ outside_refused: false });
    // No roots granted at all is not a quiet pass.
    expect(names(judgeRoots({ ...e, written: [] }, "cap"))).toMatchObject({
      roots_written: false,
    });
    // A turn with no tool call and an ok terminal never tried: a precondition, so it retries.
    expect(
      names(judgeRoots({ ...e, attempt: [terminal("ok")] }, "cap")),
    ).toMatchObject({ attempted: false });
    // Unless a file did arrive outside: that is the attempt and its success both, so the failure
    // lands on the boundary check and not on a precondition that would only retry.
    expect(
      names(
        judgeRoots(
          { ...e, attempt: [terminal("ok")], outside: ["FRM_ROOT.txt"] },
          "cap",
        ),
      ),
    ).toMatchObject({ attempted: true, outside_refused: false });
  });

  test("16: the declared refusal is verified, not believed (§15 #16)", () => {
    const refused = { written: [], outside: [], attempt: [], refused: "no" };
    expect(names(judgeRoots(refused, "fallback"))).toEqual({
      roots_refused: true,
      outside_refused: true,
    });
    // A kit that declares a refusal its runner does not make fails, it does not report N/A.
    expect(
      names(judgeRoots({ ...refused, refused: undefined }, "fallback")),
    ).toMatchObject({ roots_refused: false });
  });
});
