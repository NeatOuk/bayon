import { FakeClock, ok } from "@bayon/core";
import { getWorkspace, listDeliveryCandidates } from "@bayon/db";
import { createTicket } from "@bayon/db/api";
import {
  OPERATOR,
  newTicketInput,
  seedSpine,
  tempDb,
  transitionTicket,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import type { CreateProjectRequest, DeliveryConfig } from "@bayon/proto";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ProjectsService } from "./projects-service.js";

// the API's two doors that set a project's delivery also mark when it was turned on
// (`workspaces.delivery_since`, 047), and the delivery sweep reads only moments reached from then
// on. One FakeClock drives the database and the service, so every mark is an exact time.

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;

let t: TempDb;
let clock: FakeClock;
let service: ProjectsService;

beforeEach(async () => {
  clock = new FakeClock(T0);
  t = unwrap(await tempDb(clock));
  unwrap(await seedSpine(t.db, 1));
  service = new ProjectsService({
    db: t.db,
    clock,
    mirrorsRoot: "/home/frm/mirrors",
  });
});
afterEach(() => t.cleanup());

const request = (name: string): CreateProjectRequest => ({
  name,
  repo_url: `https://example.com/${name}.git`,
  runner_id: "fixture",
  executor_id: "local",
  orchestrator: false,
  reviewer_runner_id: null,
});

const PUSH: DeliveryConfig = {
  mode: "push",
  when: "review_passed",
  close_on_merge: true,
};
const PR: DeliveryConfig = { ...PUSH, mode: "pull_request" };
const OFF: DeliveryConfig = { ...PUSH, mode: "none" };

const markOf = async (id: string): Promise<number | null> =>
  unwrap(await getWorkspace(t.db, id)).delivery_since;

const patch = async (id: string, delivery: DeliveryConfig): Promise<void> => {
  unwrap(await service.patch(id, { delivery }));
};

test("create marks a project that delivers from its own creation, and leaves one that does not unmarked", async () => {
  const quiet = unwrap(await service.create(request("quiet")));
  expect(await markOf(quiet.workspace_id)).toBeNull();
  const off = unwrap(
    await service.create({ ...request("off"), delivery: OFF }),
  );
  expect(await markOf(off.workspace_id)).toBeNull();

  await clock.advance(DAY);
  const on = unwrap(await service.create({ ...request("on"), delivery: PR }));
  expect(await markOf(on.workspace_id)).toBe(T0 + DAY);
});

test("PATCH sets the mark as delivery turns on, keeps it between modes, clears it off, and sets a new one on again", async () => {
  const id = unwrap(await service.create(request("demo"))).workspace_id;

  await clock.advance(DAY);
  await patch(id, PUSH);
  expect(await markOf(id)).toBe(T0 + DAY);

  await clock.advance(DAY);
  await patch(id, PR);
  await patch(id, { ...PR, when: "done", close_on_merge: false });
  unwrap(await service.patch(id, { staff_approval: true }));
  expect(await markOf(id)).toBe(T0 + DAY);

  await clock.advance(DAY);
  await patch(id, OFF);
  expect(await markOf(id)).toBeNull();

  await clock.advance(DAY);
  await patch(id, PR);
  expect(await markOf(id)).toBe(T0 + 4 * DAY);
});

test("the bug: turning pull requests on for a project with finished work delivers none of it", async () => {
  const id = unwrap(await service.create(request("history"))).workspace_id;
  unwrap(
    await createTicket(
      t.db,
      newTicketInput({ title: "long done", status: "done", workspace_id: id }),
      OPERATOR,
    ),
  );
  await clock.advance(9 * DAY);

  await patch(id, PR);
  const page = () => listDeliveryCandidates(t.db, { limit: 10, after: null });
  expect(unwrap(await page())).toEqual([]);

  // Work that reaches its moment afterwards is delivered, as it always was.
  const fresh = unwrap(
    await createTicket(
      t.db,
      newTicketInput({ title: "new", status: "code_review", workspace_id: id }),
      OPERATOR,
    ),
  );
  await clock.advance(DAY);
  unwrap(
    await transitionTicket(
      t.db,
      { id: fresh.id, version: fresh.version, to: "qa_harness", by: OPERATOR },
      () => ok(undefined),
    ),
  );
  expect(unwrap(await page()).map((c) => c.id)).toEqual([fresh.id]);
});
