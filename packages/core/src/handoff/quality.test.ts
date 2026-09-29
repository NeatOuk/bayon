import { describe, expect, test } from "vitest";
import { HandoffQuality, holdsTicket, type HoldingSession } from "./quality.js";

// The holding rule.
const T = { id: "T", status: "building", owner_session_id: null };
const builder: HoldingSession = {
  id: "S1",
  role: "builder",
  ticket_id: "T",
  handoff_in_id: null,
};

describe("holdsTicket", () => {
  test("a builder carrying the open ticket holds it", () => {
    expect(holdsTicket(builder, T)).toBe(true);
    expect(holdsTicket({ ...builder, role: "investigator" }, T)).toBe(true);
  });

  test("a reviewer or an orchestrator carrying the ticket never holds it", () => {
    expect(holdsTicket({ ...builder, role: "reviewer" }, T)).toBe(false);
    expect(holdsTicket({ ...builder, role: "orchestrator" }, T)).toBe(false);
  });

  test.each(["done", "blocked", "rejected", "parked", "split"])(
    "nobody holds a %s ticket",
    (status) => {
      expect(holdsTicket(builder, { ...T, status })).toBe(false);
    },
  );

  test("a successor holds the ticket only once it accepted (owns it)", () => {
    const successor = { ...builder, id: "S2", handoff_in_id: "h1" };
    expect(holdsTicket(successor, T)).toBe(false);
    expect(holdsTicket(successor, { ...T, owner_session_id: "S1" })).toBe(
      false,
    );
    expect(holdsTicket(successor, { ...T, owner_session_id: "S2" })).toBe(true);
  });

  test("no ticket, or another ticket, is not held", () => {
    expect(holdsTicket(builder, null)).toBe(false);
    expect(holdsTicket({ ...builder, ticket_id: null }, T)).toBe(false);
    expect(holdsTicket(builder, { ...T, id: "U" })).toBe(false);
  });
});

test("HandoffQuality is writing, full or degraded", () => {
  expect(HandoffQuality.options).toEqual(["writing", "full", "degraded"]);
});
