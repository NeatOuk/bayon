import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  chainProblems,
  completionWakeProblems,
  factFilesProblems,
  handoffRunsProblems,
  holdingProblems,
  nothingToDoProblems,
  operatorWriteProblems,
  packetProblems,
  porcelainFiles,
  pulseInitProblems,
  pulseProblems,
  pulseToolsetProblems,
  runNowProblems,
  type PulseFacts,
} from "./m2-assertions.js";

test("pulseInitProblems: session_init shows only the toolset's MCP tools, none of the runner's own", () => {
  const init = (mcp_tools: string[], builtin_tools: string[]) => [
    { kind: "session_init", payload: { mcp_tools, builtin_tools } },
    { kind: "terminal", payload: {} },
  ];
  const allowed = ["pulse_report", "ticket_staff"];
  expect(pulseInitProblems("p1", init(["pulse_report"], []), allowed)).toEqual(
    [],
  );
  // The real run: the runner's own tools were exposed next to the MCP tools.
  expect(
    pulseInitProblems(
      "p1",
      init(["pulse_report"], ["Bash", "Read", "ToolSearch"]),
      allowed,
    ),
  ).toEqual([
    "pulse session p1 exposes the runner's own tools: Bash, Read, ToolSearch",
  ]);
  expect(
    pulseInitProblems("p1", init(["handoff_write"], []), allowed),
  ).toHaveLength(1);
  expect(pulseInitProblems("p1", init([], []), allowed)).toEqual([
    "pulse session p1 exposes no MCP tool",
  ]);
  expect(
    pulseInitProblems(
      "p1",
      [{ kind: "session_init", payload: { tools: ["Bash"] } }],
      allowed,
    ),
  ).toHaveLength(1);
  expect(
    pulseInitProblems("p1", [{ kind: "terminal", payload: {} }], allowed),
  ).toEqual(["pulse session p1 has no session_init"]);
  expect(pulseInitProblems("p1", [], allowed)).toEqual([]);
});

const T = { id: "T", status: "staffed", owner_session_id: null };
const builder = (
  id: string,
  state = "running",
  handoff_in_id: string | null = null,
) => ({
  id,
  state,
  role: "builder",
  ticket_id: "T",
  handoff_in_id,
});

describe("holdingProblems: exactly one of a live owner, a pending hand-off, a closed status", () => {
  test("each one alone passes", () => {
    expect(holdingProblems(T, [builder("S1")], [])).toEqual([]);
    expect(holdingProblems(T, [builder("S1", "handed_off")], ["H1"])).toEqual(
      [],
    );
    expect(
      holdingProblems(
        { ...T, status: "blocked" },
        [builder("S4", "idle", "H3")],
        [],
      ),
    ).toEqual([]);
  });

  test("a successor holds only once it owns the ticket", () => {
    const s2 = builder("S2", "running", "H1");
    expect(holdingProblems(T, [s2], ["H1"])).toEqual([]);
    expect(holdingProblems({ ...T, owner_session_id: "S2" }, [s2], [])).toEqual(
      [],
    );
  });

  test("none, or two at once, is a problem", () => {
    expect(holdingProblems(T, [], [])).toEqual([
      "ticket T has none of: a live owner, a pending hand-off, a terminal or blocked status",
    ]);
    expect(holdingProblems(T, [builder("S1")], ["H1"])[0]).toMatch(
      /live owner S1 and pending hand-off H1/,
    );
    expect(holdingProblems(T, [builder("S1"), builder("S9")], [])).toContain(
      "2 live owners",
    );
  });
});

