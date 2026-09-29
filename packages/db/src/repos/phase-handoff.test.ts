import {
  FakeClock,
  err,
  ok,
  phaseBoundary,
  type SessionState,
} from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { all, qb, read } from "../connection.js";
import {
  OPERATOR,
  SPINE_SEED,
  newSessionInput,
  newTicketInput,
  seedRows,
  tempDb,
  seedSpine,
  unwrap,
} from "../testing.js";
import { insertCommand } from "./commands.js";
import { createSession, updateSessionState } from "./sessions.js";
import { staffTicket } from "./staffing.js";
import { createTicket } from "./ticket-writes.js";
import { transitionTicket } from "./ticket-transition.js";
import {
  PHASE_CHANGE,
  askedPhaseHandoff,
  phaseHandoffKey,
  type PlanHandoff,
} from "./phase-handoff.js";

// an earlier change decision 2: the API fires the phase-boundary hand-off inside the transition's own
// transaction, as a third effect beside the patch and the gates. Invariant 5 holds literally —
// what lands here is a `commands` row; the supervisor claims it and writes sessions and handoffs.

const clock = new FakeClock(1_700_000_000_000);
const t = unwrap(await tempDb(clock));
unwrap(await seedSpine(t.db, 3));
afterAll(() => t.cleanup());

const allow = () => ok(undefined);

/** A ticket in `status`, held by a live `runClass` session of `role`. */
async function held(
  status: string,
  runClass: string,
  o: {
    readonly role?: string;
    readonly state?: SessionState;
    readonly tier?: string;
  } = {},
) {
  const ticket = unwrap(
    await createTicket(
      t.db,
      { ...newTicketInput(), status, complexity_tier: o.tier ?? "standard" },
      OPERATOR,
    ),
  );
  const session = unwrap(
    await createSession(t.db, {
      ...newSessionInput(),
      role: o.role ?? "builder",
      run_class: runClass,
      ticket_id: ticket.id,
    }),
  );
  unwrap(
    await updateSessionState(t.db, session.id, {
      from: ["pending"],
      to: o.state ?? "running",
    }),
  );
  return { ticket, session };
}

/** The plan the API builds: core's phaseBoundary against the status the move lands on. */
const planFor =
  (landed: string, tier = "standard"): PlanHandoff =>
  (holder) =>
    phaseBoundary(
      holder.run_class,
      landed as Parameters<typeof phaseBoundary>[1],
      tier,
    );

const handoffCommands = async (sessionId: string) =>
  unwrap(
    await read(t.db, (ix) =>
      all(
        ix,
        qb
          .selectFrom("commands")
          .selectAll()
          .where("type", "=", "session.handoff")
          .where(
            (eb) =>
              eb.fn<string | null>("json_extract", [
                eb.ref("payload_json"),
                eb.val("$.session_id"),
              ]),
            "=",
            sessionId,
          )
          .orderBy("ts")
          .orderBy("id"),
      ),
    ),
  );

/** The ticket's version as stored: a refused transition must not have bumped it. */
const storedVersion = async (id: string) =>
  unwrap(
    await read(t.db, (ix) => {
      const rows = all(
        ix,
        qb.selectFrom("tickets").select("version").where("id", "=", id),
      );
      return rows[0]?.version ?? 0;
    }),
  );

test("a phase boundary ships one session.handoff with the move, naming the phase it hands on to", async () => {
  const { ticket, session } = await held("spiking", "spike");
  // trivial ticket: submit_plan lands on `planned`, past plan_review.
  const txns = t.db.stats.txns;
  const moved = unwrap(
    await transitionTicket(
      t.db,
      {
        id: ticket.id,
        version: ticket.version,
        to: "plan_review",
        advanceTo: "planned",
        by: OPERATOR,
      },
      allow,
      undefined,
      undefined,
      planFor("planned"),
    ),
  );
  // One transaction: the status and the release commit together or not at all.
  expect(t.db.stats.txns).toBe(txns + 1);
  expect(moved.status).toBe("planned");
  const commands = await handoffCommands(session.id);
  expect(commands).toHaveLength(1);
  expect(JSON.parse(commands[0]?.payload_json ?? "null")).toEqual({
    session_id: session.id,
    reason: PHASE_CHANGE,
    phase_to: "build",
  });
  expect(commands[0]?.state).toBe("pending");
  expect(commands[0]?.idempotency_key).toBe(
    phaseHandoffKey(session.id, moved.version),
  );
});

