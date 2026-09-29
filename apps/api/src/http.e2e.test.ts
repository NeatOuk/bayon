import { FakeClock, systemClock } from "@bayon/core";
import { openDb, type Db } from "@bayon/db";
import {
  SPINE_SEED,
  addSession,
  appendEvents,
  listCommands,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import {
  ApiErrorBody,
  BudgetSettings,
  Command,
  CommandAccepted,
  CommandView,
  EventsPage,
  ExportRunAccepted,
  Fleet,
  IDEMPOTENCY_HEADER,
  SessionView,
  SpendReport,
} from "@bayon/proto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dbStore } from "./db-store.js";
import { startApi, type RunningApi } from "./server.js";

const TOKEN = "e2e-bearer-0123456789abcdef";
const LATEST_SCHEMA = 2;
const SESSION = "01J0E2ESESSION000000000001";
/** Its events carry payload files, so SESSION's events stay exactly as seeded. */
const PAYLOAD_SESSION = "01J0E2ESESSION000000000002";
/** Past the 8 KB tool-result cap: the payload route serves all of it. */
const FULL_TEXT = `${"0123456789abcdef".repeat(1_024)}\nend of output`;
const SPAWN = {
  agent_id: SPINE_SEED.agentId,
  role: "build",
  run_class: "build",
};

let spine: TempDb;
let apiDb: Db;
let api: RunningApi;
let seededIds: readonly number[];
let runtime = "";
let payloadIds: Readonly<
  Record<"full" | "missing" | "escape" | "absolute" | "symlink", number>
>;

async function payloadEvent(payloadPath: string): Promise<number> {
  const [id] = unwrap(
    await appendEvents(spine.db, PAYLOAD_SESSION, 1, {
      payload_path: payloadPath,
      bytes_original: FULL_TEXT.length,
      truncated: 1,
    }),
  );
  if (id === undefined) throw new Error("no event was appended");
  return id;
}

// A seeded temp-file DB. The test's connection plays the supervisor; the API opens its own.
beforeAll(async () => {
  spine = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  unwrap(await seedSpine(spine.db, LATEST_SCHEMA));
  unwrap(await addSession(spine.db, SESSION));
  seededIds = unwrap(await appendEvents(spine.db, SESSION, 5));

  runtime = mkdtempSync(join(tmpdir(), "bayon-runtime-"));
  const tool = join(runtime, "sessions", PAYLOAD_SESSION, "logs", "tool");
  mkdirSync(tool, { recursive: true });
  writeFileSync(join(tool, "c1.txt"), FULL_TEXT);
  writeFileSync(join(runtime, "secret.txt"), "outside the session");
  symlinkSync(join(runtime, "secret.txt"), join(tool, "link.txt"));
  unwrap(await addSession(spine.db, PAYLOAD_SESSION));
  payloadIds = {
    full: await payloadEvent("logs/tool/c1.txt"),
    missing: await payloadEvent("logs/tool/gone.txt"),
    escape: await payloadEvent("../../secret.txt"),
    absolute: await payloadEvent(join(runtime, "secret.txt")),
    symlink: await payloadEvent("logs/tool/link.txt"),
  };

  apiDb = unwrap(await openDb({ path: spine.path, clock: systemClock }));
  api = await startApi({
    config: { token: TOKEN, host: "127.0.0.1", port: 0 },
    store: dbStore(apiDb),
    clock: systemClock,
    runtimeDir: runtime,
    logger: false,
  });
});

afterAll(async () => {
  await api?.close();
  await apiDb?.close();
  spine?.cleanup();
  if (runtime !== "") rmSync(runtime, { recursive: true, force: true });
});

interface CallOptions {
  readonly method?: "GET" | "POST" | "PUT";
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** null sends no Authorization header. */
  readonly bearer?: string | null;
}

function call(path: string, options: CallOptions = {}): Promise<Response> {
  const bearer = options.bearer === undefined ? TOKEN : options.bearer;
  const body =
    options.body === undefined || typeof options.body === "string"
      ? options.body
      : JSON.stringify(options.body);
  return fetch(`${api.url}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
      ...options.headers,
    },
    body,
  });
}

async function expectError(res: Response, status: number, errorClass: string) {
  expect(res.status).toBe(status);
  const body = ApiErrorBody.parse(await res.json());
  expect(body.error.class).toBe(errorClass);
  return body.error;
}

const spawn = (body: unknown, key?: string) =>
  call("/sessions", {
    method: "POST",
    body,
    headers: key === undefined ? {} : { [IDEMPOTENCY_HEADER]: key },
  });

const commands = async () => unwrap(await listCommands(spine.db));
const commandCount = async () => (await commands()).length;

/** The stored command's type and parsed payload. */
async function storedCommand(id: string) {
  const row = (await commands()).find((c) => c.id === id);
  if (!row) throw new Error(`no command ${id}`);
  const payload: unknown = JSON.parse(row.payload_json);
  return { type: row.type, payload };
}

describe("auth", () => {
  test("GET /health needs no bearer", async () => {
    const res = await call("/health", { bearer: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("every other route needs the bearer", async () => {
    await expectError(
      await call("/fleet", { bearer: null }),
      401,
      "validation",
    );
    await expectError(
      await call("/fleet", { bearer: "wrong" }),
      401,
      "validation",
    );
    await expectError(
      await call("/fleet", {
        bearer: null,
        headers: { authorization: `Basic ${TOKEN}` },
      }),
      401,
      "validation",
    );
    const before = await commandCount();
    await expectError(
      await call("/sessions", { method: "POST", bearer: null, body: SPAWN }),
      401,
      "validation",
    );
    expect(await commandCount()).toBe(before);
  });

  test("an unknown route is not_found", async () => {
    await expectError(await call("/nope"), 404, "not_found");
  });
});

describe("reads", () => {
  test("GET /fleet lists live sessions from v_fleet", async () => {
    const res = await call("/fleet");
    expect(res.status).toBe(200);
    const fleet = Fleet.parse(await res.json());
    expect(fleet.sessions.find((s) => s.id === SESSION)).toMatchObject({
      agent: SPINE_SEED.agentName,
      state: "pending",
      runner_id: SPINE_SEED.runnerId,
      executor_id: SPINE_SEED.executorId,
    });
  });

  test("GET /sessions/:id returns the session, or not_found", async () => {
    const res = await call(`/sessions/${SESSION}`);
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(SessionView.parse(body)).toMatchObject({
      id: SESSION,
      agent_id: SPINE_SEED.agentId,
      agent_name: SPINE_SEED.agentName,
      state: "pending",
    });
    expect(body).not.toHaveProperty("mcp_token_hash");
    await expectError(await call("/sessions/NOPE"), 404, "not_found");
  });

  test("GET /sessions/:id/events pages by since and limit without gaps or repeats", async () => {
    const seen: number[] = [];
    let since = 0;
    for (let page = 0; page < 10; page++) {
      const res = await call(
        `/sessions/${SESSION}/events?since=${since}&limit=2`,
      );
      expect(res.status).toBe(200);
      const body = EventsPage.parse(await res.json());
      seen.push(...body.items.map((i) => i.id));
      since = body.next_cursor;
      if (!body.has_more) break;
    }
    expect(seen).toEqual(seededIds);
  });

  test("kind filters; a bad query is a validation error", async () => {
    const tools = EventsPage.parse(
      await (
        await call(`/sessions/${SESSION}/events?kind=tool_call,error`)
      ).json(),
    );
    expect(tools.items).toEqual([]);
    const text = EventsPage.parse(
      await (
        await call(`/sessions/${SESSION}/events?kind=assistant_text`)
      ).json(),
    );
    expect(text.items.map((i) => i.id)).toEqual(seededIds);
    expect(text.items[0]).toMatchObject({
      kind: "assistant_text",
      runner_type: "text",
    });
    await expectError(
      await call(`/sessions/${SESSION}/events?kind=bogus`),
      400,
      "validation",
    );
    await expectError(
      await call(`/sessions/${SESSION}/events?limit=5000`),
      400,
      "validation",
    );
    await expectError(
      await call(`/sessions/${SESSION}/events?since=-3`),
      400,
      "validation",
    );
  });
});

describe("fleet overview", () => {
  test("GET /fleet carries today's budget, slots per executor and attention", async () => {
    const fleet = Fleet.parse(await (await call("/fleet")).json());
    const local = SPINE_SEED.executorId;
    expect(fleet.budget).toEqual({ today_usd: 0, daily_cap_usd: null });
    expect(fleet.slots).toEqual([
      {
        executor_id: local,
        busy: fleet.sessions.filter((s) => s.executor_id === local).length,
        capacity: 4,
      },
    ]);
    // No session is running or idle with an old event, and none has exited.
    expect(fleet.attention).toEqual([]);
  });
});

describe("GET/PUT /settings/budget", () => {
  const budget = (method: "GET" | "PUT", body?: unknown) =>
    call("/settings/budget", { method, body });

  test("GET starts at the seeded null cap", async () => {
    const res = await budget("GET");
    expect(res.status).toBe(200);
    expect(BudgetSettings.parse(await res.json())).toEqual({
      daily_cap_usd: null,
    });
  });

  test("PUT sets a cap, and the next GET /fleet reflects it", async () => {
    const res = await budget("PUT", { daily_cap_usd: 40 });
    expect(res.status).toBe(200);
    expect(BudgetSettings.parse(await res.json())).toEqual({
      daily_cap_usd: 40,
    });
    const fleet = Fleet.parse(await (await call("/fleet")).json());
    expect(fleet.budget.daily_cap_usd).toBe(40);
  });

  test("PUT null clears the cap", async () => {
    await budget("PUT", { daily_cap_usd: 40 });
    const res = await budget("PUT", { daily_cap_usd: null });
    expect(res.status).toBe(200);
    expect(BudgetSettings.parse(await res.json())).toEqual({
      daily_cap_usd: null,
    });
    const fleet = Fleet.parse(await (await call("/fleet")).json());
    expect(fleet.budget.daily_cap_usd).toBeNull();
  });

  test("needs the bearer, on both routes", async () => {
    await expectError(
      await call("/settings/budget", { bearer: null }),
      401,
      "validation",
    );
    await expectError(
      await call("/settings/budget", {
        method: "PUT",
        body: { daily_cap_usd: 10 },
        bearer: null,
      }),
      401,
      "validation",
    );
  });

  test.each([
    ["a negative cap", { daily_cap_usd: -1 }],
    // JSON has no NaN token; a wire-level "NaN" is invalid JSON, same as malformed JSON.
    ["NaN", '{"daily_cap_usd": NaN}'],
    ["a string", { daily_cap_usd: "40" }],
    ["a missing field", {}],
    ["malformed JSON", "{not json"],
  ])("PUT rejects %s and leaves the cap unchanged", async (_name, body) => {
    await budget("PUT", { daily_cap_usd: 5 }); // a known baseline
    await expectError(await budget("PUT", body), 400, "validation");
    const res = await budget("GET");
    expect(BudgetSettings.parse(await res.json())).toEqual({
      daily_cap_usd: 5,
    });
  });
});

describe("GET /sessions/:id/events/:eventId/payload", () => {
  const payload = (eventId: number, session = PAYLOAD_SESSION) =>
    `/sessions/${session}/events/${eventId}/payload`;

  test("streams the whole file as text, past the 8 KB cap", async () => {
    const res = await call(payload(payloadIds.full));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(8 * 1024);
    expect(text).toBe(FULL_TEXT);
  });

  test("needs the bearer", async () => {
    await expectError(
      await call(payload(payloadIds.full), { bearer: null }),
      401,
      "validation",
    );
  });

  test.each([
    ["a relative escape", "escape"],
    ["an absolute path", "absolute"],
    ["a symlink", "symlink"],
  ] as const)("refuses %s out of the session directory", async (_name, key) => {
    const error = await expectError(
      await call(payload(payloadIds[key])),
      400,
      "validation",
    );
    expect(error.message).not.toContain(runtime);
  });

  test("a missing file is not_found", async () => {
    await expectError(
      await call(payload(payloadIds.missing)),
      404,
      "not_found",
    );
  });

  test("an unknown event, another session's event or one without a payload is not_found", async () => {
    await expectError(await call(payload(999_999)), 404, "not_found");
    await expectError(
      await call(payload(payloadIds.full, SESSION)),
      404,
      "not_found",
    );
    await expectError(
      await call(payload(seededIds[0] ?? 0, SESSION)),
      404,
      "not_found",
    );
  });

  test("a bad event id is a validation error", async () => {
    await expectError(
      await call(`/sessions/${PAYLOAD_SESSION}/events/abc/payload`),
      400,
      "validation",
    );
  });
});

describe("POST /sessions", () => {
  test("inserts exactly one session.spawn command and spawns nothing", async () => {
    const before = await commandCount();
    const res = await spawn({ ...SPAWN, prompt: "Fix the README typo." });
    expect(res.status).toBe(202);
    const accepted = CommandAccepted.parse(await res.json());
    expect(accepted.created).toBe(true);
    expect(await commandCount()).toBe(before + 1);
    expect(Command.parse(await storedCommand(accepted.command_id))).toEqual({
      type: "session.spawn",
      payload: {
        ...SPAWN,
        prompt: "Fix the README typo.",
        session_id: accepted.session_id,
      },
    });
    // The supervisor creates the session when it claims the command; the API never does.
    await expectError(
      await call(`/sessions/${accepted.session_id}`),
      404,
      "not_found",
    );
  });

  test("is idempotent under a repeated Idempotency-Key", async () => {
    const before = await commandCount();
    const first = CommandAccepted.parse(
      await (await spawn(SPAWN, "spawn-key-1")).json(),
    );
    const again = await spawn(SPAWN, "spawn-key-1");
    expect(again.status).toBe(202);
    expect(CommandAccepted.parse(await again.json())).toEqual({
      ...first,
      created: false,
    });
    expect(first.created).toBe(true);
    expect(await commandCount()).toBe(before + 1);
  });

  test("the same key for a different request is a conflict", async () => {
    await spawn(SPAWN, "spawn-key-2");
    const before = await commandCount();
    await expectError(
      await spawn({ ...SPAWN, role: "review" }, "spawn-key-2"),
      409,
      "conflict",
    );
    expect(await commandCount()).toBe(before);
  });

  test("a bad body or key is a validation error and inserts nothing", async () => {
    const before = await commandCount();
    for (const body of [
      { role: "build", run_class: "build" },
      { ...SPAWN, runclass: "typo" },
      { ...SPAWN, session_id: "chosen-by-client" },
      "{not json",
    ]) {
      await expectError(await spawn(body), 400, "validation");
    }
    await expectError(await spawn(SPAWN, "k".repeat(256)), 400, "validation");
    expect(await commandCount()).toBe(before);
  });
});

describe("POST /exports/run", () => {
  const exportsRun = (key?: string) =>
    call("/exports/run", {
      method: "POST",
      headers: key === undefined ? {} : { [IDEMPOTENCY_HEADER]: key },
    });

  test("inserts exactly one export.run command with an empty payload", async () => {
    const before = await commandCount();
    const res = await exportsRun();
    expect(res.status).toBe(202);
    const raw = await res.json();
    expect(raw).not.toHaveProperty("session_id");
    const accepted = ExportRunAccepted.parse(raw);
    expect(accepted.created).toBe(true);
    expect(await commandCount()).toBe(before + 1);
    expect(await storedCommand(accepted.command_id)).toEqual({
      type: "export.run",
      payload: {},
    });
  });

  test("is idempotent under a repeated Idempotency-Key", async () => {
    const before = await commandCount();
    const first = ExportRunAccepted.parse(
      await (await exportsRun("export-key-1")).json(),
    );
    const again = await exportsRun("export-key-1");
    expect(again.status).toBe(202);
    expect(ExportRunAccepted.parse(await again.json())).toEqual({
      ...first,
      created: false,
    });
    expect(first.created).toBe(true);
    expect(await commandCount()).toBe(before + 1);
  });
});

describe("interrupt and stop", () => {
  test("interrupt inserts one session.interrupt command", async () => {
    const res = await call(`/sessions/${SESSION}/interrupt`, {
      method: "POST",
    });
    expect(res.status).toBe(202);
    const accepted = CommandAccepted.parse(await res.json());
    expect(accepted).toMatchObject({ session_id: SESSION, created: true });
    expect(await storedCommand(accepted.command_id)).toEqual({
      type: "session.interrupt",
      payload: { session_id: SESSION },
    });
  });

  test("stop defaults to graceful, takes kill, and dedupes on its key", async () => {
    const stop = (body?: unknown, key?: string) =>
      call(`/sessions/${SESSION}/stop`, {
        method: "POST",
        body,
        headers: key === undefined ? {} : { [IDEMPOTENCY_HEADER]: key },
      }).then(async (res) => CommandAccepted.parse(await res.json()));
    const graceful = await stop();
    const killed = await stop({ mode: "kill" }, "stop-key");
    const again = await stop({ mode: "kill" }, "stop-key");
    expect(await storedCommand(graceful.command_id)).toEqual({
      type: "session.stop",
      payload: { session_id: SESSION, mode: "graceful" },
    });
    expect(await storedCommand(killed.command_id)).toEqual({
      type: "session.stop",
      payload: { session_id: SESSION, mode: "kill" },
    });
    expect(again).toEqual({ ...killed, created: false });
    await expectError(
      await call(`/sessions/${SESSION}/stop`, {
        method: "POST",
        body: { mode: "soft" },
      }),
      400,
      "validation",
    );
  });

  test("an unknown session is not_found and inserts nothing", async () => {
    const before = await commandCount();
    await expectError(
      await call("/sessions/NOPE/interrupt", { method: "POST" }),
      404,
      "not_found",
    );
    await expectError(
      await call("/sessions/NOPE/stop", { method: "POST" }),
      404,
      "not_found",
    );
    expect(await commandCount()).toBe(before);
  });
});

describe("GET /commands/:id", () => {
  test("returns the command, or not_found", async () => {
    const accepted = CommandAccepted.parse(await (await spawn(SPAWN)).json());
    const res = await call(`/commands/${accepted.command_id}`);
    expect(res.status).toBe(200);
    expect(CommandView.parse(await res.json())).toMatchObject({
      id: accepted.command_id,
      type: "session.spawn",
      payload: { session_id: accepted.session_id },
      state: "pending",
      attempts: 0,
      result: null,
      error: null,
    });
    await expectError(await call("/commands/NOPE"), 404, "not_found");
  });

  test("it carries the server's clock and the unsettled commands of its type queued before it", async () => {
    // without these a run waiting behind another looks exactly like a wedged one.
    // `ahead` is what the claimer takes first — its order, (ts, id), not the order the two POSTs
    // arrived in. Two commands minted in the same millisecond are ordered by id alone, and ids
    // are ULIDs a stateless mint hands out (core id.ts), so arrival order is not id order about
    // half the time. Which one is the head is therefore read off the rows, never assumed.
    const one = CommandAccepted.parse(await (await spawn(SPAWN)).json());
    const two = CommandAccepted.parse(await (await spawn(SPAWN)).json());
    const viewOf = async (id: string): Promise<CommandView> =>
      CommandView.parse(await (await call(`/commands/${id}`)).json());
    const [a, b] = [await viewOf(one.command_id), await viewOf(two.command_id)];
    const claimedFirst = (l: CommandView, r: CommandView): boolean =>
      l.ts === r.ts ? l.id < r.id : l.ts < r.ts;
    const [head, behind] = claimedFirst(a, b) ? [a, b] : [b, a];
    expect(head.now).toBeGreaterThanOrEqual(head.ts);
    expect(behind.now).toBeGreaterThanOrEqual(behind.ts);
    // The one the claimer takes second is behind the first, and the first is behind nothing.
    expect(behind.ahead.map((c) => c.id)).toContain(head.id);
    expect(behind.ahead.every((c) => c.state === "pending")).toBe(true);
    expect(head.ahead.map((c) => c.id)).not.toContain(behind.id);
  });
});

describe("GET /spend (§8.9)", () => {
  // Two days back on the API's wall clock: inside the window, outside today's Fleet budget.
  const WHEN = Date.now() - 2 * 24 * 60 * 60_000;
  const RUN = "01J0E2ESPENDRUN00000000001";
  const HASH = "0".repeat(64);

  beforeAll(async () => {
    unwrap(
      await seedRows(spine.db, {
        runs: [
          {
            id: RUN,
            session_id: SPINE_SEED.sessionId,
            seq: 900,
            trigger: "operator",
            prompt_path: "/tmp/spend-e2e.md",
            prompt_hash: HASH,
            context_hash: HASH,
            state: "failed",
            started_at: WHEN,
          },
        ],
        spend: [
          {
            id: "01J0E2ESPENDROW00000000001",
            run_id: RUN,
            session_id: SPINE_SEED.sessionId,
            phase: "build",
            runner_id: SPINE_SEED.runnerId,
            model: "model-e2e",
            tokens_in: 7,
            cost_usd: 0.25,
            cost_source: "reported",
            wasted: 1,
            ts: WHEN,
          },
        ],
      }),
    );
  });

  const report = async (query: string) => {
    const res = await call(`/spend${query}`);
    expect(res.status).toBe(200);
    return SpendReport.parse(await res.json());
  };

  test("defaults to group=day: the summary and the window's 30 days", async () => {
    const r = await report("");
    expect(r.group).toBe("day");
    expect(r.rows).toHaveLength(30);
    expect(r.summary).toMatchObject({
      total_usd: 0.25,
      wasted_usd: 0.25,
      waste_pct: 100,
      alarm: { threshold_pct: 25, baseline_days: 30 },
    });
  });

  test("group=class: tokens and waste by run class", async () => {
    const r = await report("?group=class");
    expect(r.group).toBe("class");
    expect(r.rows).toEqual([
      {
        run_class: "build",
        runs: 1,
        tokens_in: 7,
        tokens_out: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        tokens_saved: 0,
        cost_usd: 0.25,
        wasted_usd: 0.25,
      },
    ]);
  });

  test("group=ticket and group=tier answer, empty without tickets", async () => {
    expect(await report("?group=ticket")).toMatchObject({
      group: "ticket",
      rows: [],
    });
    expect(await report("?group=tier")).toMatchObject({
      group: "tier",
      rows: [],
    });
  });

  test("an unknown group is a 400, and the route needs the bearer", async () => {
    await expectError(await call("/spend?group=model"), 400, "validation");
    await expectError(
      await call("/spend", { bearer: null }),
      401,
      "validation",
    );
  });
});
