import { FakeClock, systemClock } from "@bayon/core";
import { getHumanRequest, openDb, type Db } from "@bayon/db";
import { insertHumanRequests } from "@bayon/db/api";
import {
  SPINE_SEED,
  listAudit,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import {
  ApiErrorBody,
  InboxItem,
  InboxPage,
  ServerFrame,
  type InboxFrame,
} from "@bayon/proto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { dbStore } from "./db-store.js";
import { startApi, type RunningApi } from "./server.js";
import { WS_TUNING } from "./ws/hub.js";

// /api/v1/inbox and the `inbox` WS topic over HTTP against a temp-file DB (§11.1, §12).

const TOKEN = "e2e-inbox-0123456789abcdef";
const DEADLINE = { timeout: 10_000, interval: 10 };

/** The test's own writes play human_ask; ULIDs of one millisecond have no order, so it ticks. */
const clock = new FakeClock(1_700_000_000_000);
let spine: TempDb;
let apiDb: Db;
let api: RunningApi;

beforeAll(async () => {
  spine = unwrap(await tempDb(clock));
  unwrap(await seedSpine(spine.db, 3));
  unwrap(
    await seedRows(spine.db, {
      tickets: [ticketRow(7, { title: "Pick a store" })],
    }),
  );
  apiDb = unwrap(await openDb({ path: spine.path, clock: systemClock }));
  api = await startApi({
    config: { token: TOKEN, host: "127.0.0.1", port: 0 },
    store: dbStore(apiDb),
    clock: systemClock,
    tuning: { ...WS_TUNING, inboxMs: 20 },
    logger: false,
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
  headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
): Promise<Response> =>
  fetch(`${api.url}${path}`, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function expectError(res: Response, status: number, errorClass: string) {
  expect(res.status).toBe(status);
  expect(ApiErrorBody.parse(await res.json()).error.class).toBe(errorClass);
}

async function ask(question: string, ticket_id?: string): Promise<string> {
  await clock.advance(1);
  const [row] = unwrap(
    await insertHumanRequests(spine.db, [
      {
        session_id: SPINE_SEED.sessionId,
        kind: "decision",
        question,
        options: ["sqlite", "postgres"],
        ...(ticket_id === undefined ? {} : { ticket_id }),
      },
    ]),
  );
  if (row === undefined) throw new Error("the batch opened nothing");
  return row.id;
}

const answer = (id: string, text: unknown) =>
  call("POST", `/inbox/${id}/answer`, { answer: text });

async function inbox(query = ""): Promise<InboxPage> {
  const res = await call("GET", `/inbox${query}`);
  expect(res.status).toBe(200);
  return InboxPage.parse(await res.json());
}

describe("POST /inbox/:id/answer", () => {
  test("answers once: 200 with the trimmed answer, audited with a digest; a second answer is 409", async () => {
    const id = await ask("Which store?", "ticket-7");
    const res = await answer(id, "  Use SQLite  ");
    expect(res.status).toBe(200);
    const item = InboxItem.parse(await res.json());
    expect(item).toMatchObject({
      id,
      status: "answered",
      answer: "Use SQLite",
      answered_by: "operator",
      ticket: { id: "ticket-7", num: 7, title: "Pick a store" },
      // Only a staffing proposal carries one.
      proposal: null,
    });
    expect(item.answered_at).toEqual(expect.any(Number));
    expect(unwrap(await getHumanRequest(spine.db, id)).answer_json).toBe(
      '"Use SQLite"',
    );

    const audited = async () =>
      unwrap(await listAudit(spine.db)).filter((a) => a.target_id === id);
    const rows = await audited();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: "operator",
      action: "rest.inbox_answer",
      target_kind: "human_request",
    });
    const payload = rows[0]?.payload_json ?? "";
    expect(JSON.parse(payload)).toEqual({
      answer_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      bytes: 10,
    });
    expect(payload).not.toContain("SQLite");

    await expectError(await answer(id, "Use Postgres"), 409, "conflict");
    expect(unwrap(await getHumanRequest(spine.db, id)).answer_json).toBe(
      '"Use SQLite"',
    );
    expect(await audited()).toHaveLength(1);
  });

  test("an unknown request is 404; an empty, missing or over-long answer is 400 and leaves it open", async () => {
    await expectError(await answer("no-such-request", "yes"), 404, "not_found");
    const id = await ask("Retry the job?");
    for (const body of [
      { answer: "   " },
      {},
      { answer: "x".repeat(4_001) },
      { answer: "yes", by: "me" },
    ]) {
      await expectError(
        await call("POST", `/inbox/${id}/answer`, body),
        400,
        "validation",
      );
    }
    expect(unwrap(await getHumanRequest(spine.db, id)).status).toBe("open");
  });

  test("both routes need the operator's bearer", async () => {
    expect((await call("GET", "/inbox", undefined, {})).status).toBe(401);
    expect(
      (await call("POST", "/inbox/x/answer", { answer: "y" }, {})).status,
    ).toBe(401);
  });
});

describe("GET /inbox", () => {
  test("open requests first, newest first, with their ticket and session; ?status= keeps one kind", async () => {
    const first = await ask("first", "ticket-7");
    const second = await ask("second");
    const done = await ask("done");
    expect((await answer(done, "ok")).status).toBe(200);
    const mine = [first, second, done];

    const all = await inbox("?limit=100");
    expect(
      all.items.filter((i) => mine.includes(i.id)).map((i) => i.id),
    ).toEqual([second, first, done]);
    const statuses = all.items.map((i) => i.status);
    expect(statuses.indexOf("answered")).toBeGreaterThan(
      statuses.lastIndexOf("open"),
    );
    expect(all.items.find((i) => i.id === first)).toMatchObject({
      status: "open",
      options: ["sqlite", "postgres"],
      answer: null,
      ticket: {
        id: "ticket-7",
        num: 7,
        title: "Pick a store",
        status: "backlog",
      },
      session: {
        id: SPINE_SEED.sessionId,
        agent: SPINE_SEED.agentName,
        role: "builder",
        state: "idle",
      },
    });

    const open = await inbox("?status=open&limit=100");
    expect(open.items.every((i) => i.status === "open")).toBe(true);
    expect(open.items.map((i) => i.id)).toEqual(
      expect.arrayContaining([first, second]),
    );
    const answered = await inbox("?status=answered&limit=100");
    expect(answered.items.every((i) => i.status === "answered")).toBe(true);
    expect(answered.items.map((i) => i.id)).toContain(done);
  });

  test("pages with an opaque cursor; answering between two pages skips no open request", async () => {
    const older = await ask("older");
    const newer = await ask("newer");
    const page1 = await inbox("?status=open&limit=1");
    expect(page1.items.map((i) => i.id)).toEqual([newer]);
    expect(page1.has_more).toBe(true);
    const cursor = encodeURIComponent(page1.next_cursor ?? "");
    expect((await answer(newer, "done")).status).toBe(200);
    const page2 = await inbox(`?status=open&limit=1&cursor=${cursor}`);
    expect(page2.items.map((i) => i.id)).toEqual([older]);
    expect(await inbox("?limit=100")).toMatchObject({
      next_cursor: null,
      has_more: false,
    });
  });

  test("a bad cursor, status or limit is 400", async () => {
    await expectError(
      await call("GET", "/inbox?cursor=not-one-of-ours"),
      400,
      "validation",
    );
    await expectError(
      await call("GET", "/inbox?status=later"),
      400,
      "validation",
    );
    await expectError(await call("GET", "/inbox?limit=0"), 400, "validation");
  });
});

describe("the inbox WS topic", () => {
  test("sends the open requests on subscribe, and a fresh snapshot when one opens or is answered", async () => {
    const frames: InboxFrame[] = [];
    const socket = new WebSocket(api.wsUrl, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    socket.addEventListener("message", (event) => {
      const frame = ServerFrame.parse(JSON.parse(String(event.data)));
      if (frame.type === "inbox") frames.push(frame);
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("ws failed")));
    });
    const latest = () => frames.at(-1)?.data.items.map((i) => i.id) ?? null;
    try {
      socket.send(JSON.stringify({ type: "subscribe", topic: "inbox" }));
      const openNow = (await inbox("?status=open&limit=100")).items.map(
        (i) => i.id,
      );
      await vi.waitFor(() => expect(latest()).toEqual(openNow), DEADLINE);

      const asked = await ask("Deploy on Friday?");
      await vi.waitFor(() => expect(latest()).toContain(asked), DEADLINE);

      expect((await answer(asked, "no")).status).toBe(200);
      await vi.waitFor(() => expect(latest()).toEqual(openNow), DEADLINE);
      const cursors = frames.map((f) => f.cursor);
      expect(cursors).toEqual(cursors.toSorted((a, b) => a - b));
      expect(frames.length).toBeGreaterThanOrEqual(3);
    } finally {
      socket.close();
    }
  });
});