test("a boundary into a waiting room names no next phase: a gate decides it, not this move", async () => {
  const { ticket, session } = await held("building", "build");
  unwrap(
    await transitionTicket(
      t.db,
      {
        id: ticket.id,
        version: ticket.version,
        to: "code_review",
        by: OPERATOR,
      },
      allow,
      undefined,
      undefined,
      planFor("code_review"),
    ),
  );
  const commands = await handoffCommands(session.id);
  expect(commands).toHaveLength(1);
  expect(JSON.parse(commands[0]?.payload_json ?? "null")).toEqual({
    session_id: session.id,
    reason: PHASE_CHANGE,
  });
});

test("a move inside one phase releases nobody", async () => {
  const { ticket, session } = await held("planned", "build");
  unwrap(
    await transitionTicket(
      t.db,
      { id: ticket.id, version: ticket.version, to: "building", by: OPERATOR },
      allow,
      undefined,
      undefined,
      planFor("building"),
    ),
  );
  expect(await handoffCommands(session.id)).toEqual([]);
});

test("a move into a status no session holds releases nobody: the end path already covers it", async () => {
  // `block` lands in UNHELD_STATUSES, so holdsTicket is false and the session's own end writes the
  // degraded row. Firing here too would leave two hand-off rows for one ending.
  const { ticket, session } = await held("building", "build");
  unwrap(
    await transitionTicket(
      t.db,
      {
        id: ticket.id,
        version: ticket.version,
        to: "blocked",
        by: OPERATOR,
        patch: { blocked_reason: "CI is down" },
      },
      allow,
      undefined,
      undefined,
      planFor("blocked"),
    ),
  );
  expect(await handoffCommands(session.id)).toEqual([]);
});

test("a reviewer on the ticket is never released: it holds no ticket (HOLDING_ROLES)", async () => {
  const { ticket, session } = await held("building", "build", {
    role: "reviewer",
  });
  unwrap(
    await transitionTicket(
      t.db,
      {
        id: ticket.id,
        version: ticket.version,
        to: "code_review",
        by: OPERATOR,
      },
      allow,
      undefined,
      undefined,
      planFor("code_review"),
    ),
  );
  expect(await handoffCommands(session.id)).toEqual([]);
});

test("an ended holder is not released: there is nothing live to hand off", async () => {
  const { ticket, session } = await held("building", "build", {
    state: "running",
  });
  unwrap(
    await updateSessionState(t.db, session.id, {
      from: ["running"],
      to: "stopping",
    }),
  );
  unwrap(
    await updateSessionState(t.db, session.id, {
      from: ["stopping"],
      to: "exited",
    }),
  );
  unwrap(
    await transitionTicket(
      t.db,
      {
        id: ticket.id,
        version: ticket.version,
        to: "code_review",
        by: OPERATOR,
      },
      allow,
      undefined,
      undefined,
      planFor("code_review"),
    ),
  );
  expect(await handoffCommands(session.id)).toEqual([]);
});

test("a refused transition writes no command: the roll-back takes the release with it", async () => {
  const { ticket, session } = await held("building", "build");
  const refused = await transitionTicket(
    t.db,
    { id: ticket.id, version: ticket.version, to: "code_review", by: OPERATOR },
    () =>
      err({ class: "law_refused", message: "no", retryable: false } as const),
    undefined,
    undefined,
    planFor("code_review"),
  );
  expect(refused).toMatchObject({ ok: false });
  expect(await handoffCommands(session.id)).toEqual([]);
  expect(await storedVersion(ticket.id)).toBe(ticket.version);
});

