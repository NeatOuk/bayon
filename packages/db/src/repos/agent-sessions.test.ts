import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import {
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "../testing.js";
import {
  agentSessionsAfter,
  listAgentSessions,
  type AgentSessionRow,
} from "./agent-sessions.js";

// An agent's sessions for the replay list: newest first by (created_at, id), a cursor
// that neither loses nor repeats a session when several share a millisecond, only that agent's,
// and an unknown agent is not_found.
const t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
afterAll(() => t.cleanup());
unwrap(await seedSpine(t.db, 1));
unwrap(
  await seedRows(t.db, {
    agents: [
      {
        id: "other",
        name: "other",
        kind: "builder",
        runner_id: "fixture",
        created_at: 0,
      },
    ],
    tickets: [ticketRow(7)],
    sessions: [
      ...[
        ["s-a", 100],
        ["s-b", 200],
        ["s-c", 200],
        ["s-d", 200],
        ["s-e", 300],
      ].map(([id, at]) => ({
        ...newSessionInput(),
        id: String(id),
        state: "exited" as const,
        created_at: Number(at),
      })),
      {
        ...newSessionInput(),
        id: "s-ticket",
        ticket_id: "ticket-7",
        state: "exited",
        exit_reason: "ok",
        turns: 4,
        cost_usd: 0.5,
        created_at: 400,
        started_at: 410,
        ended_at: 490,
      },
      // Queued: no started_at yet, and still listed, newest.
      {
        ...newSessionInput(),
        id: "s-queued",
        state: "pending",
        created_at: 500,
      },
      {
        ...newSessionInput(),
        id: "s-other",
        agent_id: "other",
        state: "exited",
        created_at: 450,
      },
    ],
  }),
);

const AGENT = "agent-fixture";

test("newest first by (created_at, id), with the ticket's key and what a replay list shows", async () => {
  const page = unwrap(
    await listAgentSessions(t.db, { agentId: AGENT, limit: 50 }),
  );
  expect(page.hasMore).toBe(false);
  expect(page.rows.map((r) => r.id)).toEqual([
    "session-fixture", // the spine's, created at the clock's now
    "s-queued",
    "s-ticket",
    "s-e",
    "s-d",
    "s-c",
    "s-b",
    "s-a",
  ]);
  expect(page.rows[2]).toEqual({
    id: "s-ticket",
    ticket_id: "ticket-7",
    ticket_key: "FRM-7",
    role: "builder",
    run_class: "fixture_only",
    runner_id: "fixture",
    state: "exited",
    created_at: 400,
    started_at: 410,
    ended_at: 490,
    turns: 4,
    cost_usd: 0.5,
    exit_reason: "ok",
  });
  expect(page.rows[1]).toMatchObject({
    started_at: null,
    ticket_key: null,
  });
});

test("pages of every size neither lose nor repeat a session sharing a millisecond", async () => {
  const everything = unwrap(
    await listAgentSessions(t.db, { agentId: AGENT, limit: 50 }),
  ).rows.map((r) => r.id);
  for (const limit of [1, 2, 3]) {
    const walked: AgentSessionRow[] = [];
    let after: ReturnType<typeof agentSessionsAfter> | undefined;
    for (;;) {
      const page = unwrap(
        await listAgentSessions(t.db, {
          agentId: AGENT,
          limit,
          ...(after === undefined ? {} : { after }),
        }),
      );
      walked.push(...page.rows);
      const last = page.rows.at(-1);
      if (!page.hasMore || last === undefined) break;
      after = agentSessionsAfter(last);
    }
    expect(
      walked.map((r) => r.id),
      `limit ${limit}`,
    ).toEqual(everything);
  }
});

test("only that agent's; an unknown agent is not_found; a bad query is validation", async () => {
  const other = unwrap(
    await listAgentSessions(t.db, { agentId: "other", limit: 5 }),
  );
  expect(other.rows.map((r) => r.id)).toEqual(["s-other"]);
  expect(
    await listAgentSessions(t.db, { agentId: "ghost", limit: 5 }),
  ).toMatchObject({
    ok: false,
    error: { class: "not_found" },
  });
  expect(
    await listAgentSessions(t.db, { agentId: AGENT, limit: 0 }),
  ).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
});
