import { FakeClock, systemClock } from "@bayon/core";
import { getTicket, openDb, type Db } from "@bayon/db";
import {
  newSessionInput,
  seedHolders,
  modelRow,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import { ServerFrame } from "@bayon/proto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dbStore } from "../db-store.js";
import { startApi, type RunningApi } from "../server.js";
import { TicketService } from "../tickets/ticket-service.js";
import { WS_TUNING } from "../ws/hub.js";
import { finding, gate, passed } from "./fixtures.js";
import { GateService } from "./gate-service.js";

// /api/v1/gates, /findings, /role-bindings and the `gates` topic over HTTP and WS (// §7), against a temp-file DB. The operator's doors: 202/409/422 on rerun, 409 on a stale waive or
// resolve, 422 cross_ticket_write for a run on another ticket, 404 for an unknown runner.

const TOKEN = "e2e-gates-bearer-0123456789abcdef";
const AUTH = { authorization: `Bearer ${TOKEN}` };

let spine: TempDb;
let apiDb: Db;
let api: RunningApi;

beforeAll(async () => {
  spine = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  unwrap(await seedSpine(spine.db, 8));
  unwrap(
    await seedRows(spine.db, {
      runners: [
        { id: "other", kind: "script", adapter: "fixture", caps_json: "{}" },
      ],
      tickets: [
        ticketRow(1, { status: "code_review" }),
        ticketRow(2, { status: "building" }),
        ticketRow(3, { status: "code_review" }),
        ticketRow(4, { status: "building" }),
        ticketRow(5, { status: "code_review" }),
      ],
    }),
  );
  unwrap(await seedHolders(spine.db, [1, 2, 3, 4, 5]));
  apiDb = unwrap(await openDb({ path: spine.path, clock: systemClock }));
  api = await startApi({
    config: { token: TOKEN, host: "127.0.0.1", port: 0 },
    store: dbStore(apiDb),
    clock: systemClock,
    tuning: WS_TUNING,
    logger: false,
    tickets: new TicketService({
      db: apiDb,
      clock: systemClock,
      workRoot: null,
    }),
    gates: new GateService({ db: apiDb }),
  });
});

afterAll(async () => {
  await api.close();
  await apiDb.close();
  spine.cleanup();
});

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const res = await fetch(`${api.url}${path}`, {
    method,
    headers: { ...AUTH, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

const items = (r: Reply) => r.body["items"] as Record<string, unknown>[];

function nextFrame(socket: WebSocket, type: string): Promise<ServerFrame> {
  return new Promise((resolve) => {
    const listener = (event: MessageEvent) => {
      const frame = ServerFrame.parse(JSON.parse(String(event.data)));
      if (frame.type !== type) return;
      socket.removeEventListener("message", listener);
      resolve(frame);
    };
    socket.addEventListener("message", listener);
  });
}

function openSocket(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(api.wsUrl, { headers: AUTH });
    socket.addEventListener("open", () => resolve(socket));
    socket.addEventListener("error", () => reject(new Error("ws failed")));
  });
}

describe("a round opened by a transition", () => {
  test("GET /gates and the gates topic show it; its session comes from sessions.gate_id once spawned", async () => {
    const moved = await call(
      "POST",
      "/tickets/2/transition",
      { to: "code_review" },
      { "if-match": '"1"' },
    );
    expect(moved.status).toBe(200);
    const listed = await call("GET", "/gates?state=running&ticket=2");
    expect(listed.status).toBe(200);
    const [row] = items(listed);
    expect(row).toMatchObject({
      kind: "code_review",
      attempt: 1,
      state: "running",
      session_id: null,
      ticket: { num: 2, key: "FRM-2", status: "code_review" },
    });
    const gateId = String(row?.["id"]);
    unwrap(
      await seedRows(spine.db, {
        sessions: [
          {
            ...newSessionInput(),
            id: "S-rev",
            state: "running",
            gate_id: gateId,
            created_at: 5,
          },
        ],
      }),
    );
    expect(items(await call("GET", "/gates?ticket=2"))[0]).toMatchObject({
      session_id: "S-rev",
    });

    const socket = await openSocket();
    const frame = nextFrame(socket, "gates");
    socket.send(JSON.stringify({ type: "subscribe", topic: "gates" }));
    const gates = await frame;
    expect(
      gates.type === "gates" && gates.data.items.map((g) => g.id),
    ).toContain(gateId);
    socket.close();
  });
});

describe("POST /gates/:id/run", () => {
  test("202 opens attempt n+1; 409 while one runs; 422 outside the review status; 404 unknown", async () => {
    unwrap(
      await seedRows(spine.db, {
        gates: [
          gate("g1", 1, { state: "failed" }),
          gate("g4", 4, { state: "failed" }),
        ],
      }),
    );
    const opened = await call("POST", "/gates/g1/run");
    expect(opened.status).toBe(202);
    expect(opened.body).toMatchObject({ attempt: 2 });
    expect(opened.body["command_id"]).toEqual(expect.any(String));
    expect((await call("POST", "/gates/g1/run")).status).toBe(409);
    const outside = await call("POST", "/gates/g4/run");
    expect(outside.status).toBe(422);
    expect(outside.body["error"]).toMatchObject({
      class: "law_refused",
      rule: "rerun_gate",
      reason: "illegal_transition",
    });
    expect((await call("POST", "/gates/nope/run")).status).toBe(404);
  });
});

describe("POST /gates/:id/waive", () => {
  test("200 with the reason shown; 409 on a passed gate; 400 without a reason", async () => {
    unwrap(
      await seedRows(spine.db, {
        gates: [
          gate("g5", 3, { state: "failed" }),
          passed("g6", 3, { kind: "ce_review" }),
        ],
      }),
    );
    const waived = await call("POST", "/gates/g5/waive", {
      reason: "flaky reviewer",
    });
    expect(waived.status).toBe(200);
    expect(waived.body).toMatchObject({
      state: "waived",
      waive_reason: "flaky reviewer",
      findings: [],
    });
    expect(
      (await call("POST", "/gates/g5/waive", { reason: "again" })).status,
    ).toBe(409);
    expect(
      (await call("POST", "/gates/g6/waive", { reason: "x" })).status,
    ).toBe(409);
    expect((await call("POST", "/gates/g5/waive", { reason: "" })).status).toBe(
      400,
    );
  });
});

describe("POST /findings/:id/resolve|waive", () => {
  test("resolve names the fixing run; a run on another ticket is 422; twice is 409; waive is 200", async () => {
    unwrap(
      await seedRows(spine.db, {
        gates: [gate("g7", 3, { state: "failed", attempt: 3 })],
        findings: [
          finding("f7a", "g7"),
          finding("f7b", "g7", { severity: "nit" }),
        ],
      }),
    );
    const foreign = await call("POST", "/findings/f7a/resolve", {
      run_id: "R-1",
      note: "mine",
    });
    expect(foreign.status).toBe(422);
    expect(foreign.body["error"]).toMatchObject({
      reason: "cross_ticket_write",
    });
    const resolved = await call("POST", "/findings/f7a/resolve", {
      run_id: "R-3",
      note: "fixed the null check",
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({
      status: "resolved",
      resolved_by_run_id: "R-3",
      resolved_by: "operator",
    });
    expect(
      (
        await call("POST", "/findings/f7a/resolve", {
          run_id: "R-3",
          note: "x",
        })
      ).status,
    ).toBe(409);
    const waived = await call("POST", "/findings/f7b/waive", {
      reason: "style only",
    });
    expect(waived.status).toBe(200);
    expect(waived.body).toMatchObject({
      status: "waived",
      waive_reason: "style only",
    });
  });
});

describe("GET/PUT /role-bindings", () => {
  test("ids are checked against their rows, certification is not; GET lists the bindings", async () => {
    expect(
      (
        await call("PUT", "/role-bindings", {
          role: "code_reviewer",
          runner_id: "ghost",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("PUT", "/role-bindings", {
          role: "code_reviewer",
          runner_id: "other",
          fallback_runner_id: "other",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("PUT", "/role-bindings", {
          role: "wizard",
          runner_id: "other",
        })
      ).status,
    ).toBe(400);
    const put = await call("PUT", "/role-bindings", {
      role: "code_reviewer",
      runner_id: "other",
      require_distinct_from: "builder",
    });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({
      role: "code_reviewer",
      updated_by: "operator",
    });
    expect(items(await call("GET", "/role-bindings"))).toEqual([put.body]);
    // No tier and no profile: no model the binding itself runs.
    expect(put.body).toMatchObject({ model_id: null, model: null });
  });

  test("a binding with a tier names the model it runs on its runner", async () => {
    unwrap(
      await seedRows(spine.db, {
        models: [modelRow("other", "complex"), modelRow("other", "cheap")],
      }),
    );
    const put = await call("PUT", "/role-bindings", {
      role: "plan_reviewer",
      runner_id: "other",
      model_tier: "complex",
    });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({
      model_tier: "complex",
      model_id: "other.complex",
      model: "other-complex-model",
    });
    expect(
      items(await call("GET", "/role-bindings")).find(
        (b) => b["role"] === "plan_reviewer",
      ),
    ).toEqual(put.body);
  });
});

describe("GET /tickets/:ref after two rounds", () => {
  test("review_rounds is the view's; each gate carries its reason and evidence; the column is untouched", async () => {
    unwrap(
      await seedRows(spine.db, {
        gates: [
          gate("g8a", 5, {
            state: "failed",
            evidence_json: '{"reason":"timeout"}',
          }),
          passed("g8b", 5, { attempt: 2 }),
        ],
      }),
    );
    const detail = await call("GET", "/tickets/5");
    expect(detail.status).toBe(200);
    expect(detail.body["economics"]).toMatchObject({ review_rounds: 2 });
    const gates = detail.body["gates"] as Record<string, unknown>[];
    expect(gates.find((g) => g["id"] === "g8a")).toMatchObject({
      reason: "timeout",
      evidence: { reason: "timeout" },
    });
    expect(gates.find((g) => g["id"] === "g8b")).toMatchObject({
      reason: null,
      evidence: { command: "review --json" },
    });
    expect(
      unwrap(await getTicket(spine.db, "ticket-5")).review_rounds,
    ).not.toBe(2);
  });
});

describe("a gate that failed before a review", () => {
  test("GET /gates and GET /tickets/:ref serve why: the detail, the runners considered, the base and tip", async () => {
    const noReviewer = {
      reason: "no_reviewer",
      detail:
        "plan_reviewer on local (bound to fixture): fixture: no reviewer agent",
      considered: {
        role: "plan_reviewer",
        executor_id: "local",
        bound: true,
        runners: [{ runner_id: "fixture", why: ["no_reviewer_agent"] }],
      },
    };
    const drift = {
      reason: "base_drift",
      detail: `the pinned base ${"a".repeat(40)} is not the tip ${"c".repeat(40)}`,
      drift: { base_sha: "a".repeat(40), tip_sha: "c".repeat(40) },
    };
    unwrap(
      await seedRows(spine.db, {
        gates: [
          gate("g9a", 4, {
            kind: "plan_review",
            state: "failed",
            evidence_json: JSON.stringify(noReviewer),
            decided_at: 3,
          }),
          gate("g9b", 4, {
            kind: "ce_review",
            state: "failed",
            evidence_json: JSON.stringify(drift),
            decided_at: 3,
          }),
        ],
      }),
    );
    const listed = await call("GET", "/gates?ticket=4&state=failed");
    expect(listed.status).toBe(200);
    const byId = new Map(items(listed).map((g) => [g["id"], g]));
    expect(byId.get("g9a")).toMatchObject({
      reason: "no_reviewer",
      evidence: noReviewer,
    });
    expect(byId.get("g9b")).toMatchObject({
      reason: "base_drift",
      evidence: drift,
    });
    const detail = await call("GET", "/tickets/4");
    expect(detail.status).toBe(200);
    const gates = detail.body["gates"] as Record<string, unknown>[];
    expect(gates.find((g) => g["id"] === "g9a")).toMatchObject({
      reason: "no_reviewer",
      evidence: noReviewer,
    });
  });
});
