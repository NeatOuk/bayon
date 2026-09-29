import { describe, expect, test } from "vitest";
import {
  decideAccept,
  handoffLabelNumber,
  type AcceptFacts,
  type AcceptRow,
  type AcceptSession,
} from "./accept.js";

// handoff_accept's law: every branch, since the API's writer decides with it inside its transaction.

const SESSION: AcceptSession = {
  id: "S2",
  role: "builder",
  ticket_id: "T",
  handoff_in_id: null,
};
const ROW: AcceptRow = {
  id: "H1",
  ticket_id: "T",
  quality: "full",
  accepted_at: null,
  to_session_id: null,
};
const TICKET = { id: "T", status: "building", owner_session_id: null };

const facts = (o: Partial<AcceptFacts> = {}): AcceptFacts => ({
  session: SESSION,
  requested: null,
  row: null,
  ticket: TICKET,
  pending: null,
  ...o,
});

describe("accepting a row (by id, or the session's own handoff_in_id)", () => {
  test("a pending row on the session's ticket is accepted", () => {
    const accept = { kind: "accept", handoffId: "H1", ticketId: "T" };
    expect(decideAccept(facts({ requested: "H1", row: ROW }))).toEqual(accept);
    const successor = { ...SESSION, handoff_in_id: "H1" };
    expect(decideAccept(facts({ session: successor, row: ROW }))).toEqual(
      accept,
    );
    // A degraded packet is as takeable as a full one.
    expect(
      decideAccept(
        facts({ requested: "H1", row: { ...ROW, quality: "degraded" } }),
      ),
    ).toEqual(accept);
  });

  test("the same session accepting again is a repeat; another session's accept is refused", () => {
    const accepted = { ...ROW, accepted_at: 5, to_session_id: "S2" };
    expect(decideAccept(facts({ requested: "H1", row: accepted }))).toEqual({
      kind: "already",
      handoffId: "H1",
      ticketId: "T",
    });
    expect(
      decideAccept(
        facts({ requested: "H1", row: { ...accepted, to_session_id: "S9" } }),
      ),
    ).toEqual({
      kind: "refused",
      reason: "not_pending",
      detail: "hand-off H1 was accepted by session S9",
    });
  });

  test("a row still being written is not pending", () => {
    expect(
      decideAccept(
        facts({ requested: "H1", row: { ...ROW, quality: "writing" } }),
      ),
    ).toEqual({
      kind: "refused",
      reason: "not_pending",
      detail: "hand-off H1 is still being written",
    });
  });

  test("an unknown id, another ticket's row, or not the row the session was spawned for is refused", () => {
    expect(decideAccept(facts({ requested: "H9" }))).toMatchObject({
      reason: "not_found",
    });
    expect(
      decideAccept(
        facts({ requested: "H1", row: { ...ROW, ticket_id: "OTHER" } }),
      ),
    ).toMatchObject({ reason: "cross_ticket_write" });
    expect(
      decideAccept(
        facts({
          session: { ...SESSION, handoff_in_id: "H0" },
          requested: "H1",
          row: ROW,
        }),
      ),
    ).toMatchObject({ reason: "actor_not_allowed" });
  });

  test("an accepted row whose accepter is unknown still names someone", () => {
    const orphan = { ...ROW, accepted_at: 5, to_session_id: null };
    expect(decideAccept(facts({ requested: "H1", row: orphan }))).toMatchObject(
      {
        reason: "not_pending",
        detail: "hand-off H1 was accepted by session ?",
      },
    );
  });
});

describe("packet labels, and the call a refusal names", () => {
  test("handoffLabelNumber reads handoff-<n> as the packet header shows it, and nothing else", () => {
    expect(handoffLabelNumber("handoff-1")).toBe(1);
    expect(handoffLabelNumber("handoff-12")).toBe(12);
    for (const ref of [
      "handoff-0",
      "handoff-",
      "Handoff-1",
      "handoff-1.md",
      "01M2DST3T87FSWN6EYS71CYRX5",
      "H1",
    ]) {
      expect(handoffLabelNumber(ref), ref).toBeNull();
    }
  });

  test("a successor's refusal names the no-argument call: an unmatched label, another row", () => {
    const successor = { ...SESSION, handoff_in_id: "H1" };
    expect(
      decideAccept(facts({ session: successor, requested: "handoff-2" })),
    ).toEqual({
      kind: "refused",
      reason: "not_found",
      detail:
        "no hand-off handoff-2 on your ticket; you were handed H1: call handoff_accept with no arguments",
    });
    expect(
      decideAccept(
        facts({
          session: successor,
          requested: "H0",
          row: { ...ROW, id: "H0" },
        }),
      ),
    ).toMatchObject({
      reason: "actor_not_allowed",
      detail: expect.stringContaining(
        "you were handed H1: call handoff_accept with no arguments",
      ),
    });
  });

  test("a session handed nothing is told every form that works", () => {
    expect(decideAccept(facts({ requested: "H9" }))).toMatchObject({
      reason: "not_found",
      detail:
        "no hand-off H9; call handoff_accept with no arguments, or name a hand-off on your ticket by its id or its packet label (handoff-<n>)",
    });
  });
});

describe("claiming (no id, no handoff_in_id): the session's own unowned ticket", () => {
  test("an open, unowned ticket with no pending hand-off is claimed by a holding role", () => {
    const claim = { kind: "claim", ticketId: "T" };
    expect(decideAccept(facts())).toEqual(claim);
    expect(
      decideAccept(facts({ session: { ...SESSION, role: "investigator" } })),
    ).toEqual(claim);
  });

  test("the owner claiming again is a repeat", () => {
    expect(
      decideAccept(facts({ ticket: { ...TICKET, owner_session_id: "S2" } })),
    ).toEqual({ kind: "already", handoffId: null, ticketId: "T" });
  });

  test("refused: no ticket, a non-holding role, a closed ticket, another owner, a pending hand-off", () => {
    expect(decideAccept(facts({ ticket: null }))).toMatchObject({
      reason: "not_found",
    });
    for (const role of ["reviewer", "orchestrator"]) {
      expect(
        decideAccept(facts({ session: { ...SESSION, role } })),
      ).toMatchObject({ reason: "actor_not_allowed" });
    }
    expect(
      decideAccept(facts({ ticket: { ...TICKET, status: "blocked" } })),
    ).toMatchObject({ reason: "not_claimable" });
    expect(
      decideAccept(facts({ ticket: { ...TICKET, owner_session_id: "S1" } })),
    ).toMatchObject({
      reason: "not_claimable",
      detail: "ticket T is owned by session S1",
    });
    expect(decideAccept(facts({ pending: "H1" }))).toMatchObject({
      reason: "not_claimable",
      detail: "ticket T has a pending hand-off: accept H1",
    });
  });
});
