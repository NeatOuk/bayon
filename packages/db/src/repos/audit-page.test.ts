// GET /audit's read: newest first, paged by id, exact and prefix filters.
import { FakeClock } from "@bayon/core";
import { afterAll, beforeAll, expect, test } from "vitest";
import { tempDb, unwrap, type TempDb } from "../testing.js";
import { appendAudit } from "./audit.js";
import { auditMatch, listAuditPage } from "./audit-page.js";

let t: TempDb;

const ROWS = [
  { actor: "operator", action: "fleet.pause" },
  { actor: "session:S1", action: "mcp.ticket_update" },
  { actor: "session:S2", action: "mcp.human_ask" },
  { actor: "supervisor", action: "command.requeue" },
  { actor: "operator", action: "settings.put" },
  { actor: "Session:S3", action: "mcp.ticket_update" },
  { actor: "operator", action: "fleet.resume" },
];

beforeAll(async () => {
  t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  for (const row of ROWS) unwrap(await appendAudit(t.db, row));
});
afterAll(() => t.cleanup());

const actions = (rows: readonly { readonly action: string }[]) =>
  rows.map((r) => r.action);

test("newest first, a page at a time: `before` the last id, until has_more is false", async () => {
  const first = unwrap(await listAuditPage(t.db, { limit: 3 }));
  expect(actions(first.rows)).toEqual([
    "fleet.resume",
    "mcp.ticket_update",
    "settings.put",
  ]);
  expect(first.hasMore).toBe(true);
  const second = unwrap(
    await listAuditPage(t.db, { limit: 3, before: first.rows.at(-1)?.id }),
  );
  expect(actions(second.rows)).toEqual([
    "command.requeue",
    "mcp.human_ask",
    "mcp.ticket_update",
  ]);
  const last = unwrap(
    await listAuditPage(t.db, { limit: 3, before: second.rows.at(-1)?.id }),
  );
  expect(actions(last.rows)).toEqual(["fleet.pause"]);
  expect(last.hasMore).toBe(false);
});

test("an exact actor, and a prefix one, case and all (never LIKE's folding)", async () => {
  const operator = unwrap(
    await listAuditPage(t.db, { limit: 50, actor: "operator" }),
  );
  expect(actions(operator.rows)).toEqual([
    "fleet.resume",
    "settings.put",
    "fleet.pause",
  ]);
  const sessions = unwrap(
    await listAuditPage(t.db, { limit: 50, actor: "session:*" }),
  );
  expect(sessions.rows.map((r) => r.actor)).toEqual([
    "session:S2",
    "session:S1",
  ]);
});

test("an action prefix, combined with an actor", async () => {
  const mcp = unwrap(await listAuditPage(t.db, { limit: 50, action: "mcp.*" }));
  expect(mcp.rows).toHaveLength(3);
  const fleet = unwrap(
    await listAuditPage(t.db, {
      limit: 50,
      actor: "operator",
      action: "fleet.*",
    }),
  );
  expect(actions(fleet.rows)).toEqual(["fleet.resume", "fleet.pause"]);
  const none = unwrap(
    await listAuditPage(t.db, { limit: 50, action: "fleet." }),
  );
  expect(none.rows).toEqual([]);
});

test("auditMatch: a trailing * is a prefix, anything else exact", () => {
  expect(auditMatch("session:*")).toEqual({ prefix: "session:" });
  expect(auditMatch("operator")).toEqual({ exact: "operator" });
});