test("a gate plan that fails rolls the release back with the move", async () => {
  const { ticket, session } = await held("building", "build");
  const failed = await transitionTicket(
    t.db,
    { id: ticket.id, version: ticket.version, to: "code_review", by: OPERATOR },
    allow,
    undefined,
    () => err({ class: "internal", message: "no gates", retryable: false }),
    planFor("code_review"),
  );
  expect(failed).toMatchObject({ ok: false });
  expect(await handoffCommands(session.id)).toEqual([]);
});

test("the idempotency key reuses a command already stored under it, never inserting a second", async () => {
  const { ticket, session } = await held("building", "build");
  // Whatever put it there (a redelivery, a half-seen commit), the key is what stops the double.
  const first = unwrap(
    await insertCommand(t.db, {
      type: "session.handoff",
      payload: { session_id: session.id, reason: PHASE_CHANGE },
      idempotencyKey: phaseHandoffKey(session.id, ticket.version + 1),
    }),
  );
  expect(first.created).toBe(true);
  unwrap(
    await transitionTicket(
      t.db,
      {
        id: ticket.id,
        version: ticket.version,
        to: "code_review",
        by: OPERATOR,
      },
      allow,
      undefined,
      undefined,
      planFor("code_review"),
    ),
  );
  const commands = await handoffCommands(session.id);
  expect(commands).toHaveLength(1);
  expect(commands[0]?.id).toBe(first.id);
});

test("two boundaries on one session key differently, so the guard never swallows a real one", async () => {
  const { session } = await held("building", "build");
  expect(phaseHandoffKey(session.id, 2)).not.toBe(
    phaseHandoffKey(session.id, 3),
  );
});

test("no plan, no release: every caller that passes none behaves exactly as before", async () => {
  const { ticket, session } = await held("building", "build");
  unwrap(
    await transitionTicket(
      t.db,
      {
        id: ticket.id,
        version: ticket.version,
        to: "code_review",
        by: OPERATOR,
      },
      allow,
    ),
  );
  expect(await handoffCommands(session.id)).toEqual([]);
});

test("a complex ticket's build phase is build_complex, and a build session there is at a boundary", async () => {
  const { ticket, session } = await held("planned", "build", {
    tier: "complex",
  });
  unwrap(
    await transitionTicket(
      t.db,
      { id: ticket.id, version: ticket.version, to: "building", by: OPERATOR },
      allow,
      undefined,
      undefined,
      planFor("building", "complex"),
    ),
  );
  const commands = await handoffCommands(session.id);
  expect(commands).toHaveLength(1);
  expect(JSON.parse(commands[0]?.payload_json ?? "null")).toMatchObject({
    phase_to: "build_complex",
  });
});

// "Done when", and second half: a trivial ticket whose plan has just been
// advanced to `planned` reaches a staffed build with no operator write. Both halves of the route
// are here — the release the transition ships, and the staffing it unblocks.
test("the whole route: a trivial ticket's plan lands, its spike session is released, a build is staffed", async () => {
  const agent = `agent-${Date.now().toString(36)}`;
  unwrap(
    await seedRows(t.db, {
      agents: [
        {
          id: agent,
          name: agent,
          kind: "builder",
          runner_id: SPINE_SEED.runnerId,
          executor_id: SPINE_SEED.executorId,
          max_concurrency: 4,
          created_at: 0,
        },
      ],
    }),
  );
  const { ticket, session } = await held("spiking", "spike");
  const staff = {
    ticket_id: ticket.id,
    role: "builder" as const,
    by: OPERATOR,
  };

  // Before: the spike session still holds the ticket, so the next phase can never be staffed.
  // This is the bug — nothing in the repo ever nulls sessions.ticket_id or ends an idle session.
  expect(unwrap(await staffTicket(t.db, staff, allow))).toMatchObject({
    kind: "refused",
    reason: "not_staffable",
  });

  // submit_plan on a trivial ticket lands on `planned`, past plan_review.
  const moved = unwrap(
    await transitionTicket(
      t.db,
      {
        id: ticket.id,
        version: ticket.version,
        to: "plan_review",
        advanceTo: "planned",
        by: OPERATOR,
      },
      allow,
      undefined,
      undefined,
      planFor("planned"),
    ),
  );
  expect(moved.status).toBe("planned");
  expect(await handoffCommands(session.id)).toHaveLength(1);

  // The supervisor's half, played by hand: the session hands off and ends.
  unwrap(
    await seedRows(t.db, {
      handoffs: [
        {
          id: `h-${session.id}`,
          ticket_id: ticket.id,
          from_session_id: session.id,
          reason: PHASE_CHANGE,
          phase_from: "spike",
          phase_to: "build",
          facts_json: "{}",
          quality: "full",
          packet_path: ".foreman/handoff-1.md",
          packet_hash: "h",
          created_at: 1,
        },
      ],
    }),
  );
  unwrap(
    await updateSessionState(t.db, session.id, {
      from: ["running"],
      to: "handed_off",
    }),
  );

  // After: staffed, as the build class the status asks for, carrying the packet to accept.
  const staffed = unwrap(await staffTicket(t.db, staff, allow));
  expect(staffed).toMatchObject({ kind: "staffed", created: true });
  expect(staffed.kind === "staffed" ? staffed.payload : null).toMatchObject({
    run_class: "build",
    ticket_id: ticket.id,
    handoff_id: `h-${session.id}`,
  });
  // No operator write moved it: the ticket is still where the plan left it.
  expect(await storedVersion(ticket.id)).toBe(moved.version);
});

