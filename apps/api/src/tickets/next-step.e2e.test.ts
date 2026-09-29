import { FakeClock, systemClock, waitsOnYou } from "@bayon/core";
import { openDb, type Db } from "@bayon/db";
import {
  SPINE_SEED,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import {
  ApiErrorBody,
  NextStep,
  TicketDetail,
  TicketsPage,
} from "@bayon/proto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { dbStore } from "../db-store.js";
import { startApi, type RunningApi } from "../server.js";
import { TicketService } from "./ticket-service.js";

// GET /tickets/:ref/next over HTTP against a temp-file DB: the shapes the operator used
// to query SQLite for, each said in one line with its way on; the ticket page carries the same value;
// and the board's set-based flag agrees with it on every ticket.

const TOKEN = "e2e-next-step-0123456789abcdef";

let spine: TempDb;
let apiDb: Db;
let api: RunningApi;

const agent = (id: string, kind: "builder" | "orchestrator") => ({
  id,
  name: id,
  kind,
  runner_id: SPINE_SEED.runnerId,
  executor_id: SPINE_SEED.executorId,
  workspace_id: "shop",
  created_at: 0,
});

const gate = (
  id: string,
  ticket_id: string,
  o: {
    state: string;
    attempt: number;
    round: number;
    evidence_json: string | null;
  },
) => ({
  id,
  ticket_id,
  kind: "code_review" as const,
  subject_kind: "diff",
  subject_ref: "HEAD",
  started_at: 1,
  decided_at: 2,
  ...o,
  state: o.state as "passed" | "failed",
});

const ticket = (num: number, status: string) =>
  ticketRow(num, { status, workspace_id: "shop" });

beforeAll(async () => {
  spine = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  unwrap(await seedSpine(spine.db, 35));
  unwrap(
    await seedRows(spine.db, {
      workspaces: [{ id: "shop", name: "shop", kind: "single" }],
      agents: [
        agent("shop-orch", "orchestrator"),
        agent("shop-builder", "builder"),
      ],
      tickets: [
        ticket(1, "backlog"),
        ticket(2, "building"),
        ticket(3, "code_review"),
        ticket(4, "qa_harness"),
        ticket(5, "parked"),
        ticket(6, "building"),
        ticket(7, "code_review"),
      ],
      sessions: [
        {
          ...newSessionInput(),
          id: "S-build",
          agent_id: "shop-builder",
          ticket_id: "ticket-6",
          state: "running",
          turns: 14,
          created_at: 1,
        },
      ],
      gates: [
        // The live fleet's shape: a no_reviewer attempt, then another; the ticket stays in review.
        gate("G-3a", "ticket-3", {
          state: "failed",
          attempt: 1,
          round: 1,
          evidence_json: JSON.stringify({ reason: "no_reviewer" }),
        }),
        gate("G-3b", "ticket-3", {
          state: "failed",
          attempt: 2,
          round: 1,
          evidence_json: JSON.stringify({
            reason: "no_reviewer",
            detail: "no certified runner is enabled",
          }),
        }),
        gate("G-7", "ticket-7", {
          state: "passed",
          attempt: 1,
          round: 1,
          evidence_json: JSON.stringify({
            command: "review",
            exit_code: 0,
            duration_ms: 1,
            cost_usd: 0,
            artifact_paths: ["a"],
            run_id: "R1",
            session_id: "S2",
            runner_id: "reviewer",
            runner_version: "1",
            executor_id: "local",
            model: null,
            subject: {
              repo_id: null,
              base_sha: "a".repeat(40),
              head_sha: "b".repeat(40),
              files: 1,
            },
            findings: {
              total: 0,
              by_severity: { blocker: 0, major: 0, minor: 0, nit: 0 },
              parse: "schema",
            },
            flags: {},
          }),
        }),
      ],
      human_requests: ["Which store?", "Keep v1?"].map((question, i) => ({
        id: `Q-${i}`,
        ticket_id: "ticket-2",
        kind: "decision",
        question,
        status: "open",
        asked_at: 1,
      })),
      ticket_events: [
        {
          ticket_id: "ticket-5",
          ts: 1,
          actor_kind: "operator",
          kind: "transition",
          from_status: "building",
          to_status: "parked",
          reason: "waits on the design",
        },
      ],
    }),
  );
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

const get = (path: string): Promise<Response> =>
  fetch(`${api.url}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });

async function next(num: number): Promise<NextStep> {
  const res = await get(`/tickets/${num}/next`);
  expect(res.status).toBe(200);
  return NextStep.parse(await res.json());
}

test.each([
  [
    1,
    {
      waiting_on: "orchestrator",
      reason:
        "Waiting for the orchestrator to prioritise it (it wakes only when other work is due)",
      // The spine's builder can take it: Start work saves the wait.
      action: { kind: "start", label: "Start work" },
    },
  ],
  [
    2,
    {
      waiting_on: "you",
      reason: "Waiting on your answer to 2 questions",
      action: { kind: "answer", label: "Answer them", target: "questions" },
    },
  ],
  [
    3,
    {
      waiting_on: "you",
      reason:
        "Review can't run: no eligible reviewer (no certified runner is enabled)",
      action: {
        kind: "configure",
        label: "Set up a reviewer",
        target: "runners",
      },
    },
  ],
  [
    4,
    {
      waiting_on: "you",
      reason: "QA needs your note (no QA harness configured)",
      action: {
        kind: "transition",
        label: "Pass with a note",
        target: "qa_human",
      },
    },
  ],
  [
    5,
    {
      waiting_on: "nothing",
      reason: "Parked: waits on the design",
      action: { kind: "transition", label: "Unpark", target: "backlog" },
    },
  ],
  [6, { waiting_on: "agent", reason: "shop-builder is building (turn 14)" }],
  [
    7,
    {
      waiting_on: "nothing",
      reason: "Review passed: foreman moves it to qa_harness on its own",
      action: {
        kind: "transition",
        label: "Move it now",
        target: "qa_harness",
      },
    },
  ],
] as const)("ticket %i says what it waits on", async (num, want) => {
  expect(await next(num)).toEqual(want);
});

test("the ticket page carries the same next step", async () => {
  for (const num of [2, 3, 6]) {
    const res = await get(`/tickets/${num}`);
    expect(res.status).toBe(200);
    expect(TicketDetail.parse(await res.json()).next_step).toEqual(
      await next(num),
    );
  }
});

test("the board's flag agrees with every ticket's next step", async () => {
  const res = await get("/tickets?workspace_id=shop");
  expect(res.status).toBe(200);
  const page = TicketsPage.parse(await res.json());
  expect(page.items.map((t) => t.num)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  for (const card of page.items) {
    expect({ num: card.num, waiting: card.waiting_on_you }).toEqual({
      num: card.num,
      waiting: waitsOnYou(await next(card.num)),
    });
  }
  const reasons = Object.fromEntries(
    page.items.map((t) => [t.num, t.waiting_reason]),
  );
  expect(reasons).toEqual({
    1: null,
    2: "Waiting on your answer to 2 questions",
    3: "Review can't run: no eligible reviewer",
    4: "QA needs your note (no QA harness configured)",
    5: null,
    6: null,
    7: null,
  });
});

test("an unknown ticket is 404, and a ref that is none is 400", async () => {
  const missing = await get("/tickets/999/next");
  expect(missing.status).toBe(404);
  expect(ApiErrorBody.parse(await missing.json()).error.class).toBe(
    "not_found",
  );
  const bad = await get("/tickets/not-a-ref/next");
  expect(bad.status).toBe(400);
});
