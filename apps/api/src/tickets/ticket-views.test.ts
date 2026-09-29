import { FakeClock } from "@bayon/core";
import {
  listTicketEvents,
  type GateRow,
  type TicketEconomicsRow,
} from "@bayon/db";
import { createTicket } from "@bayon/db/api";
import {
  OPERATOR,
  newTicketInput,
  seedSpine,
  tempDb,
  unwrap,
} from "@bayon/db/testing";
import { afterAll, describe, expect, test } from "vitest";
import {
  toEconomics,
  toEventView,
  toGateViews,
  toLinkViews,
  toTicketView,
} from "./ticket-views.js";

// Rows into DTOs: a stored row that does not fit is an internal error, never sent on.

const clock = new FakeClock(1_700_000_000_000);
const t = unwrap(await tempDb(clock));
unwrap(await seedSpine(t.db, 3));
afterAll(() => t.cleanup());

const ticket = unwrap(await createTicket(t.db, newTicketInput(), OPERATOR));
const created = unwrap(
  await listTicketEvents(t.db, { ticket_id: ticket.id, since: 0, limit: 1 }),
).rows[0];

const gate = (o: Partial<GateRow>): GateRow => ({
  id: "g1",
  ticket_id: ticket.id,
  kind: "code_review",
  required: 1,
  state: "passed",
  attempt: 1,
  round: 1,
  repo_id: null,
  reviewer_session_id: null,
  subject_kind: "diff",
  subject_ref: "base..head",
  evidence_json: null,
  findings_total: null,
  findings_unresolved: null,
  waived_by: null,
  waive_reason: null,
  started_at: null,
  decided_at: null,
  ...o,
});

describe("ticket views", () => {
  test("a ticket keys by prefix, parses its complexity factors and carries its open questions", () => {
    expect(toTicketView(ticket, "FRM-", 2)).toMatchObject({
      ok: true,
      value: {
        key: `FRM-${ticket.num}`,
        complexity_factors: null,
        open_questions: 2,
      },
    });
  });

  test("unparseable factors or an unknown status are internal errors", () => {
    expect(
      toTicketView({ ...ticket, complexity_factors_json: "{nope" }, "FRM-", 0),
    ).toMatchObject({
      ok: false,
      error: {
        class: "internal",
        message: expect.stringContaining("not JSON"),
      },
    });
    expect(
      toTicketView({ ...ticket, status: "bogus" }, "FRM-", 0),
    ).toMatchObject({
      ok: false,
      error: { class: "internal" },
    });
  });

  test("an event's payload must be JSON", () => {
    if (created === undefined) throw new Error("no created event");
    expect(toEventView(created)).toMatchObject({
      ok: true,
      value: { kind: "created" },
    });
    expect(toEventView({ ...created, payload_json: "{nope" })).toMatchObject({
      ok: false,
      error: { class: "internal" },
    });
  });

  test("a gate counts missing findings as none and holds its own findings", () => {
    const views = toGateViews(
      [gate({ id: "g1" }), gate({ id: "g2", kind: "ce_review", required: 0 })],
      [
        {
          id: "f1",
          gate_id: "g2",
          severity: "minor",
          category: null,
          file: "a.ts",
          line: 3,
          summary: "nit",
          detail_md: null,
          status: "open",
          resolved_by_run_id: null,
          resolution_note: null,
          resolved_by: null,
          resolved_at: null,
          waived_by: null,
          waive_reason: null,
          created_at: 1,
        },
      ],
    );
    expect(views).toMatchObject({
      ok: true,
      value: [
        { id: "g1", required: true, findings_total: 0, findings: [] },
        {
          id: "g2",
          required: false,
          findings: [{ id: "f1", severity: "minor" }],
        },
      ],
    });
  });

  test("a bad finding, gate or link fails the whole list", () => {
    const badFinding = toGateViews(
      [gate({})],
      [
        {
          id: "f1",
          gate_id: "g1",
          severity: "blocker",
          category: null,
          file: null,
          line: null,
          summary: "s",
          detail_md: null,
          status: "open",
          resolved_by_run_id: null,
          resolution_note: null,
          resolved_by: null,
          resolved_at: null,
          waived_by: null,
          waive_reason: null,
          created_at: -1,
        },
      ],
    );
    expect(badFinding).toMatchObject({
      ok: false,
      error: { class: "internal" },
    });
    expect(toGateViews([gate({ attempt: 0 })], [])).toMatchObject({
      ok: false,
    });
    expect(
      toLinkViews([
        {
          ticket_id: ticket.id,
          kind: "pr",
          url: "u",
          target_ticket_id: null,
          created_at: 1,
        },
        {
          ticket_id: ticket.id,
          kind: "pr",
          url: "u",
          target_ticket_id: null,
          created_at: -5,
        },
      ]),
    ).toMatchObject({ ok: false, error: { class: "internal" } });
  });

  test("economics must fit", () => {
    const row: TicketEconomicsRow = {
      id: ticket.id,
      num: ticket.num,
      title: "t",
      status: "backlog",
      complexity_tier: "cheap",
      cost_usd: 0,
      cost_wasted_usd: 0,
      review_rounds: 0,
      handoff_count: 0,
      phase_handoff_count: 0,
      sessions: 0,
      tokens: 0,
      cache_ratio: null,
    };
    expect(toEconomics(row).ok).toBe(true);
    expect(toEconomics({ ...row, cost_usd: -1 }).ok).toBe(false);
  });
});
