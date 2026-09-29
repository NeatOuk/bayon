// A project's history over HTTP against a temp-file DB: GET /projects/:id/timeline
// (200, paging, 404, 400), its export (headers, JSONL and CSV bodies equal to the pages joined across
// the 500-row page boundary, a failure mid-body cuts the response), and GET /agents/:id/sessions.
import { FakeClock, ok, systemClock, type Result } from "@bayon/core";
import { openDb, type Db } from "@bayon/db";
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
  AgentSessionsPage,
  ApiErrorBody,
  TimelinePage,
  type AgentSessionItem,
  type TimelineEntry,
} from "@bayon/proto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dbStore } from "../db-store.js";
import { startApi, type RunningApi } from "../server.js";
import { HistoryService, type TimelineExport } from "./history-service.js";
import { TIMELINE_CSV_COLUMNS } from "./timeline-format.js";

const TOKEN = "e2e-history-0123456789abcdef";
const NOW = Date.UTC(2026, 8, 22, 9, 30);
const TIE = NOW - 60_000;
/** More rows than one export page (500), most of them in one millisecond. */
const AUDIT_ROWS = 520;

let spine: TempDb;
let apiDb: Db;
let api: RunningApi;
let cut: RunningApi;

/** An export whose second page fails: what the controller does when a read breaks mid-body. */
class CutHistory extends HistoryService {
  override export(): Promise<Result<TimelineExport>> {
    async function* body(): AsyncGenerator<string> {
      yield `${JSON.stringify({ first: "page" })}\n`;
      await Promise.resolve();
      throw new Error("the second page failed");
    }
    return Promise.resolve(
      ok({
        filename: "shop-history.jsonl",
        contentType: "application/x-ndjson; charset=utf-8",
        body: body(),
      }),
    );
  }
}

