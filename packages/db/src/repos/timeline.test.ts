import { FakeClock, TIMELINE_SOURCES, type Result } from "@bayon/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
  type SeedRows,
} from "../testing.js";
import {
  listTimeline,
  timelineAfter,
  type TimelineQuery,
  type TimelineRow,
} from "./timeline.js";

// A project's timeline: every source scoped to its project, keyset pages that neither
// lose nor repeat a row across a millisecond shared by many sources, and each filter.
const T = 1_700_000_000_000;
const clock = new FakeClock(T);
const t = unwrap(await tempDb(clock));
afterAll(() => t.cleanup());
unwrap(await seedSpine(t.db, 1));

/**
 * One row of every source for project `p`, on ticket `num`, around `base`: a builder session with
 * its own workspace, a pulse session that has none (its agent's project scopes it), and a request
 * with no ticket (its session scopes it).
 */
function project(p: string, num: number, base: number): SeedRows {
  const ticket = `ticket-${num}`;
  return {
    workspaces: [{ id: p, name: p, kind: "single" }],
    agents: [
      {
        id: `${p}-orch`,
        name: `${p}-orch`,
        kind: "orchestrator",
        runner_id: "fixture",
        workspace_id: p,
        created_at: 0,
      },
      {
        id: `${p}-builder`,
        name: `${p}-builder`,
        kind: "builder",
        runner_id: "fixture",
        workspace_id: p,
        created_at: 0,
      },
    ],
    tickets: [ticketRow(num, { workspace_id: p })],
    sessions: [
      {
        ...newSessionInput(),
        id: `${p}-build`,
        agent_id: `${p}-builder`,
        ticket_id: ticket,
        workspace_id: p,
        state: "exited",
        exit_reason: "ok",
        turns: 3,
        cost_usd: 0.125,
        created_at: base,
        started_at: base + 1,
        ended_at: base + 9,
      },
      {
        ...newSessionInput(),
        id: `${p}-pulse`,
        agent_id: `${p}-orch`,
        role: "orchestrator",
        state: "running",
        created_at: base,
        started_at: base + 2,
      },
    ],
    ticket_events: [
      {
        ticket_id: ticket,
        ts: base + 3,
        actor_kind: "session",
        actor_id: `${p}-build`,
        kind: "transition",
        from_status: "staffed",
        to_status: "building",
        reason: "go",
      },
    ],
    audit_log: [
      {
        ts: base + 4,
        actor: `session:${p}-build`,
        action: "mcp.ticket_update",
        target_kind: "ticket",
        target_id: ticket,
        payload_json: JSON.stringify({ bytes: 12 }),
        workspace_id: p,
      },
    ],
    pulses: [
      {
        id: `${p}-pulse-1`,
        agent_id: `${p}-orch`,
        trigger: "cron",
        scheduled_at: base + 5,
        state: "skipped",
        skip_reason: "nothing_to_do",
      },
      {
        id: `${p}-pulse-2`,
        agent_id: `${p}-orch`,
        trigger: "completion",
        scheduled_at: base + 5,
        state: "done",
        session_id: `${p}-pulse`,
      },
    ],
    gates: [
      {
        id: `${p}-gate`,
        ticket_id: ticket,
        kind: "code_review",
        state: "failed",
        subject_kind: "diff",
        subject_ref: "abc",
        started_at: base + 6,
        decided_at: base + 7,
      },
    ],
    findings: [
      {
        id: `${p}-finding`,
        gate_id: `${p}-gate`,
        severity: "major",
        summary: "missing test",
        file: "a.ts",
        line: 4,
        created_at: base + 7,
      },
    ],
    handoffs: [
      {
        id: `${p}-handoff`,
        ticket_id: ticket,
        from_session_id: `${p}-build`,
        reason: "phase_change",
        phase_from: "plan",
        phase_to: "build",
        facts_json: "{}",
        packet_path: ".foreman/handoff-1.md",
        packet_hash: "0".repeat(64),
        created_at: base + 8,
      },
    ],
    human_requests: [
      {
        id: `${p}-ask`,
        ticket_id: ticket,
        session_id: `${p}-build`,
        kind: "decision",
        question: `which way for ${p}?`,
        asked_at: base + 8,
        status: "answered",
        answer_json: JSON.stringify("left"),
        answered_by: "operator",
        answered_at: base + 10,
      },
      {
        id: `${p}-pulse-ask`,
        session_id: `${p}-pulse`,
        kind: "decision",
        question: `anything for ${p}?`,
        asked_at: base + 9,
      },
    ],
  };
}

