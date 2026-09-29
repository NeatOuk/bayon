import { FakeClock } from "@bayon/core";
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
import { getFleet } from "./fleet.js";

// The fleet by project: a live session's project is its own workspace, else its agent's,
// and `getFleet` keeps one project's when asked. Ended sessions are never in the fleet.
const t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
afterAll(() => t.cleanup());
unwrap(await seedSpine(t.db, 3));

const agent = (id: string, workspace_id: string) => ({
  id,
  name: id,
  kind: "builder" as const,
  runner_id: SPINE_SEED.runnerId,
  workspace_id,
  created_at: 0,
});

const session = (
  id: string,
  agent_id: string,
  o: {
    readonly workspace_id?: string;
    readonly ticket_id?: string;
    readonly state?: "running" | "exited";
  } = {},
) => ({
  ...newSessionInput(),
  id,
  agent_id,
  state: o.state ?? ("running" as const),
  created_at: 0,
  ...(o.workspace_id === undefined ? {} : { workspace_id: o.workspace_id }),
  ...(o.ticket_id === undefined ? {} : { ticket_id: o.ticket_id }),
});

unwrap(
  await seedRows(t.db, {
    workspaces: [
      { id: "shop", name: "shop", kind: "single" },
      { id: "blog", name: "blog", kind: "single" },
    ],
    agents: [agent("shop-builder", "shop"), agent("blog-builder", "blog")],
    tickets: [ticketRow(7, { workspace_id: "shop" })],
    sessions: [
      // A fleet agent's session placed in shop: its own workspace decides.
      session("s-own", SPINE_SEED.agentId, {
        workspace_id: "shop",
        ticket_id: "ticket-7",
      }),
      // No workspace of its own (a pulse's shape): its agent's decides.
      session("s-agent", "shop-builder"),
      // Its own workspace wins over its agent's.
      session("s-moved", "blog-builder", { workspace_id: "shop" }),
      session("s-blog", "blog-builder"),
      session("s-ended", "shop-builder", { state: "exited" }),
    ],
  }),
);

const projectOf = async () =>
  Object.fromEntries(
    unwrap(await getFleet(t.db)).map((row) => [row.id, row.workspace_id]),
  );

test("a live session's project is its own workspace, else its agent's; fleet work has none", async () => {
  expect(await projectOf()).toEqual({
    [SPINE_SEED.sessionId]: null,
    "s-agent": "shop",
    "s-blog": "blog",
    "s-moved": "shop",
    "s-own": "shop",
  });
});

test("a row names its ticket by key, and a row with no ticket has none", async () => {
  const rows = unwrap(await getFleet(t.db));
  expect(rows.find((r) => r.id === "s-own")).toMatchObject({
    ticket: 7,
    ticket_key: "FRM-7",
  });
  expect(rows.find((r) => r.id === "s-agent")?.ticket_key).toBeNull();
});

test("a project filter keeps only that project's live sessions", async () => {
  const ids = async (workspaceId: string) =>
    unwrap(await getFleet(t.db, { workspaceId })).map((row) => row.id);
  expect(await ids("shop")).toEqual(["s-agent", "s-moved", "s-own"]);
  expect(await ids("blog")).toEqual(["s-blog"]);
  expect(await ids("nowhere")).toEqual([]);
});