const get = (path: string, base = api): Promise<Response> =>
  fetch(`${base.url}${path}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });

beforeAll(async () => {
  spine = unwrap(await tempDb(new FakeClock(NOW)));
  unwrap(await seedSpine(spine.db, 1));
  unwrap(
    await seedRows(spine.db, {
      workspaces: [
        { id: "shop", name: "shop", kind: "single" },
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
      tickets: [
        ticketRow(1, { workspace_id: "shop" }),
        ticketRow(2, { workspace_id: "blog" }),
      ],
      sessions: Array.from({ length: 5 }, (_, i) => ({
        ...newSessionInput(),
        id: `S-${i}`,
        agent_id: "shop-builder",
        ticket_id: "ticket-1",
        workspace_id: "shop",
        state: "exited" as const,
        exit_reason: "ok" as const,
        turns: i,
        cost_usd: i / 10,
        created_at: TIE - 100 + (i % 3),
        started_at: TIE,
        ended_at: TIE + 1,
      })),
      audit_log: [
        ...Array.from({ length: AUDIT_ROWS }, (_, i) => ({
          ts: TIE,
          actor: i === 0 ? "=HYPERLINK(1)" : "operator",
          action: `project.set${i}`,
          target_kind: "project",
          target_id: "shop",
          workspace_id: "shop",
        })),
        {
          ts: TIE,
          actor: "operator",
          action: "blog.only",
          workspace_id: "blog",
        },
      ],
      ticket_events: [
        {
          ticket_id: "ticket-1",
          ts: TIE - 1,
          actor_kind: "operator",
          actor_id: "operator",
          kind: "comment",
          reason: "shop note",
        },
        {
          ticket_id: "ticket-2",
          ts: TIE - 1,
          actor_kind: "operator",
          actor_id: "operator",
          kind: "comment",
          reason: "blog note",
        },
      ],
    }),
  );
  apiDb = unwrap(await openDb({ path: spine.path, clock: systemClock }));
  const deps = {
    config: { token: TOKEN, host: "127.0.0.1", port: 0 },
    store: dbStore(apiDb),
    clock: systemClock,
    logger: false as const,
  };
  api = await startApi({
    ...deps,
    history: new HistoryService({ db: apiDb, clock: new FakeClock(NOW) }),
  });
  cut = await startApi({
    ...deps,
    history: new CutHistory({ db: apiDb, clock: new FakeClock(NOW) }),
  });
});

afterAll(async () => {
  await api?.close();
  await cut?.close();
  await apiDb?.close();
  spine?.cleanup();
});

async function pages(path: string, limit: number): Promise<TimelineEntry[]> {
  const items: TimelineEntry[] = [];
  let cursor: string | null = null;
  for (let n = 0; n < 50; n += 1) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await get(
      `${path}${sep}limit=${limit}${cursor === null ? "" : `&cursor=${cursor}`}`,
    );
    expect(res.status).toBe(200);
    const page = TimelinePage.parse(await res.json());
    items.push(...page.items);
    if (!page.has_more) {
      expect(page.next_cursor).toBeNull();
      return items;
    }
    cursor = page.next_cursor;
  }
  throw new Error("more than 50 pages");
}

async function refusal(res: Response, status: number): Promise<string> {
  expect(res.status).toBe(status);
  return ApiErrorBody.parse(await res.json()).error.message;
}

describe("GET /projects/:id/timeline", () => {
  test("needs the operator's bearer", async () => {
    for (const path of [
      "/projects/shop/timeline",
      "/projects/shop/timeline/export",
      "/agents/shop-builder/sessions",
    ]) {
      const res = await fetch(`${api.url}${path}`);
      expect(res.status, path).toBe(401);
    }
  });

  test("pages the project's rows newest first, none of another project's, none lost or repeated", async () => {
    const all = await pages("/projects/shop/timeline", 200);
    expect(all.length).toBe(AUDIT_ROWS + 5 + 5 + 1);
    expect(new Set(all.map((e) => `${e.source}/${e.key}`)).size).toBe(
      all.length,
    );
    expect(all.map((e) => e.summary).join("\n")).not.toMatch(/blog/);
    expect(await pages("/projects/shop/timeline", 37)).toEqual(all);
    const first = TimelinePage.parse(
      await (await get("/projects/shop/timeline")).json(),
    );
    expect(first.items).toHaveLength(50);
    expect(first.items[0]).toMatchObject({
      source: "session",
      kind: "session.ended",
    });
  });

  test("kind as a list, repeated or comma-separated; agent, ticket, from/to and q", async () => {
    const repeated = await pages(
      "/projects/shop/timeline?kind=session.started&kind=ticket.*",
      200,
    );
    const comma = await pages(
      "/projects/shop/timeline?kind=session.started,ticket.*",
      200,
    );
    expect(comma).toEqual(repeated);
    expect(repeated.map((e) => e.kind).toSorted()).toEqual([
      ...Array.from({ length: 5 }, () => "session.started"),
      "ticket.comment",
    ]);
    const byAgent = await pages(
      "/projects/shop/timeline?agent=shop-builder",
      200,
    );
    expect(byAgent).toHaveLength(10);
    const byTicket = await pages(
      "/projects/shop/timeline?ticket=FRM-1&kind=ticket.*",
      200,
    );
    expect(byTicket.map((e) => e.summary)).toEqual([
      "FRM-1 comment: shop note",
    ]);
    const window = await pages(
      `/projects/shop/timeline?from=${TIE - 1}&to=${TIE}`,
      200,
    );
    expect(window.map((e) => e.kind)).toEqual(["ticket.comment"]);
    const q = await pages(
      `/projects/shop/timeline?q=${encodeURIComponent("set51%")}`,
      200,
    );
    expect(q).toEqual([]);
    const q2 = await pages("/projects/shop/timeline?q=set519", 200);
    expect(q2.map((e) => e.summary)).toEqual(["project.set519 project shop"]);
  });

  test("an unknown project is 404", async () => {
    expect(await refusal(await get("/projects/nope/timeline"), 404)).toMatch(
      /nope/,
    );
  });

  test.each([
    ["a cursor it did not mint", "cursor=bm9wZQ"],
    ["a limit of 0", "limit=0"],
    ["a limit over 200", "limit=201"],
    ["a kind that is not one", `kind=${encodeURIComponent("Not A Kind")}`],
    ["from not before to", "from=5&to=5"],
    ["an unknown ticket", "ticket=FRM-99"],
    ["an unknown agent", "agent=ghost"],
  ])("%s is 400", async (_, query) => {
    await refusal(await get(`/projects/shop/timeline?${query}`), 400);
  });
});

describe("GET /projects/:id/timeline/export", () => {
  test("JSONL: an attachment named for the project and day, the pages joined across the page boundary", async () => {
    const all = await pages("/projects/shop/timeline", 200);
    const res = await get("/projects/shop/timeline/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/x-ndjson; charset=utf-8",
    );
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="shop-history-2026-09-22.jsonl"',
    );
    const lines = (await res.text()).split("\n").filter((l) => l !== "");
    expect(lines.length).toBeGreaterThan(500);
    expect(lines.map((l): unknown => JSON.parse(l))).toEqual(all);
  });

  test("CSV: the fixed columns, a row per entry, formulas defused", async () => {
    const all = await pages("/projects/shop/timeline?kind=audit.*", 200);
    const res = await get(
      "/projects/shop/timeline/export?format=csv&kind=audit.*",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="shop-history-2026-09-22.csv"',
    );
    const rows = (await res.text()).split("\r\n").filter((r) => r !== "");
    expect(rows[0]).toBe(TIMELINE_CSV_COLUMNS.map((c) => `"${c}"`).join(","));
    expect(rows.slice(1).map((r) => r.split('","')[3])).toEqual(
      all.map((e) => e.key),
    );
    expect(rows.filter((r) => r.includes("HYPERLINK"))).toEqual([
      expect.stringContaining(`"'=HYPERLINK(1)"`),
    ]);
  });

  test("an unknown project is 404 and a bad filter or format 400, as JSON", async () => {
    await refusal(await get("/projects/nope/timeline/export"), 404);
    await refusal(await get("/projects/shop/timeline/export?format=xlsx"), 400);
    await refusal(
      await get("/projects/shop/timeline/export?ticket=FRM-99"),
      400,
    );
  });

  test("a page failing mid-body cuts the response instead of ending it", async () => {
    await expect(
      get("/projects/shop/timeline/export", cut).then((res) => res.text()),
    ).rejects.toThrow();
  });
});

describe("GET /agents/:id/sessions", () => {
  async function sessions(limit: number): Promise<AgentSessionItem[]> {
    const items: AgentSessionItem[] = [];
    let cursor: string | null = null;
    for (let n = 0; n < 20; n += 1) {
      const res = await get(
        `/agents/shop-builder/sessions?limit=${limit}${cursor === null ? "" : `&cursor=${cursor}`}`,
      );
      expect(res.status).toBe(200);
      const page = AgentSessionsPage.parse(await res.json());
      items.push(...page.items);
      if (page.next_cursor === null) return items;
      cursor = page.next_cursor;
    }
    throw new Error("more than 20 pages");
  }

  test("newest first, a cursor that loses nothing, with what a replay list shows", async () => {
    const all = await sessions(50);
    expect(all.map((s) => s.id)).toEqual(["S-2", "S-4", "S-1", "S-3", "S-0"]);
    expect(await sessions(2)).toEqual(all);
    expect(all[0]).toEqual({
      id: "S-2",
      ticket_id: "ticket-1",
      ticket_key: "FRM-1",
      role: "builder",
      run_class: "fixture_only",
      runner_id: "fixture",
      state: "exited",
      created_at: TIE - 98,
      started_at: TIE,
      ended_at: TIE + 1,
      turns: 2,
      cost_usd: 0.2,
      exit_reason: "ok",
    });
  });

  test("an unknown agent is 404, a bad cursor or limit 400", async () => {
    await refusal(await get("/agents/ghost/sessions"), 404);
    await refusal(
      await get("/agents/shop-builder/sessions?cursor=bm9wZQ"),
      400,
    );
    await refusal(await get("/agents/shop-builder/sessions?limit=0"), 400);
  });
});