/** Rows of two seedings, table by table. */
function merged(a: SeedRows, b: SeedRows): SeedRows {
  const tables = new Set([...Object.keys(a), ...Object.keys(b)]);
  return Object.fromEntries(
    [...tables].map((table) => [
      table,
      [
        ...((a as Record<string, readonly unknown[]>)[table] ?? []),
        ...((b as Record<string, readonly unknown[]>)[table] ?? []),
      ],
    ]),
  );
}

unwrap(
  await seedRows(
    t.db,
    merged(project("A", 1, T - 1_000), project("B", 2, T - 1_000)),
  ),
);
// Rows no project owns: an operator setting's audit row, a system request with neither ticket nor
// session. Neither appears in any project's timeline.
unwrap(
  await seedRows(t.db, {
    audit_log: [{ ts: T - 900, actor: "operator", action: "settings.put" }],
    human_requests: [
      {
        id: "system-ask",
        kind: "circuit_breaker",
        question: "stop the fleet?",
        asked_at: T - 900,
      },
    ],
  }),
);

const page = async (q: TimelineQuery) => unwrap(await listTimeline(t.db, q));
const everything = async (
  workspaceId: string,
  extra: Partial<TimelineQuery> = {},
) => (await page({ workspaceId, limit: 1000, ...extra })).rows;
const ids = (rows: readonly TimelineRow[]) =>
  rows.map((r) => `${r.source}/${r.key}`);

describe("isolation", () => {
  test("every source of A appears in A's timeline and never in B's, and B's never in A's", async () => {
    const a = await everything("A");
    const b = await everything("B");
    for (const rows of [a, b]) {
      expect(new Set(rows.map((r) => r.source))).toEqual(
        new Set(TIMELINE_SOURCES),
      );
    }
    const inA = new Set(ids(a));
    expect(ids(b).filter((id) => inA.has(id))).toEqual([]);
    expect(a.map((r) => r.summary).join("\n")).not.toMatch(/\bB-|FRM-2\b/);
    expect(b.map((r) => r.summary).join("\n")).not.toMatch(/\bA-|FRM-1\b/);
    expect(ids([...a, ...b]).join(" ")).not.toContain("system-ask");
    expect([...a, ...b].map((r) => r.kind)).not.toContain("audit.settings.put");
  });

  test("A's rows, each with its kind, actor, links and summary", async () => {
    const a = await everything("A");
    const byId = new Map(a.map((r) => [`${r.source}/${r.key}`, r]));
    expect(a.map((r) => [r.source, r.key, r.kind])).toEqual([
      ["human_request", "A-ask:answered", "human_request.answered"],
      ["session", "A-build:ended", "session.ended"],
      ["human_request", "A-pulse-ask:asked", "human_request.asked"],
      ["human_request", "A-ask:asked", "human_request.asked"],
      ["handoff", "A-handoff", "handoff.phase_change"],
      ["finding", "A-finding", "finding.major"],
      ["gate", "A-gate", "gate.code_review"],
      ["pulse", "A-pulse-2", "pulse.done"],
      ["pulse", "A-pulse-1", "pulse.skipped"],
      [
        "audit",
        a.find((r) => r.source === "audit")?.key,
        "audit.mcp.ticket_update",
      ],
      [
        "ticket",
        a.find((r) => r.source === "ticket")?.key,
        "ticket.transition",
      ],
      ["session", "A-pulse:started", "session.started"],
      ["session", "A-build:started", "session.started"],
    ]);
    const audit = a.find((r) => r.source === "audit");
    expect(audit).toMatchObject({
      key: expect.stringMatching(/^\d{20}$/),
      actor: "session:A-build",
      agent_id: "A-builder",
      session_id: "A-build",
      ticket_id: "ticket-1",
      ticket_key: "FRM-1",
      summary: "mcp.ticket_update ticket FRM-1",
      payload_json: JSON.stringify({ bytes: 12 }),
    });
    expect(a.find((r) => r.source === "ticket")).toMatchObject({
      actor: "session:A-build",
      agent_id: "A-builder",
      summary: "FRM-1 transition staffed -> building: go",
    });
    expect(byId.get("session/A-build:ended")).toMatchObject({
      actor: "supervisor",
      agent_id: "A-builder",
      ticket_key: "FRM-1",
      summary: "A-builder ended builder: exited (ok), 3 turns, $0.13 on FRM-1",
      payload_json: null,
    });
    expect(byId.get("session/A-pulse:started")).toMatchObject({
      agent_id: "A-orch",
      ticket_id: null,
      summary: "A-orch started orchestrator (fixture_only)",
    });
    expect(byId.get("pulse/A-pulse-1")?.summary).toBe(
      "A-orch pulse (cron): skipped - nothing_to_do",
    );
    expect(byId.get("gate/A-gate")?.summary).toBe(
      "code_review gate on FRM-1 (attempt 1, round 1): failed",
    );
    expect(byId.get("finding/A-finding")?.summary).toBe(
      "major finding on FRM-1 a.ts:4: missing test [open]",
    );
    expect(byId.get("handoff/A-handoff")).toMatchObject({
      actor: "session:A-build",
      agent_id: "A-builder",
      summary: "hand-off on FRM-1 (phase_change, plan -> build, pending)",
    });
    expect(byId.get("human_request/A-ask:answered")).toMatchObject({
      actor: "operator",
      summary: "decision answered on FRM-1: left",
    });
    expect(byId.get("human_request/A-pulse-ask:asked")).toMatchObject({
      actor: "session:A-pulse",
      agent_id: "A-orch",
      ticket_id: null,
      summary: "decision asked: anything for A?",
    });
  });

  test("an unknown project is not_found", async () => {
    expect(
      await listTimeline(t.db, { workspaceId: "nope", limit: 5 }),
    ).toMatchObject({
      ok: false,
      error: { class: "not_found" },
    });
  });
});