describe("chainProblems", () => {
  const sessions = [
    { id: "S1", predecessor_session_id: null, handoff_in_id: null },
    { id: "S2", predecessor_session_id: "S1", handoff_in_id: "H1" },
    { id: "S3", predecessor_session_id: "S2", handoff_in_id: "H2" },
  ];
  const handoffs = [
    { id: "H1", from_session_id: "S1", to_session_id: "S2", accepted_at: 1 },
    { id: "H2", from_session_id: "S2", to_session_id: "S3", accepted_at: 2 },
  ];

  test("each hand-off from one session, accepted by the next, which names both", () => {
    expect(chainProblems(sessions, handoffs)).toEqual([]);
  });

  test("a broken link, an unaccepted hand-off or a wrong count is named", () => {
    expect(
      chainProblems(
        sessions,
        [
          handoffs[0] ?? handoffs[1],
          {
            id: "H2",
            from_session_id: "S2",
            to_session_id: null,
            accepted_at: null,
          },
        ].filter((h) => h !== undefined),
      ),
    ).toEqual(["hand-off 2 was not accepted by S3"]);
    expect(chainProblems(sessions, handoffs.slice(0, 1))[0]).toMatch(
      /1 hand-offs for 3 sessions/,
    );
    expect(chainProblems([], [])).toEqual(["no session worked the ticket"]);
  });

  test("with trailingPending, the last session's own hand-off may still wait", () => {
    const pending = {
      id: "H3",
      from_session_id: "S3",
      to_session_id: null,
      accepted_at: null,
    };
    expect(
      chainProblems(sessions, [...handoffs, pending], {
        trailingPending: true,
      }),
    ).toEqual([]);
    expect(chainProblems(sessions, [...handoffs, pending])[0]).toMatch(
      /3 hand-offs for 3 sessions, expected 2/,
    );
    expect(
      chainProblems(sessions, handoffs, { trailingPending: true })[0],
    ).toMatch(/2 hand-offs for 3 sessions, expected 3/);
    expect(
      chainProblems(
        sessions,
        [...handoffs, { ...pending, from_session_id: "S2" }],
        {
          trailingPending: true,
        },
      ),
    ).toEqual(["the last hand-off is from S2, not S3"]);
    expect(
      chainProblems(
        sessions,
        [...handoffs, { ...pending, to_session_id: "S9", accepted_at: 3 }],
        {
          trailingPending: true,
        },
      ),
    ).toEqual(["the last hand-off H3 should still be pending"]);
  });
});

describe("packetProblems", () => {
  const text = "# Hand-off T-1 · handoff-1\n";
  const row = {
    id: "H1",
    reason: "turn_ceiling",
    quality: "full",
    packet_path: ".foreman/handoff-1.md",
    packet_hash: createHash("sha256").update(text).digest("hex"),
  };
  const want = {
    path: ".foreman/handoff-1.md",
    quality: ["full"],
    reason: "turn_ceiling",
  };

  test("the file's sha256 is the row's", () => {
    expect(packetProblems(row, text, want)).toEqual([]);
  });

  test("an edited or missing file, another quality or reason, is named", () => {
    expect(packetProblems(row, `${text}x`, want)[0]).toMatch(/sha256/);
    expect(packetProblems(row, undefined, want)).toEqual([
      "no packet file .foreman/handoff-1.md in the worktree",
    ]);
    expect(
      packetProblems(
        { ...row, quality: "degraded", reason: "operator" },
        text,
        want,
      ),
    ).toHaveLength(2);
  });
});

