import { FakeClock, forgeTokenSecret, ok, systemClock } from "@bayon/core";
import { openDb, type Db } from "@bayon/db";
// The operator's own door, which @bayon/db/testing re-exports because apps/supervisor may not
// import @bayon/db/api.
import {
  OPERATOR,
  dumpAllRows,
  seedRows,
  tempDb,
  transitionTicket,
  unwrap,
} from "@bayon/db/testing";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  fixtureRemote,
  pullBody,
  pullPath,
  startForgeFixture,
  type ForgeFixture,
} from "../forge/fixtures.js";
import type { Fetch } from "../forge/http.js";
import { sweepPullRequests } from "./pull-requests.js";
import {
  T0,
  TICKET,
  makeWorld,
  projectRows,
  secretsOf,
  type World,
} from "./testing/world.js";

// The sweep's race (MEDIUM 5): it reads a ticket's open requests, spends a network
// call on each, and only then writes. The operator can move the ticket in that window. Here the move
// is made on a second connection while the forge's answer is in flight — between the sweep's read
// and its write — and the settle, which reads everything again inside its own BEGIN IMMEDIATE, must
// record the merge and take the edge the ticket's *new* status allows, or none, and never fail.

let fixture: ForgeFixture;
let world: World | null = null;
let temp: { cleanup(): void } | null = null;
let rival: Db | null = null;

beforeEach(async () => {
  fixture = await startForgeFixture();
});

afterEach(async () => {
  if (rival !== null) unwrap(await rival.close());
  rival = null;
  world?.cleanup();
  world = null;
  temp?.cleanup();
  temp = null;
  await fixture.close();
});

/** The operator's move, made from inside the forge call: after the sweep read, before it writes. */
type Move = (db: Db) => Promise<void>;

async function worldMovingDuringThePoll(
  move: Move,
  answer: "merged" | "closed" = "merged",
): Promise<World> {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  temp = t;
  const other = unwrap(await openDb({ path: t.path, clock: systemClock }));
  rival = other;
  const through = fixture.fetchVia();
  const racing: Fetch = async (url, init) => {
    await move(other);
    return through(url, init);
  };
  const w = makeWorld(t.db, clock, {
    secrets: secretsOf({ [forgeTokenSecret("github")]: "a-token" }),
    forgeFetch: racing,
    forgeRemoteOf: () => fixtureRemote(),
  });
  world = w;
  const rows = projectRows({
    repos: [
      {
        id: "r1",
        src: "/src/r1",
        mirror: "/mirrors/r1.git",
        remote: "https://forge.test/an-owner/r1.git",
        head: "a".repeat(40),
      },
    ],
    status: "qa_human",
  });
  unwrap(
    await seedRows(t.db, {
      ...rows,
      deliveries: [
        {
          id: "D-r1",
          ticket_id: TICKET,
          repo_id: "r1",
          branch: "frm/s1",
          head_sha: "a".repeat(40),
          remote_url: "https://forge.test/an-owner/r1.git",
          state: "pr_open",
          pr_url: "https://forge.test/pull/1",
          pr_number: 1,
          started_at: T0,
        },
      ],
    }),
  );
  fixture.details.set(pullPath(1), pullBody(1, answer, "a-merger"));
  return w;
}

/** The operator moves the ticket, as the API would once its laws allowed it. */
const operatorMoves =
  (to: string, patch: Record<string, unknown> = {}): Move =>
  async (db) => {
    unwrap(
      await transitionTicket(
        db,
        { id: TICKET, version: 1, to, by: OPERATOR, patch },
        () => ok(undefined),
      ),
    );
  };

const transitions = async (w: World) =>
  (
    (unwrap(await dumpAllRows(w.db)).ticket_events ?? []) as {
      kind: string;
      from_status: string | null;
      to_status: string | null;
      actor_kind: string;
      payload_json: string;
    }[]
  ).filter((e) => e.kind === "transition");

