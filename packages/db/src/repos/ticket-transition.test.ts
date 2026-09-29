import { FakeClock, err, ok, type FrmError } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { openDb } from "../connection.js";
import {
  OPERATOR,
  SPINE_SEED,
  newTicketInput,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
} from "../testing.js";
import { listTicketEvents } from "./ticket-events.js";
import { transitionTicket, type TransitionFacts } from "./ticket-transition.js";
import {
  createTicket,
  updateTicketCas,
  type TicketPatch,
} from "./ticket-writes.js";
import { getTicket } from "./tickets.js";

const clock = new FakeClock(1_700_000_000_000);
const t = unwrap(await tempDb(clock));
unwrap(await seedSpine(t.db, 3));
afterAll(() => t.cleanup());

const allow = () => ok(undefined);
const validation = { ok: false, error: { class: "validation" } };
const backlog = async () =>
  unwrap(await createTicket(t.db, newTicketInput(), OPERATOR));
const events = async (id: string) =>
  unwrap(await listTicketEvents(t.db, { ticket_id: id, since: 0, limit: 100 }))
    .rows;

test("transitionTicket sets the status, bumps the version and writes the transition event, in one transaction", async () => {
  const ticket = await backlog();
  await clock.advance(1000);
  const txns = t.db.stats.txns;
  const moved = unwrap(
    await transitionTicket(
      t.db,
      {
        id: ticket.id,
        version: 1,
        to: "prioritized",
        by: { ...OPERATOR, reason: "top of the list" },
        payload: { evidence: ["plan.md"] },
      },
      allow,
    ),
  );
  expect(t.db.stats.txns).toBe(txns + 1);
  expect(moved).toEqual({
    ...ticket,
    status: "prioritized",
    version: 2,
    updated_at: clock.now(),
  });
  expect((await events(ticket.id)).at(-1)).toMatchObject({
    kind: "transition",
    from_status: "backlog",
    to_status: "prioritized",
    actor_kind: "operator",
    actor_id: OPERATOR.actor_id,
    reason: "top of the list",
    payload_json: '{"evidence":["plan.md"]}',
    ts: clock.now(),
  });
});

test("transitionTicket applies the request's patch with the status", async () => {
  const ticket = await backlog();
  const moved = unwrap(
    await transitionTicket(
      t.db,
      {
        id: ticket.id,
        version: 1,
        to: "blocked",
        by: OPERATOR,
        patch: { blocked_reason: "CI is down", unblock_condition: "CI is up" },
      },
      allow,
    ),
  );
  expect(moved).toMatchObject({
    status: "blocked",
    blocked_reason: "CI is down",
    unblock_condition: "CI is up",
    version: 2,
  });
});

test("a refusal from decide rolls the whole transition back and comes back unchanged", async () => {
  const ticket = await backlog();
  const refusal: FrmError = {
    class: "validation",
    message: "the law says no",
    retryable: false,
    cause: { rule: "fixture" },
  };
  expect(
    await transitionTicket(
      t.db,
      { id: ticket.id, version: 1, to: "done", by: OPERATOR },
      () => err(refusal),
    ),
  ).toEqual({ ok: false, error: refusal });
  expect(unwrap(await getTicket(t.db, ticket.id))).toEqual(ticket);
  expect((await events(ticket.id)).map((e) => e.kind)).toEqual(["created"]);
});

