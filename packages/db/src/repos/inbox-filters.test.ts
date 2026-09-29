import { FakeClock, STAFF_APPROVAL_KIND } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import {
  SPINE_SEED,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "../testing.js";
import { listInboxRequests } from "./inbox.js";

// The inbox's kind and project filters: the IDE counts a project's open staffing
// proposals. A request's project is its ticket's workspace, else its session's, else that session's
// agent's — the timeline's scope.
const t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
afterAll(() => t.cleanup());
unwrap(await seedSpine(t.db, 3));

const request = (
  id: string,
  kind: string,
  o: { readonly ticket_id?: string; readonly session_id?: string } = {},
) => ({
  id,
  kind,
  question: `question ${id}`,
  context_md: null,
  options_json: null,
  batch_id: null,
  answer_json: null,
  answered_by: null,
  asked_at: Number(id.slice(1)),
  answered_at: null,
  expires_at: null,
  dedupe_key: null,
  proposal_json: null,
  ticket_id: o.ticket_id ?? null,
  session_id: o.session_id ?? null,
});

unwrap(
  await seedRows(t.db, {
    workspaces: [
      { id: "shop", name: "shop", kind: "single" },
      { id: "blog", name: "blog", kind: "single" },
    ],
    agents: [
      {
        id: "shop-orch",
        name: "shop-orch",
        kind: "orchestrator",
        runner_id: SPINE_SEED.runnerId,
        workspace_id: "shop",
        created_at: 0,
      },
    ],
    tickets: [
      ticketRow(1, { workspace_id: "shop" }),
      ticketRow(2, { workspace_id: "blog" }),
      ticketRow(3),
    ],
    sessions: [
      {
        ...newSessionInput(),
        id: "s-orch",
        agent_id: "shop-orch",
        state: "idle",
        created_at: 0,
      },
      {
        ...newSessionInput(),
        id: "s-placed",
        workspace_id: "shop",
        state: "idle",
        created_at: 0,
      },
    ],
    human_requests: [
      // The ticket's project.
      request("r1", STAFF_APPROVAL_KIND, {
        ticket_id: "ticket-1",
        session_id: "s-orch",
      }),
      // A ticket with no project: the asking session's agent's.
      request("r2", STAFF_APPROVAL_KIND, {
        ticket_id: "ticket-3",
        session_id: "s-orch",
      }),
      // The ticket's project wins over the session's.
      request("r3", STAFF_APPROVAL_KIND, {
        ticket_id: "ticket-2",
        session_id: "s-orch",
      }),
      request("r4", "decision", { ticket_id: "ticket-1" }),
      // No ticket: the session's own workspace.
      request("r5", "decision", { session_id: "s-placed" }),
      // Neither: in no project.
      request("r6", STAFF_APPROVAL_KIND),
    ],
  }),
);

const ids = async (q: {
  readonly kind?: string;
  readonly workspaceId?: string;
}) =>
  unwrap(await listInboxRequests(t.db, { ...q, limit: 100 })).rows.map(
    (row) => row.id,
  );

test("a kind keeps that kind's requests, newest first", async () => {
  expect(await ids({ kind: STAFF_APPROVAL_KIND })).toEqual([
    "r6",
    "r3",
    "r2",
    "r1",
  ]);
});

test("a project keeps its ticket's, else its session's, else that session's agent's", async () => {
  expect(await ids({ workspaceId: "shop" })).toEqual(["r5", "r4", "r2", "r1"]);
  expect(await ids({ workspaceId: "blog" })).toEqual(["r3"]);
  expect(await ids({ workspaceId: "nowhere" })).toEqual([]);
});

test("both together: one project's staffing proposals", async () => {
  expect(await ids({ kind: STAFF_APPROVAL_KIND, workspaceId: "shop" })).toEqual(
    ["r2", "r1"],
  );
});

test("an empty kind or project is refused", async () => {
  for (const bad of [{ kind: "" }, { workspaceId: "" }]) {
    const res = await listInboxRequests(t.db, { ...bad, limit: 10 });
    expect(res.ok ? null : res.error.class).toBe("validation");
  }
});
