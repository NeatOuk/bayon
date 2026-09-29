import {
  FakeClock,
  ok,
  type DeliveryConfigFields,
  type DeliveryMode,
  type DeliveryMoment,
} from "@bayon/core";
import { afterEach, expect, test } from "vitest";
import type { Db } from "../connection.js";
import {
  OPERATOR,
  dumpAllRows,
  newTicketInput,
  seedRows,
  tempDb,
  unwrap,
  updateRowForTest,
  type TempDb,
} from "../testing.js";
import { deliveryPlan, listDeliveryCandidates } from "./delivery-reads.js";
import { recordDelivery } from "./delivery-writes.js";
import { setProjectSettings } from "./project-settings.js";
import { transitionTicket } from "./ticket-transition.js";
import { createTicket, updateTicketCas } from "./ticket-writes.js";

// delivery applies only to the moments a ticket reaches at or after its project's
// delivery was turned on (`workspaces.delivery_since`, 047) — never to the project's history. Every
// row here is written by the real writers, so "when it reached its moment" is the transition event
// they leave, exactly as in production. Against a real temp database.

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;
const PROJECT = "P";

let t: TempDb | null = null;
afterEach(() => {
  t?.cleanup();
  t = null;
});

/** A project that delivers nothing yet, with one repo, on a clock at T0. */
async function world(): Promise<{ db: Db; clock: FakeClock }> {
  const clock = new FakeClock(T0);
  const temp = unwrap(await tempDb(clock));
  t = temp;
  unwrap(
    await seedRows(temp.db, {
      repos: [
        {
          id: "r1",
          name: "r1",
          origin_url: "/remotes/r1.git",
          mirror_path: "/mirrors/r1.git",
          doctrine_paths_json: "[]",
        },
      ],
      workspaces: [{ id: PROJECT, name: PROJECT, kind: "single" }],
      workspace_repos: [
        {
          workspace_id: PROJECT,
          repo_id: "r1",
          rel_path: "r1",
          role: "primary",
          submodule_path: null,
        },
      ],
    }),
  );
  return { db: temp.db, clock };
}

/** Files a ticket of the project in `status`. */
async function file(db: Db, title: string, status = "code_review") {
  return unwrap(
    await createTicket(
      db,
      newTicketInput({ title, status, workspace_id: PROJECT }),
      OPERATOR,
    ),
  ).id;
}

/** Moves a ticket on, the laws waived: this is about when it moved, not whether it may. */
async function move(db: Db, id: string, to: string): Promise<void> {
  const rows = unwrap(await dumpAllRows(db)).tickets as {
    id: string;
    version: number;
  }[];
  const version = rows.find((r) => r.id === id)?.version ?? 0;
  unwrap(
    await transitionTicket(db, { id, version, to, by: OPERATOR }, () =>
      ok(undefined),
    ),
  );
}

/** Sets the project's delivery through the API's audited door. */
async function deliver(
  db: Db,
  mode: DeliveryMode,
  when: DeliveryMoment = "review_passed",
): Promise<void> {
  const delivery: DeliveryConfigFields = { mode, when, close_on_merge: true };
  unwrap(await setProjectSettings(db, PROJECT, { delivery }, "operator"));
}

const candidates = async (db: Db): Promise<string[]> =>
  unwrap(await listDeliveryCandidates(db, { limit: 50, after: null })).map(
    (c) => c.id,
  );

const due = async (db: Db, id: string): Promise<boolean> =>
  unwrap(await deliveryPlan(db, id)).due;

const since = async (db: Db): Promise<unknown> =>
  (
    unwrap(await dumpAllRows(db)).workspaces as {
      delivery_since: number | null;
    }[]
  )[0]?.delivery_since;

test("turning delivery on delivers none of the project's finished tickets", async () => {
  const { db, clock } = await world();
  const old = await file(db, "long done");
  await move(db, old, "qa_harness");
  await move(db, old, "done");
  await clock.advance(9 * DAY);

  await deliver(db, "pull_request");
  expect(await since(db)).toBe(T0 + 9 * DAY);
  expect(await candidates(db)).toEqual([]);
  expect(await due(db, old)).toBe(false);
  // An edit bumps updated_at past the mark; it is not a moment, and delivers nothing.
  await clock.advance(1_000);
  const version = (
    unwrap(await dumpAllRows(db)).tickets as { version: number }[]
  )[0]?.version;
  unwrap(
    await updateTicketCas(db, {
      id: old,
      version: version ?? 0,
      patch: { title: "long done, renamed" },
      by: OPERATOR,
    }),
  );
  expect(await candidates(db)).toEqual([]);
});

test("a ticket that reaches the moment after delivery is on is delivered, as before", async () => {
  const { db, clock } = await world();
  const before = await file(db, "filed before");
  await deliver(db, "push");
  await clock.advance(1_000);
  await move(db, before, "qa_harness");
  const after = await file(db, "filed after", "code_review");
  await clock.advance(1_000);
  await move(db, after, "qa_harness");
  await move(db, after, "qa_human");

  expect((await candidates(db)).toSorted()).toEqual([after, before].toSorted());
  expect(await due(db, before)).toBe(true);
  expect(await due(db, after)).toBe(true);
});