test("decide reads the ticket, the request and the ticket's facts inside the transaction", async () => {
  const parent = await backlog();
  const child = unwrap(
    await createTicket(
      t.db,
      newTicketInput({ parent_ticket_id: parent.id }),
      OPERATOR,
    ),
  );
  unwrap(
    await seedRows(t.db, {
      repos: [{ id: "repo-1", name: "repo-1", mirror_path: "/m/repo-1" }],
      workspaces: [{ id: "ws-1", name: "ws-1", kind: "single" }],
      worktrees: [
        {
          id: "wt-1",
          session_root: "/w",
          workspace_id: "ws-1",
          repo_id: "repo-1",
          path: "/w/repo-1",
          branch: "agent/1",
          base_sha: "0".repeat(40),
          ticket_id: parent.id,
          state: "active",
          created_at: 0,
        },
      ],
      gates: [
        {
          id: "g-1",
          ticket_id: parent.id,
          kind: "plan_review",
          state: "passed",
          subject_kind: "plan",
          subject_ref: "plan.md",
        },
      ],
    }),
  );
  const owned = unwrap(
    await updateTicketCas(t.db, {
      id: parent.id,
      version: 1,
      patch: { owner_session_id: SPINE_SEED.sessionId },
      by: OPERATOR,
    }),
  );
  let seen: unknown;
  unwrap(
    await transitionTicket(
      t.db,
      { id: parent.id, version: owned.version, to: "split", by: OPERATOR },
      (facts: TransitionFacts, req) => {
        seen = {
          status: facts.ticket.status,
          version: facts.ticket.version,
          to: req.to,
          gates: facts.gates().map((g) => g.id),
          children: facts.children().map((c) => c.id),
          worktrees: facts.worktrees().map((w) => w.id),
          owner: facts.ownerSession()?.id ?? null,
        };
        return ok(undefined);
      },
    ),
  );
  expect(seen).toEqual({
    status: "backlog",
    version: 2,
    to: "split",
    gates: ["g-1"],
    children: [child.id],
    worktrees: ["wt-1"],
    owner: SPINE_SEED.sessionId,
  });
});

test("the facts of a ticket with none are empty", async () => {
  const ticket = await backlog();
  let seen: unknown;
  unwrap(
    await transitionTicket(
      t.db,
      { id: ticket.id, version: 1, to: "parked", by: OPERATOR },
      (facts) => {
        seen = [
          facts.gates(),
          facts.children(),
          facts.worktrees(),
          facts.ownerSession(),
        ];
        return ok(undefined);
      },
    ),
  );
  expect(seen).toEqual([[], [], [], null]);
});

test("a stale version is a conflict naming the current version, and decide never runs", async () => {
  const ticket = await backlog();
  unwrap(
    await updateTicketCas(t.db, {
      id: ticket.id,
      version: 1,
      patch: { priority: 2 },
      by: OPERATOR,
    }),
  );
  let ran = false;
  const stale = await transitionTicket(
    t.db,
    { id: ticket.id, version: 1, to: "prioritized", by: OPERATOR },
    () => {
      ran = true;
      return ok(undefined);
    },
  );
  expect(stale).toMatchObject({
    ok: false,
    error: { class: "conflict", cause: { current_version: 2 } },
  });
  expect(ran).toBe(false);
});

test("an unknown ticket is not_found", async () => {
  expect(
    await transitionTicket(
      t.db,
      { id: "nope", version: 1, to: "done", by: OPERATOR },
      allow,
    ),
  ).toMatchObject({ ok: false, error: { class: "not_found" } });
});

test("a bad request is a validation error: empty to, bad version, or a patch with status, managed or derived columns", async () => {
  const ticket = await backlog();
  const base = { id: ticket.id, version: 1, to: "done", by: OPERATOR };
  for (const req of [
    { ...base, to: "" },
    { ...base, version: 0 },
    { ...base, patch: { status: "done" } as unknown as TicketPatch },
    { ...base, patch: { version: 5 } as unknown as TicketPatch },
    { ...base, patch: { handoff_count: 1 } as unknown as TicketPatch },
  ]) {
    expect(
      await transitionTicket(t.db, req, allow),
      JSON.stringify(req),
    ).toMatchObject(validation);
  }
});

test("two connections move the same version: exactly one wins, the other is a conflict", async () => {
  const ticket = await backlog();
  const other = unwrap(await openDb({ path: t.path, clock }));
  try {
    const results = await Promise.all([
      transitionTicket(
        t.db,
        { id: ticket.id, version: 1, to: "prioritized", by: OPERATOR },
        allow,
      ),
      transitionTicket(
        other,
        { id: ticket.id, version: 1, to: "parked", by: OPERATOR },
        allow,
      ),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toMatchObject([
      { ok: false, error: { class: "conflict" } },
    ]);
    expect((await events(ticket.id)).map((e) => e.kind)).toEqual([
      "created",
      "transition",
    ]);
  } finally {
    unwrap(await other.close());
  }
});
