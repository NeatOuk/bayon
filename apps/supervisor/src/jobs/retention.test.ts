import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { FakeClock } from "@bayon/core";
import { getEventsSince } from "@bayon/db";
import { insertEventsBatch, recordBackup } from "@bayon/db/supervisor";
import {
  appendEvents,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "@bayon/db/testing";
import { afterAll, expect, test } from "vitest";
import { DAY_MS, runRetention } from "./retention.js";

// Event retention against a real temp database and FRM_HOME: only after that day's
// good backup, archived before it is deleted, and idempotent.
const NOW = Date.UTC(2026, 8, 14, 4);
const clock = new FakeClock(NOW);
const t = unwrap(await tempDb(clock));
const home = mkdtempSync(join(tmpdir(), "bayon-retention-"));
afterAll(() => {
  t.cleanup();
  rmSync(home, { recursive: true, force: true });
});

const RAW = '{"type":"raw"}\n';
const rawLog = join(
  home,
  "runtime",
  "sessions",
  "s-old",
  "logs",
  "stdout.jsonl",
);
mkdirSync(dirname(rawLog), { recursive: true });
writeFileSync(rawLog, RAW);

unwrap(await seedSpine(t.db, 12));
unwrap(
  await seedRows(t.db, {
    tickets: [
      ticketRow(1, { status: "done", closed_at: NOW - 40 * DAY_MS }),
      ticketRow(2, { status: "done", closed_at: NOW - 10 * DAY_MS }),
      ticketRow(3, { status: "building" }),
    ],
    sessions: [
      {
        ...newSessionInput(),
        id: "s-old",
        ticket_id: "ticket-1",
        state: "exited",
        raw_log_path: rawLog,
        created_at: 0,
      },
      {
        ...newSessionInput(),
        id: "s-recent",
        ticket_id: "ticket-2",
        state: "exited",
        created_at: 0,
      },
      {
        ...newSessionInput(),
        id: "s-open",
        ticket_id: "ticket-3",
        state: "exited",
        created_at: 0,
      },
    ],
  }),
);
const oldIds = unwrap(await appendEvents(t.db, "s-old", 250));
unwrap(await appendEvents(t.db, "s-recent", 3));
unwrap(await appendEvents(t.db, "s-open", 3));
unwrap(
  await insertEventsBatch(t.db, [
    {
      session_id: "s-old",
      ts: NOW,
      kind: "reasoning",
      runner_type: "thinking",
      text: "why",
      raw_offset: 1_000,
    },
  ]),
);

const archiveDir = join(home, "archive", "events");
const today = join(archiveDir, "20260914");
const retention = () =>
  runRetention({
    db: t.db,
    clock,
    archiveDir,
    eventsDays: 30,
    keepReasoning: true,
  });
const count = async (sessionId: string) =>
  unwrap(await getEventsSince(t.db, { sessionId, since: 0, limit: 1_000 })).rows
    .length;
const attempt = (ended_at: number, outcome: "ok" | "failed") =>
  recordBackup(
    t.db,
    outcome === "ok"
      ? { started_at: ended_at, ended_at, outcome, path: "/b/x.frmbak" }
      : { started_at: ended_at, ended_at, outcome, error: "disk full" },
  );

test("does nothing until that day's backup has succeeded", async () => {
  expect(unwrap(await retention())).toEqual({
    ran: false,
    reason: expect.stringContaining("no backup"),
  });
  unwrap(await attempt(NOW - DAY_MS, "ok"));
  expect(unwrap(await retention())).toEqual({
    ran: false,
    reason: expect.stringContaining("today"),
  });
  unwrap(await attempt(NOW - 60_000, "failed"));
  expect(unwrap(await retention())).toEqual({
    ran: false,
    reason: expect.stringContaining("failed"),
  });
  expect(await count("s-old")).toBe(251);
  expect(existsSync(archiveDir)).toBe(false);
});

test("after today's good backup: archived to gzipped JSONL a batch at a time, then deleted", async () => {
  unwrap(await attempt(NOW - 30_000, "ok"));
  const before = t.db.stats.txns;
  const out = unwrap(await retention());
  if (!out.ran) throw new Error(out.reason);
  expect(out.archived).toBe(250);
  expect(out.files).toHaveLength(3);
  // One delete transaction per batch of 100: 100, 100, 50.
  expect(t.db.stats.txns - before).toBe(3);
  const rows = out.files.flatMap((file) => {
    expect(file.startsWith(`${today}/events-`)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    return gunzipSync(readFileSync(file))
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  });
  expect(rows.map((row) => row["id"])).toEqual(oldIds);
  expect(rows[0]).toMatchObject({
    session_id: "s-old",
    ticket_id: "ticket-1",
    kind: "assistant_text",
    payload_json: "{}",
  });
  expect(statSync(today).mode & 0o777).toBe(0o700);
  // The reasoning event stays (retention.reasoning = keep), as do other tickets' events.
  expect(await count("s-old")).toBe(1);
  expect(await count("s-recent")).toBe(3);
  expect(await count("s-open")).toBe(3);
  // The raw log is the replay source: untouched.
  expect(readFileSync(rawLog, "utf8")).toBe(RAW);
});

test("a second run archives and deletes nothing new", async () => {
  const files = readdirSync(today);
  const before = t.db.stats.txns;
  expect(unwrap(await retention())).toEqual({
    ran: true,
    archived: 0,
    files: [],
  });
  expect(t.db.stats.txns).toBe(before);
  expect(readdirSync(today)).toEqual(files);
});