describe("the degraded packet's files and git status", () => {
  const facts = (files: readonly { path: string; code: string }[]) =>
    JSON.stringify({
      v: 1,
      ticket: { id: "T", key: "FRM-1", status: "staffed" },
      session: { id: "S3", role: "builder", run_class: "spike" },
      repos: [
        {
          repo_id: "r",
          branch: "frm/S1",
          base_sha: "b",
          head_sha: "b",
          commits: 0,
          files,
        },
      ],
      commands: [],
      gates: [],
      findings_open: 0,
      questions: [],
      spend: { session_usd: 0, ticket_usd: 0 },
      counters: {
        turns: 1,
        max_turns: 40,
        tool_calls: 0,
        context_peak_tokens: null,
        context_cap: 15000,
      },
      events: { first_id: 1, last_id: 2 },
      gathered_at: 1,
    });
  const status = " M README.md\0?? M2-SMOKE.md\0";

  test("porcelain -z keeps a leading space's meaning and skips a rename's origin", () => {
    expect(porcelainFiles(status)).toEqual(["?? M2-SMOKE.md", "M README.md"]);
    expect(porcelainFiles("R  new.md\0old.md\0")).toEqual(["R new.md"]);
  });

  test("uncommitted files equal git status; committed ones are not in it", () => {
    const files = [
      { path: "README.md", code: "M" },
      { path: "M2-SMOKE.md", code: "??" },
      { path: "done.md", code: "committed" },
    ];
    expect(factFilesProblems(facts(files), status)).toEqual([]);
    expect(factFilesProblems(facts(files.slice(1)), status)[0]).toMatch(
      /git status shows/,
    );
    expect(factFilesProblems("{", status)).toEqual([
      "the hand-off's facts_json is not HandoffFacts",
    ]);
  });
});

test("handoffRunsProblems: run 1, then the handoff run, and no run 3", () => {
  expect(
    handoffRunsProblems("S1", [
      { seq: 1, trigger: "staff" },
      { seq: 2, trigger: "handoff" },
    ]),
  ).toEqual([]);
  expect(
    handoffRunsProblems("S1", [{ seq: 1, trigger: "staff" }]),
  ).toHaveLength(1);
  expect(
    handoffRunsProblems("S1", [
      { seq: 1, trigger: "staff" },
      { seq: 2, trigger: "handoff" },
      { seq: 3, trigger: "handoff" },
    ]),
  ).toHaveLength(1);
});

describe("pulseProblems", () => {
  const done = (id: string, trigger: string): PulseFacts => ({
    id,
    trigger,
    state: "done",
    skip_reason: null,
    session_id: `s-${id}`,
    context_tokens: 2_000,
    cost_usd: 0.001,
    spend_pulse_id: id,
  });
  const skipped: PulseFacts = {
    id: "P0",
    trigger: "cron",
    state: "skipped",
    skip_reason: "nothing_to_do",
    session_id: null,
    context_tokens: null,
    cost_usd: 0,
  };
  const o = { capTokens: 6_000, unreportedOk: false };

  test("skipped at $0, then a catchup, then done pulses within the cap", () => {
    expect(
      pulseProblems([skipped, done("P1", "catchup"), done("P2", "cron")], o),
    ).toEqual([]);
  });

  test("each broken rule is named", () => {
    expect(pulseProblems([done("P1", "cron")], o)).toEqual([
      "the first pulse that ran is P1 cron done, not the boot catchup",
    ]);
    expect(
      pulseProblems(
        [{ ...done("P1", "catchup"), context_tokens: 6_001 }],
        o,
      )[0],
    ).toMatch(/6001 tokens/);
    expect(
      pulseProblems([{ ...done("P1", "catchup"), spend_pulse_id: null }], o)[0],
    ).toMatch(/spend carries pulse none/);
    expect(
      pulseProblems(
        [done("P1", "catchup"), { ...done("P2", "cron"), state: "running" }],
        o,
      )[0],
    ).toMatch(/not done or skipped/);
    expect(
      pulseProblems([{ ...skipped, cost_usd: 0.1 }, done("P1", "catchup")], o),
    ).toHaveLength(1);
  });

  test("with inFlightOk, one pulse still in flight is ignored; two at once are not", () => {
    const running = {
      ...done("P2", "cron"),
      state: "running",
      context_tokens: null,
      spend_pulse_id: null,
    };
    const live = { ...o, inFlightOk: true };
    expect(pulseProblems([done("P1", "catchup"), running], live)).toEqual([]);
    expect(
      pulseProblems(
        [
          done("P1", "catchup"),
          running,
          { ...running, id: "P3", state: "leased" },
        ],
        live,
      ),
    ).toEqual(["2 pulses in flight at once"]);
    // Without it, the fixture's strict check still fails a live pulse.
    expect(pulseProblems([done("P1", "catchup"), running], o)[0]).toMatch(
      /not done or skipped/,
    );
    // Settled pulses are still judged in full.
    expect(
      pulseProblems(
        [{ ...done("P1", "catchup"), spend_pulse_id: null }, running],
        live,
      )[0],
    ).toMatch(/spend carries pulse none/);
  });

  test("failed(unreported) passes only for a real model", () => {
    const unreported = {
      ...done("P2", "cron"),
      state: "failed",
      skip_reason: "unreported",
    };
    expect(pulseProblems([done("P1", "catchup"), unreported], o)).toHaveLength(
      1,
    );
    expect(
      pulseProblems([done("P1", "catchup"), unreported], {
        ...o,
        unreportedOk: true,
      }),
    ).toEqual([]);
  });

  test("P5: skipped(nothing_to_do) at $0", () => {
    expect(nothingToDoProblems(skipped)).toEqual([]);
    expect(nothingToDoProblems(done("P5", "cron"))).toHaveLength(1);
    expect(nothingToDoProblems(undefined)).toHaveLength(1);
  });
});