/** The order a page must follow: (ts, source, key), all descending. */
const newestFirst = (x: TimelineRow, y: TimelineRow): number =>
  y.ts - x.ts ||
  (x.source === y.source ? 0 : x.source < y.source ? 1 : -1) ||
  (x.key === y.key ? 0 : x.key < y.key ? 1 : -1);

describe("paging", () => {
  // Project C crowds one millisecond with four sources, then one row on either side of it.
  const tie = T - 500;
  const c = project("C", 3, tie - 5_000);
  beforeAll(async () => {
    unwrap(
      await seedRows(t.db, {
        ...c,
        audit_log: Array.from({ length: 9 }, (_, i) => ({
          ts: tie,
          actor: "operator",
          action: `project.set${i}`,
          target_kind: "project",
          target_id: "C",
          workspace_id: "C",
        })),
        ticket_events: Array.from({ length: 5 }, () => ({
          ticket_id: "ticket-3",
          ts: tie,
          actor_kind: "operator",
          actor_id: "operator",
          kind: "comment",
        })),
        sessions: [
          ...(c.sessions ?? []),
          ...Array.from({ length: 4 }, (_, i) => ({
            ...newSessionInput(),
            id: `C-tie-${i}`,
            agent_id: "C-builder",
            workspace_id: "C",
            state: "running" as const,
            created_at: tie,
            started_at: tie,
          })),
        ],
        pulses: [
          ...(c.pulses ?? []),
          ...Array.from({ length: 3 }, (_, i) => ({
            id: `C-tie-pulse-${i}`,
            agent_id: "C-orch",
            trigger: "cron" as const,
            scheduled_at: tie,
            state: "done" as const,
          })),
        ],
      }),
    );
    unwrap(
      await seedRows(t.db, {
        audit_log: [
          {
            ts: tie + 1,
            actor: "operator",
            action: "later",
            workspace_id: "C",
          },
          {
            ts: tie - 1,
            actor: "operator",
            action: "earlier",
            workspace_id: "C",
          },
        ],
      }),
    );
  });

  async function walk(limit: number, extra: Partial<TimelineQuery> = {}) {
    const rows: TimelineRow[] = [];
    let after: TimelineQuery["after"];
    for (let pages = 0; pages < 100; pages += 1) {
      const got = await page({
        workspaceId: "C",
        limit,
        ...extra,
        ...(after === undefined ? {} : { after }),
      });
      rows.push(...got.rows);
      const last = got.rows.at(-1);
      if (!got.hasMore || last === undefined) return rows;
      after = timelineAfter(last);
    }
    throw new Error("more than 100 pages");
  }

  test("pages of every size neither lose nor repeat a row across a crowded millisecond", async () => {
    const all = await everything("C");
    // C's own 13 rows, less the audit and ticket rows the crowd replaced, then the crowd and the two
    // rows either side of it.
    expect(all.length).toBe(13 - 2 + 9 + 5 + 4 + 3 + 2);
    expect(all).toEqual(all.toSorted(newestFirst));
    for (const limit of [1, 2, 3, 4, 7, 50]) {
      const walked = await walk(limit);
      expect(ids(walked), `limit ${limit}`).toEqual(ids(all));
      expect(new Set(ids(walked)).size).toBe(walked.length);
    }
  });

  test("a millisecond shared by several sources orders them by source, then key", async () => {
    const atTie = (await everything("C")).filter((r) => r.ts === tie);
    expect([...new Set(atTie.map((r) => r.source))]).toEqual([
      "ticket",
      "session",
      "pulse",
      "audit",
    ]);
    for (const source of ["ticket", "session", "pulse", "audit"]) {
      const keys = atTie.filter((r) => r.source === source).map((r) => r.key);
      expect(keys, source).toEqual(keys.toSorted().toReversed());
    }
    const first = await page({
      workspaceId: "C",
      limit: 6,
      from: tie,
      to: tie + 1,
    });
    expect(first.rows.map((r) => r.source)).toEqual([
      "ticket",
      "ticket",
      "ticket",
      "ticket",
      "ticket",
      "session",
    ]);
  });

  test("the last page says there is no more", async () => {
    const all = await everything("C");
    const last = await page({
      workspaceId: "C",
      limit: 1000,
      after: timelineAfter(all.at(-2) as TimelineRow),
    });
    expect(last.hasMore).toBe(false);
    expect(ids(last.rows)).toEqual(ids(all.slice(-1)));
  });
});

