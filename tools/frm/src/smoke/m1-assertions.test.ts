import type { EventItem } from "@bayon/proto";
import { expect, test } from "vitest";
import {
  askProblems,
  auditProblems,
  followupProblems,
  mcpCallProblems,
  ticketEventProblems,
} from "./m1-assertions.js";

const call = (
  id: number,
  tool: string,
  result: { readonly outcome: string; readonly reason?: string },
): EventItem => ({
  id,
  kind: "mcp_call",
  ts: 1,
  runner_type: "fixture.mcp",
  tool_name: tool,
  payload: { server: "foreman", ...result },
});
const turn: EventItem = {
  id: 1,
  kind: "turn_start",
  ts: 1,
  runner_type: "t",
  payload: {},
};

test("mcpCallProblems: the calls in order, each with its outcome and refusal reason", () => {
  const items = [
    turn,
    call(2, "ticket_get", { outcome: "ok" }),
    call(3, "ticket_update", {
      outcome: "refused",
      reason: "cross_ticket_write",
    }),
  ];
  const get = { tool: "ticket_get", outcome: "ok" } as const;
  expect(
    mcpCallProblems(items, [
      get,
      {
        tool: "ticket_update",
        outcome: "refused",
        reason: "cross_ticket_write",
      },
    ]),
  ).toEqual([]);
  expect(
    mcpCallProblems(items, [
      get,
      { tool: "ticket_update", outcome: "refused", reason: "not_found" },
    ]),
  ).toEqual([
    "the mcp calls were ticket_get ok, ticket_update refused:cross_ticket_write; " +
      "expected ticket_get ok, ticket_update refused:not_found",
  ]);
  expect(mcpCallProblems([turn], [get])).toEqual([
    "the mcp calls were none; expected ticket_get ok",
  ]);
});

test("ticketEventProblems: A carries an event the session itself wrote", () => {
  const created = {
    actor_kind: "operator",
    actor_id: "operator",
    kind: "created",
  };
  const updated = { actor_kind: "session", actor_id: "S1", kind: "updated" };
  expect(ticketEventProblems([created, updated], "S1")).toEqual([]);
  expect(ticketEventProblems([created], "S1")).toEqual([
    "no ticket event by session S1 (seen: created by operator:operator)",
  ]);
});

test("followupProblems: one ticket filed, a follow-up waiting for a human, not retitled", () => {
  const b = {
    num: 2,
    title: "B",
    type: "followup",
    status: "backlog",
    needs_human: 1,
  };
  expect(followupProblems([b], "B")).toEqual([]);
  expect(followupProblems([], "B")).toEqual(["the session filed no ticket"]);
  expect(followupProblems([b, { ...b, num: 3 }], "B")).toEqual([
    "the session filed 2 tickets (#2, #3), expected 1",
  ]);
  expect(
    followupProblems(
      [{ ...b, needs_human: 0, type: "chore", title: "B2" }],
      "B",
    ),
  ).toEqual([
    "#2 is not waiting for a human (needs_human 0)",
    "#2 is a chore, expected a followup",
    '#2 is titled "B2", expected "B": the refused write landed',
  ]);
});

test("auditProblems: the expected rows in order; a target is checked only where given", () => {
  const row = (action: string, outcome: string, target_id: string | null) => ({
    action,
    target_id,
    payload_json: JSON.stringify({ args_sha256: "x", bytes: 2, outcome }),
  });
  const first = row("mcp.ticket_update", "ok", "A");
  const rows = [
    first,
    row("mcp.ticket_update", "refused:cross_ticket_write", "S1"),
  ];
  const landed = { action: "mcp.ticket_update", outcome: "ok", target_id: "A" };
  const refused = {
    action: "mcp.ticket_update",
    outcome: "refused:cross_ticket_write",
  };
  expect(auditProblems(rows, [landed, refused])).toEqual([]);
  expect(auditProblems(rows, [refused, landed])).toEqual([
    "no audit row mcp.ticket_update ok A after the ones before it " +
      "(the session's rows: mcp.ticket_update ok A, mcp.ticket_update refused:cross_ticket_write S1)",
  ]);
  expect(auditProblems([{ ...first, payload_json: null }], [landed])).toEqual([
    "no audit row mcp.ticket_update ok A after the ones before it " +
      "(the session's rows: mcp.ticket_update ? A)",
  ]);
});

test("askProblems: exactly one open question, on ticket A", () => {
  const q = { question: "q?", status: "open", ticket_id: "A" };
  expect(askProblems([q], "A")).toEqual([]);
  expect(askProblems([], "A")).toEqual(["the session asked no question"]);
  expect(
    askProblems([{ ...q, status: "answered", ticket_id: "B" }], "A"),
  ).toEqual([
    'the question is "answered", expected open',
    "the question is on ticket B, expected A",
  ]);
  expect(askProblems([q, q], "A")).toEqual([
    "the session asked 2 questions, expected 1",
  ]);
});