test("sent back to rework mid-poll: the merge is recorded and merge_close is taken from rework", async () => {
  const w = await worldMovingDuringThePoll(operatorMoves("rework"));
  expect(await sweepPullRequests(w.ctx)).toMatchObject({
    merged: 1,
    done: 1,
    failed: 0,
  });
  const moves = await transitions(w);
  expect(moves.map((m) => [m.actor_kind, m.from_status, m.to_status])).toEqual([
    ["operator", "qa_human", "rework"],
    ["supervisor", "rework", "done"],
  ]);
  expect(JSON.parse(moves[1]?.payload_json ?? "{}")).toMatchObject({
    rule: "merge_close",
    merged_by: "a-merger",
  });
});

test("closed by the operator mid-poll: the merge is recorded, no edge is taken, nothing fails", async () => {
  const w = await worldMovingDuringThePoll(
    operatorMoves("done", { closed_at: T0 }),
  );
  expect(await sweepPullRequests(w.ctx)).toMatchObject({
    merged: 1,
    done: 0,
    failed: 0,
  });
  const rows = unwrap(await dumpAllRows(w.db));
  expect(rows.deliveries).toMatchObject([
    { state: "merged", merged_by: "a-merger" },
  ]);
  expect(
    (await transitions(w)).map((m) => [m.actor_kind, m.to_status]),
  ).toEqual([["operator", "done"]]);
  expect((rows.tickets as { status: string }[]).map((t) => t.status)).toEqual([
    "done",
  ]);
});

test("parked mid-poll: the merge is recorded and the parked ticket stays parked", async () => {
  const w = await worldMovingDuringThePoll(operatorMoves("parked"));
  expect(await sweepPullRequests(w.ctx)).toMatchObject({
    merged: 1,
    done: 0,
    failed: 0,
  });
  const rows = unwrap(await dumpAllRows(w.db));
  expect((rows.tickets as { status: string }[]).map((t) => t.status)).toEqual([
    "parked",
  ]);
  expect(rows.deliveries).toMatchObject([{ state: "merged" }]);
});

// the ticket turns done while the forge's answer is in flight — the settle reads the new
// status inside its own transaction: the row settles, no edge is taken, and a request closed unmerged
// is reported as a done ticket's.
const turnsDone = operatorMoves("done", { closed_at: T0 });

test("done mid-poll, then merged: the merge is recorded and no edge is taken", async () => {
  const w = await worldMovingDuringThePoll(turnsDone, "merged");
  expect(await sweepPullRequests(w.ctx)).toMatchObject({
    merged: 1,
    closed: 0,
    done: 0,
    failed: 0,
  });
  const rows = unwrap(await dumpAllRows(w.db));
  expect(rows.deliveries).toMatchObject([
    { state: "merged", merged_by: "a-merger" },
  ]);
  // The operator's own move, and none of the supervisor's.
  expect(
    (await transitions(w)).map((m) => [m.actor_kind, m.to_status]),
  ).toEqual([["operator", "done"]]);
  expect(rows.human_requests).toEqual([]);
});

test("done mid-poll, then closed: the row is closed, no edge is taken, and the done ticket's request is filed", async () => {
  const w = await worldMovingDuringThePoll(turnsDone, "closed");
  expect(await sweepPullRequests(w.ctx)).toMatchObject({
    merged: 0,
    closed: 1,
    done: 0,
    failed: 0,
  });
  const rows = unwrap(await dumpAllRows(w.db));
  expect(rows.deliveries).toMatchObject([{ state: "closed" }]);
  expect(
    (await transitions(w)).map((m) => [m.actor_kind, m.to_status]),
  ).toEqual([["operator", "done"]]);
  expect(
    (rows.human_requests as { question: string }[]).map((r) => r.question),
  ).toEqual([
    "PR closed without merging on a done ticket: https://forge.test/pull/1",
  ]);
  expect((rows.tickets as { status: string }[]).map((t) => t.status)).toEqual([
    "done",
  ]);
});
