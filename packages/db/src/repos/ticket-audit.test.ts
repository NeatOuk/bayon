// a ticket write and its audit row commit in one transaction, so no crash can
// leave a mutation unaudited. An audit entry that cannot be written, inside the writer's own
// transaction after the ticket write, is the forced failure: it rolls both back.
import { FakeClock, ok } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { internalsOf } from "../connection.js";
import {
  OPERATOR,
  newTicketInput,
  seedSpine,
  tempDb,
  unwrap,
} from "../testing.js";
import type { AuditEntry } from "./audit.js";
import { appendTicketEvent, linkTicket } from "./ticket-events.js";
import { transitionTicket } from "./ticket-transition.js";
import { createTicket, updateTicketCas } from "./ticket-writes.js";

const clock = new FakeClock(1_700_000_000_000);
const t = unwrap(await tempDb(clock));
unwrap(await seedSpine(t.db, 3));
afterAll(() => t.cleanup());

const raw = unwrap(internalsOf(t.db)).raw;
type Table = "audit_log" | "tickets" | "ticket_events" | "ticket_links";
const count = (table: Table) =>
  (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const snapshot = () => ({
  audit: count("audit_log"),
  tickets: count("tickets"),
  events: count("ticket_events"),
  links: count("ticket_links"),
});

const good = (action: string): AuditEntry => ({
  actor: "session:S",
  action,
  target_kind: "ticket",
  target_id: null,
  payload: { outcome: "ok" },
});
/** Cannot be inserted: it fails inside the writer's transaction, after the ticket write. */
const failing: AuditEntry = { actor: "", action: "mcp.forced_failure" };
const refused = { ok: false, error: { class: "validation" } };

test("createTicket commits the ticket, its event and its audit row together, the audit naming it", async () => {
  const before = snapshot();
  const created = unwrap(
    await createTicket(
      t.db,
      newTicketInput(),
      OPERATOR,
      good("mcp.ticket_create"),
    ),
  );
  expect(snapshot()).toEqual({
    ...before,
    audit: before.audit + 1,
    tickets: before.tickets + 1,
    events: before.events + 1,
  });
  expect(
    raw
      .prepare("SELECT target_kind, target_id FROM audit_log ORDER BY id DESC")
      .get(),
  ).toEqual({ target_kind: "ticket", target_id: created.id });
});

test("a forced failure after each ticket write rolls back the write and its audit row", async () => {
  const ticket = unwrap(await createTicket(t.db, newTicketInput(), OPERATOR));
  const other = unwrap(await createTicket(t.db, newTicketInput(), OPERATOR));
  const before = snapshot();
  expect(
    await createTicket(t.db, newTicketInput(), OPERATOR, failing),
  ).toMatchObject(refused);
  expect(
    await updateTicketCas(
      t.db,
      { id: ticket.id, version: 1, patch: { title: "renamed" }, by: OPERATOR },
      failing,
    ),
  ).toMatchObject(refused);
  expect(
    await transitionTicket(
      t.db,
      { id: ticket.id, version: 1, to: "prioritized", by: OPERATOR },
      () => ok(undefined),
      failing,
    ),
  ).toMatchObject(refused);
  expect(
    await appendTicketEvent(
      t.db,
      {
        ticket_id: ticket.id,
        kind: "comment",
        ...OPERATOR,
        payload: { body_md: "x" },
      },
      failing,
    ),
  ).toMatchObject(refused);
  expect(
    await linkTicket(
      t.db,
      { ticket_id: ticket.id, kind: "relates", target_ticket_id: other.id },
      OPERATOR,
      failing,
    ),
  ).toMatchObject(refused);
  expect(snapshot()).toEqual(before);
  expect(
    raw
      .prepare("SELECT title, status, version FROM tickets WHERE id = ?")
      .get(ticket.id),
  ).toEqual({ title: "fixture ticket", status: "backlog", version: 1 });
});

test("each writer with a good audit entry writes exactly one audit row alongside", async () => {
  const ticket = unwrap(await createTicket(t.db, newTicketInput(), OPERATOR));
  const other = unwrap(await createTicket(t.db, newTicketInput(), OPERATOR));
  const before = count("audit_log");
  unwrap(
    await updateTicketCas(
      t.db,
      { id: ticket.id, version: 1, patch: { title: "renamed" }, by: OPERATOR },
      good("mcp.ticket_update"),
    ),
  );
  unwrap(
    await transitionTicket(
      t.db,
      { id: ticket.id, version: 2, to: "prioritized", by: OPERATOR },
      () => ok(undefined),
      good("mcp.ticket_update"),
    ),
  );
  unwrap(
    await appendTicketEvent(
      t.db,
      {
        ticket_id: ticket.id,
        kind: "comment",
        ...OPERATOR,
        payload: { body_md: "x" },
      },
      good("mcp.ticket_comment"),
    ),
  );
  unwrap(
    await linkTicket(
      t.db,
      { ticket_id: ticket.id, kind: "relates", target_ticket_id: other.id },
      OPERATOR,
      good("mcp.ticket_link"),
    ),
  );
  expect(count("audit_log")).toBe(before + 4);
});
