import { FakeClock } from "@bayon/core";
import {
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import {
  TimelineEntry,
  TimelineExportQuery,
  TimelineQuery,
} from "@bayon/proto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { HistoryService } from "./history-service.js";
import { csvHeader, csvRow } from "./timeline-format.js";

// The export is the timeline's pages joined: the same rows in the same order in JSONL
// and in CSV, whatever page size it walks with, page boundaries inside a crowded millisecond
// included; the filters narrow it the same way; a page that fails mid-body throws.
const NOW = Date.UTC(2026, 8, 22, 9, 30);
const TIE = NOW - 60_000;
const clock = new FakeClock(NOW);
let t: TempDb;

async function seeded(): Promise<TempDb> {
  const db = unwrap(await tempDb(clock));
  unwrap(await seedSpine(db.db, 1));
  unwrap(
    await seedRows(db.db, {
      workspaces: [
        { id: "shop", name: "my shop!", kind: "single" },
        { id: "blog", name: "blog", kind: "single" },
      ],
      agents: [
        {
          id: "shop-builder",
          name: "shop-builder",
          kind: "builder",
          runner_id: "fixture",
          workspace_id: "shop",
          created_at: 0,
        },
      ],
      tickets: [ticketRow(1, { workspace_id: "shop" })],
      audit_log: [
        ...Array.from({ length: 23 }, (_, i) => ({
          ts: TIE,
          actor: i % 2 === 0 ? "operator" : "=cmd|' /C calc'!A0",
          action: `project.set${i}`,
          workspace_id: "shop",
          payload_json: JSON.stringify({ i }),
        })),
        {
          ts: TIE - 5,
          actor: "operator",
          action: "earlier",
          workspace_id: "shop",
        },
        {
          ts: TIE,
          actor: "operator",
          action: "elsewhere",
          workspace_id: "blog",
        },
      ],
      ticket_events: Array.from({ length: 7 }, (_, i) => ({
        ticket_id: "ticket-1",
        ts: TIE,
        actor_kind: "operator",
        actor_id: "operator",
        kind: "comment",
        reason: `note ${i}, with "quotes"\nand a second line`,
      })),
      sessions: Array.from({ length: 4 }, (_, i) => ({
        ...newSessionInput(),
        id: `S-${i}`,
        agent_id: "shop-builder",
        ticket_id: "ticket-1",
        state: "exited" as const,
        created_at: TIE - 10,
        started_at: TIE,
        ended_at: TIE + i,
      })),
    }),
  );
  return db;
}

beforeAll(async () => {
  t = await seeded();
});
afterAll(() => t.cleanup());

const service = (exportPageSize: number) =>
  new HistoryService({ db: t.db, clock, exportPageSize });

/** Every page of the timeline at `limit`, joined. */
async function walk(limit: number, filters: Record<string, unknown> = {}) {
  const items: TimelineEntry[] = [];
  let cursor: string | undefined;
  for (let n = 0; n < 200; n += 1) {
    const page = unwrap(
      await service(500).timeline(
        "shop",
        TimelineQuery.parse({
          ...filters,
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      ),
    );
    items.push(...page.items);
    if (page.next_cursor === null) return items;
    cursor = page.next_cursor;
  }
  throw new Error("more than 200 pages");
}

async function drain(body: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const chunk of body) text += chunk;
  return text;
}

async function exported(pageSize: number, query: Record<string, unknown> = {}) {
  const started = unwrap(
    await service(pageSize).export("shop", TimelineExportQuery.parse(query)),
  );
  return { ...started, text: await drain(started.body) };
}

const jsonl = (text: string): unknown[] =>
  text
    .split("\n")
    .filter((line) => line !== "")
    .map((line): unknown => JSON.parse(line));

test("JSONL: the pages joined, row for row, at every export page size", async () => {
  const pages = await walk(7);
  expect(pages.length).toBe(23 + 1 + 7 + 4 + 4);
  expect(new Set(pages.map((e) => `${e.source}/${e.key}`)).size).toBe(
    pages.length,
  );
  for (const size of [1, 3, 5, 500]) {
    const { text, contentType, filename } = await exported(size);
    expect(jsonl(text), `page size ${size}`).toEqual(pages);
    expect(contentType).toBe("application/x-ndjson; charset=utf-8");
    expect(filename).toBe("my_shop_-history-2026-09-22.jsonl");
  }
});

test("CSV: the header, then the pages joined, each row in the fixed columns", async () => {
  const pages = await walk(4);
  const { text, contentType, filename } = await exported(5, { format: "csv" });
  expect(text).toBe(csvHeader() + pages.map(csvRow).join(""));
  expect(text).toContain(`"'=cmd|' /C calc'!A0"`);
  expect(contentType).toBe("text/csv; charset=utf-8");
  expect(filename).toBe("my_shop_-history-2026-09-22.csv");
});

test("the filters narrow the export as they narrow the pages", async () => {
  const filters = { kind: "ticket.*,session.ended", q: "note" };
  const pages = await walk(2, filters);
  expect(pages.map((e) => e.kind)).toEqual(pages.map(() => "ticket.comment"));
  expect(pages.length).toBe(7);
  expect(jsonl((await exported(3, filters)).text)).toEqual(pages);
});

test("an unknown project or filter refuses before any byte is read", async () => {
  expect(
    await service(5).export("nope", TimelineExportQuery.parse({})),
  ).toMatchObject({ ok: false, error: { class: "not_found" } });
  expect(
    await service(5).export(
      "shop",
      TimelineExportQuery.parse({ ticket: "FRM-9" }),
    ),
  ).toMatchObject({ ok: false, error: { class: "validation" } });
});

test("a page that fails mid-body throws after the pages before it", async () => {
  const doomed = await seeded();
  const history = new HistoryService({
    db: doomed.db,
    clock,
    exportPageSize: 5,
  });
  const started = unwrap(
    await history.export("shop", TimelineExportQuery.parse({})),
  );
  const body = started.body[Symbol.asyncIterator]();
  const first = await body.next();
  expect(jsonl(String(first.value))).toHaveLength(5);
  unwrap(await doomed.db.close());
  await expect(body.next()).rejects.toThrow(/timeline export stopped/);
  doomed.cleanup();
});