test("operatorWriteProblems: nothing by the operator after `since`", () => {
  const audit = [
    { ts: 5, actor: "operator", action: "rest.pulse_policy" },
    { ts: 20, actor: "session:S1", action: "mcp.handoff_accept" },
  ];
  const events = [
    { ts: 6, actor_kind: "operator", kind: "transition" },
    { ts: 21, actor_kind: "session", kind: "handoff" },
  ];
  expect(operatorWriteProblems(audit, events, 10)).toEqual([]);
  expect(operatorWriteProblems(audit, events, 1)).toEqual([
    "operator writes after the ticket was prioritized: audit rest.pulse_policy, ticket event transition",
  ]);
});

test("runNowProblems: both calls name the one new manual pulse", () => {
  const results = [
    { pulse_id: "P6", outcome: "running" },
    { pulse_id: "P6", outcome: "coalesced" },
  ];
  expect(runNowProblems(results, [{ id: "P6", trigger: "manual" }])).toEqual(
    [],
  );
  expect(
    runNowProblems(
      [results[0], { pulse_id: "P7", outcome: "running" }],
      [
        { id: "P6", trigger: "manual" },
        { id: "P7", trigger: "manual" },
      ],
    ),
  ).toHaveLength(2);
  expect(runNowProblems([{ nope: true }], [])[0]).toMatch(
    /not \{pulse_id, outcome\}/,
  );
});

test("completionWakeProblems: the staffing pulse woke on the pending hand-off, soon after it", () => {
  const pulse = {
    id: "P2",
    trigger: "completion",
    state: "done",
    skip_reason: null,
    session_id: "s-P2",
    context_tokens: 2_000,
    cost_usd: 0.001,
    scheduled_at: 11_500,
  };
  expect(completionWakeProblems(pulse, 10_000, 10_000)).toEqual([]);
  expect(
    completionWakeProblems({ ...pulse, trigger: "cron" }, 10_000, 10_000)[0],
  ).toMatch(/woke on cron, not on the pending hand-off/);
  expect(
    completionWakeProblems({ ...pulse, scheduled_at: 30_000 }, 10_000, 10_000),
  ).toEqual([
    "pulse P2 woke 20000 ms after the hand-off went pending, not within 10000 ms",
  ]);
  expect(completionWakeProblems(undefined, 0, 1)).toHaveLength(1);
});

test("pulseToolsetProblems: orchestrators on the MCP toolset alone, with no worktree", () => {
  const s = { id: "p1", role: "orchestrator", toolset_hash: "h", worktrees: 0 };
  expect(pulseToolsetProblems([s], "h")).toEqual([]);
  expect(
    pulseToolsetProblems(
      [{ ...s, role: "builder", toolset_hash: "x", worktrees: 1 }],
      "h",
    ),
  ).toHaveLength(3);
  expect(pulseToolsetProblems([], "h")).toEqual(["no pulse session to check"]);
});