test("the moment is entered once: a review passed before delivery was on stays undelivered to done", async () => {
  const { db, clock } = await world();
  const passed = await file(db, "review passed first");
  await move(db, passed, "qa_harness");
  await clock.advance(DAY);
  await deliver(db, "pull_request");
  await clock.advance(DAY);
  await move(db, passed, "qa_human");
  await move(db, passed, "done");
  expect(await candidates(db)).toEqual([]);
  expect(await due(db, passed)).toBe(false);

  // Sent back and through review again: that is a new moment, and it is delivered.
  await move(db, passed, "rework");
  await move(db, passed, "qa_harness");
  expect(await candidates(db)).toEqual([passed]);
});

test("a `done` moment is entering done, whenever review passed", async () => {
  const { db, clock } = await world();
  const ticket = await file(db, "reviewed before");
  await move(db, ticket, "qa_harness");
  await clock.advance(DAY);
  await deliver(db, "push", "done");
  expect(await candidates(db)).toEqual([]);
  await clock.advance(DAY);
  await move(db, ticket, "done");
  expect(await candidates(db)).toEqual([ticket]);
});

test("off and on again sets a new mark; a change between two ways of delivering keeps it", async () => {
  const { db, clock } = await world();
  await deliver(db, "push");
  const first = await file(db, "first");
  await clock.advance(DAY);
  await move(db, first, "done");
  expect(await candidates(db)).toEqual([first]);

  await clock.advance(DAY);
  await deliver(db, "none");
  expect(await since(db)).toBeNull();
  expect(await candidates(db)).toEqual([]);
  const whileOff = await file(db, "finished while off");
  await clock.advance(DAY);
  await move(db, whileOff, "done");

  await clock.advance(DAY);
  await deliver(db, "pull_request");
  const mark = T0 + 4 * DAY;
  expect(await since(db)).toBe(mark);
  // Neither the ticket delivered before, nor the one finished while delivery was off.
  expect(await candidates(db)).toEqual([]);
  const third = await file(db, "third");
  await clock.advance(DAY);
  await move(db, third, "done");
  expect(await candidates(db)).toEqual([third]);

  await clock.advance(DAY);
  await deliver(db, "push");
  await deliver(db, "push", "done");
  expect(await since(db)).toBe(mark);
  expect(await candidates(db)).toEqual([third]);
});

/** A delivery row for `ticket`'s repo, as the job leaves one; replaced in place on a re-run. */
async function recordRow(
  db: Db,
  ticket: string,
  state: "pushed" | "failed",
  startedAt: number,
): Promise<void> {
  unwrap(
    await recordDelivery(db, {
      ticket_id: ticket,
      repo_id: "r1",
      branch: "frm/s1",
      head_sha: "a".repeat(40),
      remote_host: null,
      remote_url: null,
      state,
      pr_url: null,
      pr_number: null,
      error: state === "failed" ? "the push was refused" : null,
      started_at: startedAt,
    }),
  );
}

test("off and on again resurrects no delivery begun before: push, then none, then pull requests", async () => {
  const { db, clock } = await world();
  await deliver(db, "push");
  const pushed = await file(db, "pushed");
  const failed = await file(db, "failed");
  await clock.advance(DAY);
  await move(db, pushed, "done");
  await move(db, failed, "done");
  await recordRow(db, pushed, "pushed", clock.now());
  await recordRow(db, failed, "failed", clock.now());
  expect((await candidates(db)).toSorted()).toEqual(
    [failed, pushed].toSorted(),
  );

  await clock.advance(DAY);
  await deliver(db, "none");
  await clock.advance(DAY);
  await deliver(db, "pull_request");
  // Neither the pushed branch (which would now get a pull request) nor the failed push is retried.
  expect(await candidates(db)).toEqual([]);
  expect(await due(db, pushed)).toBe(false);
  expect(await due(db, failed)).toBe(false);
});

test("a delivery begun under the current mark keeps its ticket due, however long ago it reached its moment", async () => {
  const { db, clock } = await world();
  const old = await file(db, "done long ago", "done");
  await clock.advance(DAY);
  await deliver(db, "pull_request");
  // A row from before the mark is history…
  await recordRow(db, old, "failed", T0);
  expect(await candidates(db)).toEqual([]);
  // …one begun since — what 047's backfill leaves for a delivery in flight — is the sweep's to finish.
  await clock.advance(DAY);
  await recordRow(db, old, "pushed", clock.now());
  expect(await candidates(db)).toEqual([old]);
  expect(await due(db, old)).toBe(true);
});

test("a delivering project no writer marked delivers nothing new", async () => {
  const { db, clock } = await world();
  unwrap(
    await updateRowForTest(db, "workspaces", PROJECT, {
      delivery_mode: "push",
      delivery_since: null,
    }),
  );
  const ticket = await file(db, "unmarked");
  await clock.advance(DAY);
  await move(db, ticket, "done");
  expect(await candidates(db)).toEqual([]);
  expect(await due(db, ticket)).toBe(false);
  // Saving delivery once marks it, and from then on it delivers.
  await deliver(db, "push", "done");
  expect(await since(db)).toBe(T0 + DAY);
  await move(db, ticket, "rework");
  await move(db, ticket, "done");
  expect(await candidates(db)).toEqual([ticket]);
});

test("a patch that leaves delivery alone leaves the mark alone", async () => {
  const { db, clock } = await world();
  await deliver(db, "push");
  await clock.advance(DAY);
  unwrap(
    await setProjectSettings(db, PROJECT, { staff_approval: true }, "operator"),
  );
  expect(await since(db)).toBe(T0);
});
