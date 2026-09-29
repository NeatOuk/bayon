import { expect, test } from "vitest";
import { HandoffsQuery, SessionHandoffRequest } from "./handoffs.js";

test("POST /sessions/:id/handoff: no body is the operator's; a death or an agent's own reason is refused", () => {
  expect(SessionHandoffRequest.parse(undefined)).toEqual({
    reason: "operator",
  });
  expect(
    SessionHandoffRequest.parse({ reason: "phase_change", note: "to review" }),
  ).toEqual({ reason: "phase_change", note: "to review" });
  for (const bad of [
    { reason: "session_death" },
    { reason: "agent_request" },
    { note: "" },
    { extra: 1 },
  ]) {
    expect(SessionHandoffRequest.safeParse(bad).success).toBe(false);
  }
});

test("GET /handoffs: pending=1 is a flag, the ticket a ULID or number, the limit bounded", () => {
  expect(HandoffsQuery.parse({ ticket: "12", pending: "1" })).toEqual({
    ticket: "12",
    pending: true,
    limit: 100,
  });
  expect(HandoffsQuery.parse({ pending: "0" })).toMatchObject({
    pending: false,
  });
  for (const bad of [
    { ticket: "ticket-1" },
    { pending: "yes" },
    { limit: "0" },
    { limit: "501" },
  ]) {
    expect(HandoffsQuery.safeParse(bad).success).toBe(false);
  }
});