describe("filters", () => {
  beforeAll(async () => {
    unwrap(
      await seedRows(t.db, {
        human_requests: [
          {
            id: "A-pct",
            ticket_id: "ticket-1",
            kind: "decision",
            question: "is it 50% done?",
            asked_at: T - 100,
          },
          {
            id: "A-no-pct",
            ticket_id: "ticket-1",
            kind: "decision",
            question: "is it 50 done?",
            asked_at: T - 100,
          },
          {
            id: "A-under",
            ticket_id: "ticket-1",
            kind: "decision",
            question: "rename snake_case",
            asked_at: T - 100,
          },
          {
            id: "A-no-under",
            ticket_id: "ticket-1",
            kind: "decision",
            question: "rename snakeXcase",
            asked_at: T - 100,
          },
          {
            id: "A-bang",
            ticket_id: "ticket-1",
            kind: "decision",
            question: "wow! done",
            asked_at: T - 100,
          },
        ],
      }),
    );
  });
  const keysOf = async (extra: Partial<TimelineQuery>) =>
    (await everything("A", extra)).map((r) => `${r.source}/${r.key}`);

  test("kind: exact, or a prefix ending in *", async () => {
    expect(await keysOf({ kinds: ["pulse.skipped"] })).toEqual([
      "pulse/A-pulse-1",
    ]);
    expect(await keysOf({ kinds: ["session.*", "gate.code_review"] })).toEqual([
      "session/A-build:ended",
      "gate/A-gate",
      "session/A-pulse:started",
      "session/A-build:started",
    ]);
    expect(await keysOf({ kinds: ["session"] })).toEqual([]);
  });

  test("agent: the rows that name it", async () => {
    const rows = await everything("A", { agentId: "A-orch" });
    expect(rows.map((r) => r.agent_id)).toEqual(rows.map(() => "A-orch"));
    expect(ids(rows)).toEqual([
      "human_request/A-pulse-ask:asked",
      "pulse/A-pulse-2",
      "pulse/A-pulse-1",
      "session/A-pulse:started",
    ]);
    expect(
      await listTimeline(t.db, {
        workspaceId: "A",
        limit: 5,
        agentId: "ghost",
      }),
    ).toMatchObject({
      ok: false,
      error: { class: "validation", message: "no agent ghost" },
    });
  });

  test("ticket: its key, #n, n or id all name it; an unknown one is refused", async () => {
    const byId = await keysOf({ ticket: "ticket-1" });
    expect(byId.length).toBeGreaterThan(5);
    for (const ref of ["FRM-1", "frm-1", "#1", "1"]) {
      expect(await keysOf({ ticket: ref }), ref).toEqual(byId);
    }
    expect(byId).not.toContain("session/A-pulse:started");
    expect(await keysOf({ ticket: "FRM-2" })).toEqual([]);
    expect(
      await listTimeline(t.db, {
        workspaceId: "A",
        limit: 5,
        ticket: "FRM-99",
      }),
    ).toMatchObject({
      ok: false,
      error: { class: "validation", message: "no ticket FRM-99" },
    });
  });

  test("from <= ts < to", async () => {
    const base = T - 1_000;
    const rows = await everything("A", { from: base + 5, to: base + 8 });
    expect(rows.map((r) => r.ts).toSorted()).toEqual([
      base + 5,
      base + 5,
      base + 6,
      base + 7,
    ]);
    expect(
      await listTimeline(t.db, { workspaceId: "A", limit: 5, from: 9, to: 9 }),
    ).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
  });

  test("q matches summary or actor, case-insensitive, with % and _ taken literally", async () => {
    expect(await keysOf({ q: "50%" })).toEqual(["human_request/A-pct:asked"]);
    expect(await keysOf({ q: "e_ca" })).toEqual([
      "human_request/A-under:asked",
    ]);
    expect(await keysOf({ q: "wow!" })).toEqual(["human_request/A-bang:asked"]);
    expect(await keysOf({ q: "WHICH WAY" })).toEqual([
      "human_request/A-ask:asked",
    ]);
    const byActor = await everything("A", { q: "session:A-pulse" });
    expect(byActor.map((r) => r.actor)).toEqual(
      byActor.map(() => "session:A-pulse"),
    );
    expect(byActor.length).toBe(1);
  });

  test("filters combine, and a malformed query is refused", async () => {
    expect(
      await keysOf({ kinds: ["human_request.*"], q: "snake", ticket: "FRM-1" }),
    ).toEqual(
      ["human_request/A-under:asked", "human_request/A-no-under:asked"]
        .toSorted()
        .toReversed(),
    );
    for (const bad of [
      { limit: 0 },
      { kinds: ["DROP TABLE"] },
      { after: { ts: 1, source: "events", key: "x" } },
    ] as const) {
      const got: Result<unknown> = await listTimeline(t.db, {
        workspaceId: "A",
        limit: 5,
        ...(bad as Partial<TimelineQuery>),
      });
      expect(got, JSON.stringify(bad)).toMatchObject({
        ok: false,
        error: { class: "validation" },
      });
    }
  });
});

describe("caps", () => {
  test("a summary is one line of at most 300 characters; a payload over 8 KB, or not JSON, is left out", async () => {
    unwrap(
      await seedRows(t.db, {
        workspaces: [{ id: "D", name: "D", kind: "single" }],
        audit_log: [
          {
            ts: 1,
            actor: "operator",
            action: `long\naction\r${"x".repeat(400)}`,
            workspace_id: "D",
            payload_json: JSON.stringify({ text: "y".repeat(9_000) }),
          },
          {
            ts: 2,
            actor: "operator",
            action: "small",
            workspace_id: "D",
            payload_json: JSON.stringify({ text: "y".repeat(8_000) }),
          },
          {
            ts: 3,
            actor: "operator",
            action: "malformed",
            workspace_id: "D",
            payload_json: "{not json",
          },
        ],
      }),
    );
    const [malformed, small, long] = await everything("D");
    expect(malformed).toMatchObject({
      summary: "malformed",
      payload_json: null,
    });
    expect(long?.summary).toHaveLength(300);
    expect(long?.summary).toMatch(/^long action x+$/);
    expect(long?.payload_json).toBeNull();
    expect(small?.payload_json).toHaveLength(8_000 + '{"text":""}'.length);
  });
});
