import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import type { TicketExportState } from "../schema-work.js";
import { OPERATOR, newTicketInput, tempDb, unwrap } from "../testing.js";
import { listTicketExports, upsertTicketExport } from "./ticket-exports.js";
import { createTicket } from "./ticket-writes.js";
import { listNeedsAttention } from "./work-views.js";

// ticket_exports is the supervisor's (M1 amendment 5): the exporter's script runner writes it.
const clock = new FakeClock(1_700_000_000_000);
const t = unwrap(await tempDb(clock));
afterAll(() => t.cleanup());
const ticket = unwrap(await createTicket(t.db, newTicketInput(), OPERATOR));

const validation = { ok: false, error: { class: "validation" } };
const PATH = "exports/tickets/FOR-1.md";

test("upsertTicketExport inserts a row, then replaces it for the same ticket and target", async () => {
  const synced = unwrap(
    await upsertTicketExport(t.db, {
      ticket_id: ticket.id,
      target: "markdown",
      path: PATH,
      content_hash: "h1",
      state: "synced",
      last_synced_at: clock.now(),
    }),
  );
  expect(synced).toEqual({
    ticket_id: ticket.id,
    target: "markdown",
    external_key: null,
    url: null,
    path: PATH,
    direction: "push",
    content_hash: "h1",
    state: "synced",
    last_synced_at: clock.now(),
    error: null,
  });
  const failed = unwrap(
    await upsertTicketExport(t.db, {
      ticket_id: ticket.id,
      target: "markdown",
      path: PATH,
      content_hash: "h2",
      state: "failed",
      error: "git commit exited 1",
    }),
  );
  expect(failed).toEqual({
    ...synced,
    content_hash: "h2",
    state: "failed",
    last_synced_at: null,
    error: "git commit exited 1",
  });
  expect(unwrap(await listTicketExports(t.db, ticket.id))).toEqual([failed]);
});

test("a failed export is on v_needs_attention until it syncs (amendment 4)", async () => {
  const exportFailed = (rows: { why: string; ticket_id: string | null }[]) =>
    rows.filter((r) => r.why === "export_failed");
  unwrap(
    await upsertTicketExport(t.db, {
      ticket_id: ticket.id,
      target: "markdown",
      state: "failed",
      error: "boom",
    }),
  );
  expect(exportFailed(unwrap(await listNeedsAttention(t.db)))).toEqual([
    { why: "export_failed", ref: "markdown", ticket_id: ticket.id },
  ]);
  unwrap(
    await upsertTicketExport(t.db, {
      ticket_id: ticket.id,
      target: "markdown",
      state: "synced",
    }),
  );
  expect(exportFailed(unwrap(await listNeedsAttention(t.db)))).toEqual([]);
});

test("listTicketExports orders a ticket's exports by target", async () => {
  unwrap(
    await upsertTicketExport(t.db, {
      ticket_id: ticket.id,
      target: "jira",
      external_key: "BAY-1",
      url: "https://example.test/BAY-1",
      state: "pending",
    }),
  );
  expect(
    unwrap(await listTicketExports(t.db, ticket.id)).map((e) => e.target),
  ).toEqual(["jira", "markdown"]);
  expect(unwrap(await listTicketExports(t.db, "nope"))).toEqual([]);
});

test("upsertTicketExport refuses an unknown state, an empty target and an unknown ticket", async () => {
  for (const bad of [
    { target: "markdown", state: "weird" as TicketExportState },
    { target: "", state: "pending" as const },
  ]) {
    expect(
      await upsertTicketExport(t.db, { ticket_id: ticket.id, ...bad }),
      JSON.stringify(bad),
    ).toMatchObject(validation);
  }
  expect(
    await upsertTicketExport(t.db, {
      ticket_id: "nope",
      target: "markdown",
      state: "pending",
    }),
  ).toMatchObject(validation);
});
