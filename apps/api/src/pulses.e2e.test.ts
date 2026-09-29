// /api/v1/pulses, /agents/:id/pulse-policy, /tickets/:id/staff and the `pulses` WS topic over HTTP
// against a temp-file DB. The test's own connection plays the supervisor.
import { FakeClock, cronAt, systemClock } from "@bayon/core";
import { getTicket, openDb, type Db } from "@bayon/db";
import {
  SPINE_SEED,
  listAudit,
  listCommands,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import {
  AgentPulsesPage,
  ApiErrorBody,
  CommandView,
  PulseDetail,
  PulsePolicy,
  PulseRunAccepted,
  PulsesPage,
  ServerFrame,
  StaffAccepted,
  type PulsesFrame,
} from "@bayon/proto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { dbStore } from "./db-store.js";
import { startApi, type RunningApi } from "./server.js";
import { TicketService } from "./tickets/ticket-service.js";
import { WS_TUNING } from "./ws/hub.js";

const TOKEN = "e2e-pulses-0123456789abcdef";
const AUTH = { authorization: `Bearer ${TOKEN}` };

let spine: TempDb;
let apiDb: Db;
let api: RunningApi;

const pulse = (
  id: string,
  agent_id: string,
  scheduled_at: number,
  o: Record<string, unknown> = {},
) => ({
  id,
  agent_id,
  trigger: "cron" as const,
  scheduled_at,
  state: "done" as const,
  ...o,
});

beforeAll(async () => {
  spine = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  unwrap(await seedSpine(spine.db, 4));
  const agent = (id: string, kind: "orchestrator" | "builder") => ({
    id,
    name: id,
    kind,
    runner_id: SPINE_SEED.runnerId,
    executor_id: SPINE_SEED.executorId,
    created_at: 0,
  });
  unwrap(
    await seedRows(spine.db, {
      agents: [
        agent("A-O", "orchestrator"),
        agent("A-O2", "orchestrator"),
        agent("B-1", "builder"),
      ],
      tickets: [
        ticketRow(1, { status: "prioritized" }),
        ticketRow(2),
        ticketRow(3, { status: "prioritized" }),
        ticketRow(4, { status: "prioritized" }),
      ],
      pulses: [
        pulse("P-0", "A-O", 10, {
          summary_md: "Staffed one.",
          actions_json: '["staffed #1"]',
          cost_usd: 0.1,
          started_at: 10,
          ended_at: 11,
        }),
        pulse("P-X", "A-O2", 15, {
          state: "skipped",
          skip_reason: "nothing_to_do",
        }),
        pulse("P-1", "A-O", 20, {
          state: "running",
          lease_token: "L-1",
          lease_expires_at: Number.MAX_SAFE_INTEGER,
          started_at: 20,
        }),
      ],
      pulse_checks: [
        {
          id: "C-1",
          pulse_id: "P-0",
          name: "stale_sessions",
          state: "ok",
          duration_ms: 3,
          result_json: '{"rows":[]}',
        },
        {
          id: "C-2",
          pulse_id: "P-0",
          name: "log_scan",
          state: "error",
          error: "boom",
        },
      ],
    }),
  );
  apiDb = unwrap(await openDb({ path: spine.path, clock: systemClock }));
  api = await startApi({
    config: { token: TOKEN, host: "127.0.0.1", port: 0 },
    store: dbStore(apiDb),
    clock: systemClock,
    tuning: { ...WS_TUNING, fleetMs: 50 },
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
      ...AUTH,
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

const ids = async (res: Response) => {
  expect(res.status).toBe(200);
  return PulsesPage.parse(await res.json()).items.map((p) => p.id);
};

describe("GET /pulses and /pulses/:id", () => {
  test("newest first, filtered by agent, limited", async () => {
    expect(await ids(await call("GET", "/pulses"))).toEqual([
      "P-1",
      "P-X",
      "P-0",
    ]);
    expect(await ids(await call("GET", "/pulses?agent=A-O"))).toEqual([
      "P-1",
      "P-0",
    ]);
    expect(await ids(await call("GET", "/pulses?limit=1"))).toEqual(["P-1"]);
    await expectError(await call("GET", "/pulses?limit=0"), 400, "validation");
  });

  test("a pulse's actions are parsed, and its detail carries its checks in order", async () => {
    const res = await call("GET", "/pulses/P-0");
    expect(res.status).toBe(200);
    expect(PulseDetail.parse(await res.json())).toMatchObject({
      id: "P-0",
      summary_md: "Staffed one.",
      actions: ["staffed #1"],
      checks: [
        {
          id: "C-1",
          name: "stale_sessions",
          state: "ok",
          result: { rows: [] },
        },
        { id: "C-2", state: "error", error: "boom", result: null },
      ],
    });
    await expectError(await call("GET", "/pulses/nope"), 404, "not_found");
  });
});

describe("POST /pulses/run-now", () => {
  test("202 with the pulse.run command; a repeated Idempotency-Key answers with the first", async () => {
    const res = await call("POST", "/pulses/run-now", { agent_id: "A-O" });
    expect(res.status).toBe(202);
    const accepted = PulseRunAccepted.parse(await res.json());
    expect(accepted.created).toBe(true);
    const command = CommandView.parse(
      await (await call("GET", `/commands/${accepted.command_id}`)).json(),
    );
    expect(command).toMatchObject({
      type: "pulse.run",
      payload: { agent_id: "A-O" },
      state: "pending",
    });
    const key = { "Idempotency-Key": "run-now-1" };
    const once = PulseRunAccepted.parse(
      await (
        await call("POST", "/pulses/run-now", { agent_id: "A-O" }, key)
      ).json(),
    );
    const twice = PulseRunAccepted.parse(
      await (
        await call("POST", "/pulses/run-now", { agent_id: "A-O" }, key)
      ).json(),
    );
    expect(twice).toEqual({ command_id: once.command_id, created: false });
  });

  test("only an orchestrator pulses; an unknown agent is 404; a bad body is 400", async () => {
    await expectError(
      await call("POST", "/pulses/run-now", { agent_id: "B-1" }),
      400,
      "validation",
    );
    await expectError(
      await call("POST", "/pulses/run-now", { agent_id: "nope" }),
      404,
      "not_found",
    );
    await expectError(
      await call("POST", "/pulses/run-now", {}),
      400,
      "validation",
    );
  });
});

describe("GET /agents/pulse-policies", () => {
  test("every enabled orchestrator, its policy and next scheduled pulse; a builder is not listed", async () => {
    const res = await call("GET", "/agents/pulse-policies");
    expect(res.status).toBe(200);
    const { items } = AgentPulsesPage.parse(await res.json());
    const seeded = {
      mode: "hybrid",
      interval_ms: 5_400_000,
      debounce_ms: 60_000,
      min_gap_ms: 300_000,
      max_per_hour: 8,
      jitter_pct: 5,
    } as const;
    // The seeded pulses are decades old: never rate capped, so the wake is the cron one.
    const cron = (lastAt: number, lastSeed: string, lastRanAt: number | null) =>
      cronAt(
        {
          mode: seeded.mode,
          intervalMs: seeded.interval_ms,
          debounceMs: seeded.debounce_ms,
          minGapMs: seeded.min_gap_ms,
          maxPerHour: seeded.max_per_hour,
          jitterPct: seeded.jitter_pct,
          createdAt: 0,
        },
        { lastAt, lastSeed, lastRanAt, ranAts: [] },
      );
    expect(items).toEqual([
      {
        agent_id: "A-O",
        name: "A-O",
        ...seeded,
        next_pulse_at: cron(20, "P-1", 20),
      },
      {
        agent_id: "A-O2",
        name: "A-O2",
        ...seeded,
        next_pulse_at: cron(15, "P-X", null),
      },
    ]);
  });
});

describe("PATCH /agents/:id/pulse-policy", () => {
  test("sets the given fields, keeps the rest, and audits the change as the operator's", async () => {
    const res = await call("PATCH", "/agents/A-O/pulse-policy", {
      mode: "on_idle",
      debounce_ms: 30_000,
    });
    expect(res.status).toBe(200);
    expect(PulsePolicy.parse(await res.json())).toEqual({
      agent_id: "A-O",
      mode: "on_idle",
      interval_ms: 5_400_000,
      debounce_ms: 30_000,
      min_gap_ms: 300_000,
      max_per_hour: 8,
      jitter_pct: 5,
    });
    expect(unwrap(await listAudit(spine.db)).at(-1)).toMatchObject({
      actor: "operator",
      action: "rest.pulse_policy",
      target_kind: "agent",
      target_id: "A-O",
      payload_json: JSON.stringify({ mode: "on_idle", debounce_ms: 30_000 }),
    });
  });

  test("an empty body, an out-of-range value or an unknown key is 400; an unknown agent 404", async () => {
    for (const bad of [
      {},
      { interval_ms: 10 },
      { max_per_hour: 0 },
      { mode: "sometimes" },
      { jitter_pct: 5, extra: 1 },
    ]) {
      await expectError(
        await call("PATCH", "/agents/A-O/pulse-policy", bad),
        400,
        "validation",
      );
    }
    await expectError(
      await call("PATCH", "/agents/nope/pulse-policy", { mode: "manual" }),
      404,
      "not_found",
    );
  });
});

describe("POST /tickets/:ref/staff (the operator's ticket_staff)", () => {
  test("202 with the queued spawn; staffing it again is a 409 while that spawn is queued", async () => {
    const res = await call("POST", "/tickets/1/staff", { role: "builder" });
    expect(res.status).toBe(202);
    expect(StaffAccepted.parse(await res.json())).toMatchObject({
      created: true,
      agent_id: "B-1",
      role: "builder",
      run_class: "spike",
      handoff_id: null,
      ticket_status: "staffed",
    });
    const busy = await expectError(
      await call("POST", "/tickets/1/staff", { role: "builder" }),
      409,
      "conflict",
    );
    expect(busy.message).toMatch(/^not_staffable: /);
    await expectError(
      await call("POST", "/tickets/2/staff", { role: "builder" }),
      409,
      "conflict",
    );
    await expectError(
      await call("POST", "/tickets/2/staff", { role: "orchestrator" }),
      400,
      "validation",
    );
  });

  test("over the daily cap is 429 over_budget; a repeated Idempotency-Key is the same command", async () => {
    const cap = (usd: number | null) =>
      call("PUT", "/settings/budget", { daily_cap_usd: usd });
    expect((await cap(0)).status).toBe(200);
    const over = await expectError(
      await call("POST", "/tickets/3/staff", { role: "builder" }),
      429,
      "admission_refused",
    );
    expect(over.message).toMatch(/^over_budget: /);
    expect((await cap(null)).status).toBe(200);
    // B-1 holds ticket 1's queued spawn: free it by giving the builder a second slot.
    expect((await call("GET", "/tickets/3")).status).toBe(200);
    const key = { "Idempotency-Key": "staff-3" };
    const none = await expectError(
      await call("POST", "/tickets/3/staff", { role: "builder" }, key),
      429,
      "admission_refused",
    );
    expect(none.message).toMatch(/^no_agent: /);
    unwrap(
      await seedRows(spine.db, {
        agents: [
          {
            id: "B-2",
            name: "B-2",
            kind: "builder",
            runner_id: SPINE_SEED.runnerId,
            executor_id: SPINE_SEED.executorId,
            created_at: 1,
          },
        ],
      }),
    );
    const once = StaffAccepted.parse(
      await (
        await call("POST", "/tickets/3/staff", { role: "builder" }, key)
      ).json(),
    );
    const twice = StaffAccepted.parse(
      await (
        await call("POST", "/tickets/3/staff", { role: "builder" }, key)
      ).json(),
    );
    expect(once).toMatchObject({ created: true, agent_id: "B-2" });
    expect(twice).toEqual({ ...once, created: false });
  });

  // the operator's door meets the same stale holder the orchestrator's does, and the
  // release it queues can kill a wedged session — so this is the one refusal that must leave a
  // record of who asked for it. `commands` carries no actor column; the audit row is all there is.
  test("a stale holder is released with a retryable 409, and the REST caller is audited", async () => {
    const silent = Date.now() - 1_800_000;
    unwrap(
      await seedRows(spine.db, {
        tickets: [ticketRow(5, { status: "building" })],
        sessions: [
          {
            ...newSessionInput(),
            id: "S-HUNG",
            ticket_id: "ticket-5",
            state: "running",
            last_event_at: silent,
            created_at: 0,
          },
        ],
      }),
    );
    const refused = await expectError(
      await call("POST", "/tickets/5/staff", { role: "builder" }),
      409,
      "conflict",
    );
    expect(refused.message).toMatch(/^holder_releasing: /);
    // Retryable, unlike every other 409 here: the hand-off it queued is what makes the next call
    // land, so a client is right to come back.
    expect(refused.retryable).toBe(true);

    const release = unwrap(await listCommands(spine.db)).find(
      (c) => c.type === "session.handoff",
    );
    expect(JSON.parse(release?.payload_json ?? "")).toEqual({
      reason: "stale_session",
      session_id: "S-HUNG",
    });
    expect(unwrap(await listAudit(spine.db)).at(-1)).toMatchObject({
      actor: "operator",
      action: "rest.ticket_staff",
      target_kind: "ticket",
      target_id: "ticket-5",
      payload_json: JSON.stringify({ role: "builder" }),
    });
  });
});

// the operator may name the agent; it must be one of the ticket's project's.
describe("POST /tickets/:ref/staff with a named agent", () => {
  test("202 for the named agent of the ticket's project, pinning a ticket with none; 429 no_agent for another; 400 for an empty one", async () => {
    const builder = (id: string, created_at: number) => ({
      id,
      name: id,
      kind: "builder" as const,
      runner_id: SPINE_SEED.runnerId,
      executor_id: SPINE_SEED.executorId,
      workspace_id: "P-E",
      created_at,
    });
    unwrap(
      await seedRows(spine.db, {
        workspaces: [{ id: "P-E", name: "P-E", kind: "single" }],
        agents: [builder("E-1", 10), builder("E-2", 11)],
        tickets: [
          ticketRow(6, { status: "prioritized", workspace_id: "P-E" }),
          ticketRow(7, { status: "prioritized", workspace_id: "P-E" }),
          ticketRow(8, { status: "prioritized" }),
        ],
      }),
    );
    const named = await call("POST", "/tickets/6/staff", {
      role: "builder",
      agent: "E-2",
    });
    expect(named.status).toBe(202);
    expect(StaffAccepted.parse(await named.json())).toMatchObject({
      created: true,
      agent_id: "E-2",
      ticket_status: "staffed",
    });
    const audit = unwrap(await listAudit(spine.db)).findLast(
      (a) => a.target_id === "ticket-6",
    );
    expect(JSON.parse(audit?.payload_json ?? "")).toEqual({
      role: "builder",
      agent: "E-2",
    });

    const other = await expectError(
      await call("POST", "/tickets/7/staff", { role: "builder", agent: "B-1" }),
      429,
      "admission_refused",
    );
    expect(other.message).toBe(
      "no_agent: agent B-1 has no project, and ticket #7's project P-E has builder agents of its own",
    );

    const pinned = await call("POST", "/tickets/8/staff", {
      role: "builder",
      agent: "E-1",
    });
    expect(StaffAccepted.parse(await pinned.json())).toMatchObject({
      agent_id: "E-1",
    });
    expect(unwrap(await getTicket(spine.db, "ticket-8")).workspace_id).toBe(
      "P-E",
    );

    await expectError(
      await call("POST", "/tickets/7/staff", { role: "builder", agent: "" }),
      400,
      "validation",
    );
  });
});

describe("the pulses WS topic", () => {
  test("a snapshot of the newest pulses, and a new one when a pulse row changes", async () => {
    const socket = new WebSocket(api.wsUrl, { headers: AUTH });
    const frames: PulsesFrame[] = [];
    socket.addEventListener("message", (event: MessageEvent) => {
      const frame = ServerFrame.parse(JSON.parse(String(event.data)));
      if (frame.type === "pulses") frames.push(frame);
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("ws failed")));
    });
    socket.send(JSON.stringify({ type: "subscribe", topic: "pulses" }));
    await vi.waitFor(() => expect(frames).toHaveLength(1), {
      timeout: 5_000,
      interval: 10,
    });
    expect(frames[0]?.data.items.map((p) => p.id)).toEqual([
      "P-1",
      "P-X",
      "P-0",
    ]);
    unwrap(await seedRows(spine.db, { pulses: [pulse("P-2", "A-O", 30)] }));
    await vi.waitFor(
      () => expect(frames.at(-1)?.data.items[0]?.id).toBe("P-2"),
      { timeout: 5_000, interval: 10 },
    );
    socket.close();
  });
});
