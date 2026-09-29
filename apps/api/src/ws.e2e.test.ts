import { FakeClock, systemClock, type FrmError } from "@bayon/core";
import { getEventsSince, openDb, type Db } from "@bayon/db";
import { appendTicketEvent, createTicket } from "@bayon/db/api";
import {
  OPERATOR,
  addSession,
  appendEvents,
  newTicketInput,
  seedSpine,
  tempDb,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import {
  CursorClient,
  ServerFrame,
  type Fleet,
  type SpendSummary,
} from "@bayon/proto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { WebSocket as WsClient } from "ws";
import { dbStore } from "./db-store.js";
import { startApi, type RunningApi } from "./server.js";
import { WS_TUNING } from "./ws/hub.js";

const TOKEN = "e2e-bearer-0123456789abcdef";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const LATEST_SCHEMA = 2;
const DEADLINE = { timeout: 10_000, interval: 10 };
/** Seeded, so a failing disconnect pattern can be replayed. */
const SEED = 20_260_912;

let spine: TempDb;
let apiDb: Db;
let api: RunningApi;

/** The API on its own connection. Small pages, so a batch spans frames and a cut lands mid-stream. */
async function start(port = 0): Promise<RunningApi> {
  apiDb = unwrap(await openDb({ path: spine.path, clock: systemClock }));
  return startApi({
    config: { token: TOKEN, host: "127.0.0.1", port },
    store: dbStore(apiDb),
    clock: systemClock,
    tuning: { ...WS_TUNING, pageLimit: 5 },
    logger: false,
  });
}

async function stop(): Promise<void> {
  await api.close();
  await apiDb.close();
}

// A seeded temp-file DB. The test's connection plays the supervisor's ingest.
beforeAll(async () => {
  spine = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  unwrap(await seedSpine(spine.db, LATEST_SCHEMA));
  api = await start();
});

afterAll(async () => {
  if (api) await stop();
  spine?.cleanup();
});

/** Every stored event id of a session, ascending. */
async function storedIds(sessionId: string): Promise<number[]> {
  const ids: number[] = [];
  let since = 0;
  for (;;) {
    const page = unwrap(
      await getEventsSince(spine.db, { sessionId, since, limit: 1_000 }),
    );
    ids.push(...page.rows.map((row) => row.id));
    since = page.nextCursor;
    if (!page.hasMore) return ids;
  }
}

/** mulberry32: a tiny seeded PRNG. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function handshakeStatus(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WsClient(api.wsUrl, { headers });
    socket.on("unexpected-response", (req, res) => {
      resolve(res.statusCode ?? 0);
      req.destroy();
    });
    socket.on("open", () => {
      socket.close();
      resolve(101);
    });
    socket.on("error", reject);
  });
}

function openSocket(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(api.wsUrl, { headers: AUTH });
    socket.addEventListener("open", () => resolve(socket));
    socket.addEventListener("error", () =>
      reject(new Error("ws failed to open")),
    );
  });
}

function nextFrame(socket: WebSocket): Promise<ServerFrame> {
  return new Promise((resolve) =>
    socket.addEventListener(
      "message",
      (event) => resolve(ServerFrame.parse(JSON.parse(String(event.data)))),
      { once: true },
    ),
  );
}

/** A CursorClient on Node's global WebSocket, always dialling the current API URL. */
function newClient(onSocket: (socket: WebSocket) => void = () => {}) {
  const errors: FrmError[] = [];
  const client = new CursorClient({
    connect: () => {
      const socket = new WebSocket(api.wsUrl, { headers: AUTH });
      onSocket(socket);
      return socket;
    },
    clock: systemClock,
    reconnect: { initialMs: 5, maxMs: 40 },
    onError: (error) => errors.push(error),
  });
  const received: number[] = [];
  const follow = (sessionId: string, since?: number) =>
    client.subscribeEvents(
      sessionId,
      (items) => received.push(...items.map((i) => i.id)),
      since,
    );
  return { client, errors, received, follow };
}

/**
 * The errors a test did not expect. A dropped transport now reports itself — in a test
 * that cuts the connection on purpose that is the designed behaviour, not a failure — so the two
 * disconnect tests assert on this rather than on an empty list, and a validation error or anything
 * non-retryable still fails them.
 */
const unexpected = (errors: readonly FrmError[]): readonly FrmError[] =>
  errors.filter((e) => !(e.retryable && e.message.includes("feed dropped")));

describe("/ws handshake", () => {
  test("needs the bearer", async () => {
    expect(await handshakeStatus({})).toBe(401);
    expect(await handshakeStatus({ authorization: "Bearer wrong" })).toBe(401);
    expect(await handshakeStatus(AUTH)).toBe(101);
  });
});

describe("/ws topics", () => {
  test("an unknown topic is rejected with an error frame", async () => {
    const socket = await openSocket();
    const frame = nextFrame(socket);
    socket.send(
      JSON.stringify({ type: "subscribe", topic: "approvals", since: 4 }),
    );
    expect(await frame).toEqual({
      type: "error",
      topic: "approvals",
      cursor: 4,
      error: {
        class: "validation",
        message: "unknown topic: approvals",
        retryable: false,
      },
    });
    socket.close();
  });

  test("fleet delivers a v_fleet snapshot", async () => {
    const session = "01J0E2EFLEET00000000000001";
    unwrap(await addSession(spine.db, session));
    const { client, errors } = newClient();
    const snapshots: Fleet[] = [];
    client.subscribeFleet((fleet) => snapshots.push(fleet));
    await vi.waitFor(() => {
      expect(snapshots.at(-1)?.sessions.map((s) => s.id)).toContain(session);
    }, DEADLINE);
    client.close();
    expect(errors).toEqual([]);
  });

  test("spend delivers the ledger summary (§8.9)", async () => {
    const { client, errors } = newClient();
    const summaries: SpendSummary[] = [];
    client.subscribeSpend((summary) => summaries.push(summary));
    await vi.waitFor(
      () => expect(summaries.length).toBeGreaterThan(0),
      DEADLINE,
    );
    client.close();
    expect(summaries[0]?.alarm).toMatchObject({
      threshold_pct: 25,
      baseline_days: 30,
    });
    expect(errors).toEqual([]);
  });

  test("tickets replays every ticket's events from since, then goes live (contract 8)", async () => {
    const ticket = unwrap(
      await createTicket(spine.db, newTicketInput({ title: "fed" }), OPERATOR),
    );
    const socket = await openSocket();
    const frames: ServerFrame[] = [];
    socket.addEventListener("message", (event) =>
      frames.push(ServerFrame.parse(JSON.parse(String(event.data)))),
    );
    const items = () =>
      frames.flatMap((f) => (f.type === "ticket_events" ? f.items : []));
    socket.send(
      JSON.stringify({ type: "subscribe", topic: "tickets", since: 0 }),
    );
    await vi.waitFor(
      () =>
        expect(items().map((i) => [i.ticket_id, i.kind])).toContainEqual([
          ticket.id,
          "created",
        ]),
      DEADLINE,
    );
    unwrap(
      await appendTicketEvent(spine.db, {
        ticket_id: ticket.id,
        kind: "comment",
        ...OPERATOR,
        payload: { body_md: "live" },
      }),
    );
    await vi.waitFor(
      () =>
        expect(items().at(-1)).toMatchObject({
          ticket_id: ticket.id,
          kind: "comment",
          payload: { body_md: "live" },
        }),
      DEADLINE,
    );
    socket.close();
  });
});

describe("/ws session events through CursorClient", () => {
  test("replays from since, then goes live", async () => {
    const session = "01J0E2ELIVE000000000000001";
    unwrap(await addSession(spine.db, session));
    const seeded = unwrap(await appendEvents(spine.db, session, 12));
    const { client, errors, received, follow } = newClient();
    follow(session, seeded[3]);
    await vi.waitFor(() => expect(received).toEqual(seeded.slice(4)), DEADLINE);

    const live = unwrap(await appendEvents(spine.db, session, 3));
    await vi.waitFor(
      () => expect(received).toEqual([...seeded.slice(4), ...live]),
      DEADLINE,
    );
    client.close();
    expect(errors).toEqual([]);
  });

  test("random disconnects while a writer inserts lose and repeat nothing", async () => {
    const session = "01J0E2ECHAOS00000000000001";
    unwrap(await addSession(spine.db, session));
    const rng = random(SEED);
    const sockets: WebSocket[] = [];
    const { client, errors, received, follow } = newClient((socket) =>
      sockets.push(socket),
    );
    follow(session);

    const rounds = 15;
    let midStream = 0;
    let liveCuts = 0;
    for (let round = 0; round < rounds; round++) {
      // Every cut hits a live connection: wait for the reconnect first.
      await vi.waitFor(
        () => expect(sockets.at(-1)?.readyState).toBe(WebSocket.OPEN),
        DEADLINE,
      );
      const before = received.length;
      unwrap(await appendEvents(spine.db, session, 6 + Math.floor(rng() * 20)));
      if (rng() < 0.5) {
        // Mid-stream: the first frame of this batch arrived, the rest is in flight.
        await vi.waitFor(
          () => expect(received.length).toBeGreaterThan(before),
          DEADLINE,
        );
        midStream++;
      }
      // Otherwise the cut lands before any of the batch arrived.
      const live = sockets.at(-1);
      if (live?.readyState === WebSocket.OPEN) liveCuts++;
      live?.close();
    }

    const stored = await storedIds(session);
    await vi.waitFor(() => expect(received).toEqual(stored), DEADLINE);
    expect(new Set(received).size).toBe(received.length);
    expect(liveCuts).toBe(rounds);
    expect(midStream).toBeGreaterThan(0);
    expect(midStream).toBeLessThan(rounds);
    client.close();
    expect(unexpected(errors)).toEqual([]);
  }, 60_000);

  test("an API restart mid-stream loses and repeats nothing", async () => {
    const session = "01J0E2ERESTART000000000001";
    unwrap(await addSession(spine.db, session));
    const { client, errors, received, follow } = newClient();
    follow(session);
    unwrap(await appendEvents(spine.db, session, 23));
    await vi.waitFor(
      () => expect(received.length).toBeGreaterThan(0),
      DEADLINE,
    );

    const port = Number(new URL(api.url).port);
    await stop();
    unwrap(await appendEvents(spine.db, session, 17)); // ingest carries on while the API is down
    api = await start(port);
    unwrap(await appendEvents(spine.db, session, 5));

    const stored = await storedIds(session);
    expect(stored).toHaveLength(45);
    await vi.waitFor(() => expect(received).toEqual(stored), DEADLINE);
    client.close();
    expect(unexpected(errors)).toEqual([]);
  }, 30_000);
});
