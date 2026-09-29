import { FakeClock, systemClock } from "@bayon/core";
import { openDb, type Db } from "@bayon/db";
import {
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import {
  ApiErrorBody,
  TicketDetail,
  TicketEventView,
  TicketLinkView,
  TicketView,
  TicketsPage,
} from "@bayon/proto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dbStore } from "../db-store.js";
import { startApi, type RunningApi } from "../server.js";
import { TicketService } from "./ticket-service.js";

// /api/v1/tickets over HTTP against a temp-file DB (§12.1; M1 contracts 2, 3, 8).

const TOKEN = "e2e-tickets-0123456789abcdef";

let spine: TempDb;
let apiDb: Db;
let api: RunningApi;

beforeAll(async () => {
  spine = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  unwrap(await seedSpine(spine.db, 3));
  apiDb = unwrap(await openDb({ path: spine.path, clock: systemClock }));
  api = await startApi({
    config: { token: TOKEN, host: "127.0.0.1", port: 0 },
    store: dbStore(apiDb),
    clock: systemClock,
    logger: false,
    tickets: new TicketService({
      db: apiDb,
      clock: systemClock,
      workRoot: null,
    }),
  });
});

afterAll(async () => {
  await api?.close();
  await apiDb?.close();
  spine?.cleanup();
});

const call = (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> =>
  fetch(`${api.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function expectError(res: Response, status: number, errorClass: string) {
  expect(res.status).toBe(status);
  const body = ApiErrorBody.parse(await res.json());
  expect(body.error.class).toBe(errorClass);
  return body.error;
}

async function create(title: string): Promise<TicketView> {
  const res = await call("POST", "/tickets", { title, type: "chore" });
  expect(res.status).toBe(201);
  return TicketView.parse(await res.json());
}

describe("create and read", () => {
  test("POST is 201 with the ticket and its ETag", async () => {
    const res = await call("POST", "/tickets", {
      title: "Write the README",
      type: "docs",
      complexity_facts: { cosmetic_only: true },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("etag")).toBe('"1"');
    expect(TicketView.parse(await res.json())).toMatchObject({
      key: expect.stringMatching(/^FRM-\d+$/),
      status: "backlog",
      complexity_tier: "cheap",
    });
  });

  test("a bad body is 400, and status is never settable", async () => {
    await expectError(
      await call("POST", "/tickets", { title: "t" }),
      400,
      "validation",
    );
    await expectError(
      await call("POST", "/tickets", {
        title: "t",
        type: "chore",
        status: "done",
      }),
      400,
      "validation",
    );
  });

  test("GET by id or by num is the detail, with the ETag and the transitions", async () => {
    const ticket = await create("detail me");
    const byId = await call("GET", `/tickets/${ticket.id}`);
    expect(byId.status).toBe(200);
    expect(byId.headers.get("etag")).toBe('"1"');
    const detail = TicketDetail.parse(await byId.json());
    expect(detail.ticket.id).toBe(ticket.id);
    expect(detail.transitions).toContainEqual({
      to: "prioritized",
      rule: "prioritize",
      allowed: true,
    });
    const byNum = TicketDetail.parse(
      await (await call("GET", `/tickets/${ticket.num}`)).json(),
    );
    expect(byNum).toEqual(detail);
  });

  test("GET is never cached: its version ETag does not cover the events, gates or next step", async () => {
    const ticket = await create("never cached");
    const res = await call("GET", `/tickets/${ticket.num}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // Still the version: the If-Match a write sends back, not a validator of this body.
    expect(res.headers.get("etag")).toBe('"1"');
  });

  test("a bad ref is 400; an unknown one is 404", async () => {
    await expectError(
      await call("GET", "/tickets/not-a-ref"),
      400,
      "validation",
    );
    await expectError(await call("GET", "/tickets/987654"), 404, "not_found");
  });
});

describe("If-Match (contract 3)", () => {
  test("PATCH needs it: 428 without, 400 malformed, 409 stale, 200 fresh", async () => {
    const ticket = await create("guarded");
    const path = `/tickets/${ticket.id}`;
    const patch = { title: "guarded, edited" };
    await expectError(await call("PATCH", path, patch), 428, "validation");
    for (const bad of ["*", 'W/"1"', "one"]) {
      await expectError(
        await call("PATCH", path, patch, { "if-match": bad }),
        400,
        "validation",
      );
    }
    const fresh = await call("PATCH", path, patch, { "if-match": '"1"' });
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("etag")).toBe('"2"');
    expect(TicketView.parse(await fresh.json()).title).toBe("guarded, edited");
    const stale = await expectError(
      await call("PATCH", path, patch, { "if-match": '"1"' }),
      409,
      "conflict",
    );
    expect(stale.current_version).toBe(2);
  });

  test("status in a PATCH is 400: status moves only by transition", async () => {
    const ticket = await create("not like this");
    await expectError(
      await call(
        "PATCH",
        `/tickets/${ticket.id}`,
        { status: "done" },
        { "if-match": "1" },
      ),
      400,
      "validation",
    );
  });

  test("a transition needs it too", async () => {
    const ticket = await create("moving");
    await expectError(
      await call("POST", `/tickets/${ticket.id}/transition`, {
        to: "prioritized",
      }),
      428,
      "validation",
    );
  });
});