// The AWAITING_STATUSES guard, at the writer rather than in core's unit test: a pending hand-off at
// a review status must not let a pulse staff a worker while the reviewers are still running.
test("a pending hand-off in a waiting room does not reopen the ticket", async () => {
  const { ticket, session } = await held("building", "build");
  unwrap(
    await transitionTicket(
      t.db,
      {
        id: ticket.id,
        version: ticket.version,
        to: "code_review",
        by: OPERATOR,
      },
      allow,
      undefined,
      undefined,
      planFor("code_review"),
    ),
  );
  unwrap(
    await seedRows(t.db, {
      handoffs: [
        {
          id: `h2-${session.id}`,
          ticket_id: ticket.id,
          from_session_id: session.id,
          reason: PHASE_CHANGE,
          facts_json: "{}",
          quality: "full",
          packet_path: ".foreman/handoff-1.md",
          packet_hash: "h",
          created_at: 1,
        },
      ],
    }),
  );
  unwrap(
    await updateSessionState(t.db, session.id, {
      from: ["running"],
      to: "handed_off",
    }),
  );
  expect(
    unwrap(
      await staffTicket(
        t.db,
        { ticket_id: ticket.id, role: "builder", by: OPERATOR },
        allow,
      ),
    ),
  ).toMatchObject({ kind: "refused", reason: "not_staffable" });
});

// an earlier change review HIGH. The supervisor re-derives a lost boundary on every reconciler pass, and
// this row is the one thing it reads back: proof that a transition asked for the release at all.
// Without it the sweep would release holders nobody ever asked it to — a session whose class
// simply never matched its ticket's status is not stranded, it is working.
test("askedPhaseHandoff: true once a transition inserted the release, false for a holder nobody asked about", async () => {
  const { ticket, session } = await held("spiking", "spike");
  expect(unwrap(await askedPhaseHandoff(t.db, session.id))).toBe(false);
  unwrap(
    await transitionTicket(
      t.db,
      {
        id: ticket.id,
        version: ticket.version,
        to: "plan_review",
        by: OPERATOR,
      },
      allow,
      undefined,
      undefined,
      planFor("plan_review"),
    ),
  );
  expect(unwrap(await askedPhaseHandoff(t.db, session.id))).toBe(true);
});

test("askedPhaseHandoff: a session.handoff for another reason, or another session, is not an ask", async () => {
  const { session } = await held("building", "build");
  const other = await held("building", "build");
  unwrap(
    await insertCommand(t.db, {
      type: "session.handoff",
      payload: { session_id: session.id, reason: "operator" },
    }),
  );
  unwrap(
    await insertCommand(t.db, {
      type: "session.handoff",
      payload: { session_id: other.session.id, reason: PHASE_CHANGE },
    }),
  );
  expect(unwrap(await askedPhaseHandoff(t.db, session.id))).toBe(false);
  expect(unwrap(await askedPhaseHandoff(t.db, other.session.id))).toBe(true);
});