describe("transitions (contract 2)", () => {
  test("an allowed one is 200 with the new ETag, and lands in the events", async () => {
    const ticket = await create("rank me");
    const res = await call(
      "POST",
      `/tickets/${ticket.id}/transition`,
      { to: "prioritized", reason: "top of the list" },
      { "if-match": '"1"' },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('"2"');
    expect(TicketView.parse(await res.json()).status).toBe("prioritized");
    const events = await call("GET", `/tickets/${ticket.id}/events?since=0`);
    const items = TicketEventView.array().parse(
      ((await events.json()) as { items: unknown }).items,
    );
    expect(items.at(-1)).toMatchObject({
      kind: "transition",
      to_status: "prioritized",
      reason: "top of the list",
    });
  });

  test("a refused one is 422 naming the rule, the reason and the detail", async () => {
    const ticket = await create("no shortcuts");
    const refusal = await expectError(
      await call(
        "POST",
        `/tickets/${ticket.id}/transition`,
        { to: "building" },
        { "if-match": "1" },
      ),
      422,
      "law_refused",
    );
    expect(refusal).toMatchObject({
      rule: "no_edge",
      reason: "illegal_transition",
      detail: "backlog → building is not a transition",
    });
  });

  test("blocking without its fields is 400 at the boundary", async () => {
    const ticket = await create("vague");
    await expectError(
      await call(
        "POST",
        `/tickets/${ticket.id}/transition`,
        { to: "blocked" },
        { "if-match": "1" },
      ),
      400,
      "validation",
    );
  });
});

describe("search, comments and links", () => {
  test("q finds a ticket by a title word, and FTS syntax is only text", async () => {
    const ticket = await create("zebra crossing survey");
    const found = TicketsPage.parse(
      await (await call("GET", "/tickets?q=zebra")).json(),
    );
    expect(found.items.map((i) => i.id)).toEqual([ticket.id]);
    const hostile = await call(
      "GET",
      `/tickets?q=${encodeURIComponent('"*NEAR(')}`,
    );
    expect(hostile.status).toBe(200);
    expect(TicketsPage.parse(await hostile.json()).items).toEqual([]);
  });

  test("the list filters by status and pages by num", async () => {
    await create("page one");
    await create("page two");
    const first = TicketsPage.parse(
      await (await call("GET", "/tickets?status=backlog&limit=1")).json(),
    );
    expect(first.has_more).toBe(true);
    const next = TicketsPage.parse(
      await (
        await call(
          "GET",
          `/tickets?status=backlog&limit=1&cursor=${first.next_cursor}`,
        )
      ).json(),
    );
    expect(next.items[0]?.num).toBeGreaterThan(first.items[0]?.num ?? 0);
    await expectError(
      await call("GET", "/tickets?status=nope"),
      400,
      "validation",
    );
  });

  test("a comment and a link are 201", async () => {
    const ticket = await create("annotated");
    const comment = await call("POST", `/tickets/${ticket.id}/comments`, {
      body_md: "looks right",
    });
    expect(comment.status).toBe(201);
    expect(TicketEventView.parse(await comment.json()).kind).toBe("comment");
    const link = await call("POST", `/tickets/${ticket.id}/links`, {
      kind: "pr",
      url: "https://example.com/pull/7",
    });
    expect(link.status).toBe(201);
    expect(TicketLinkView.parse(await link.json()).url).toBe(
      "https://example.com/pull/7",
    );
    await expectError(
      await call("POST", `/tickets/${ticket.id}/links`, { kind: "pr" }),
      400,
      "validation",
    );
  });
});

test("GET /tickets?workspace_id= is one project's tickets, each card naming its project", async () => {
  unwrap(
    await seedRows(apiDb, {
      workspaces: [{ id: "ws-proj", name: "proj", kind: "single" }],
    }),
  );
  const res = await call("POST", "/tickets", {
    title: "in the project",
    type: "chore",
    workspace_id: "ws-proj",
  });
  expect(res.status).toBe(201);
  await create("outside every project");
  const page = TicketsPage.parse(
    await (await call("GET", "/tickets?workspace_id=ws-proj")).json(),
  );
  expect(page.items.map((t) => [t.title, t.workspace_id])).toEqual([
    ["in the project", "ws-proj"],
  ]);
  await expectError(
    await call("GET", "/tickets?workspace_id="),
    400,
    "validation",
  );
});
