import { FakeClock, STAFFABLE_STATUSES, ok } from "@bayon/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  OPERATOR,
  SPINE_SEED,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
  updateRowForTest,
  type TempDb,
} from "../testing.js";
import { PULSE_ARMS } from "../schema-work.js";
import { claimCommand, requeueClaimedCommands } from "./commands.js";
import { hasPulseWork } from "./pulse-reads.js";
import { staffTicket } from "./staffing.js";
import { getTicket } from "./tickets.js";
import type { Decide } from "./ticket-transition.js";
import { listNeedsAttention } from "./work-views.js";

// ticket_staff moves the ticket and queues its session.spawn in one transaction, so a
// spawn that fails before createSessionRow leaves a ticket out of `prioritized` that nothing owns
// and nothing lists — §13.1's "exactly one of a live owner, a pending hand-off, or a terminal
// status" broken with no arm to show it. 021 adds `spawn_failed`, and it is a pulse arm because
// re-staffing is the whole repair: these tests drive the real mechanism (claim, claim, claim, the
// reconciler's requeue) rather than hand-writing a failed row, and then re-staff for real.

const NOW = Date.UTC(2026, 8, 13, 12);
const allow: Decide = () => ok(undefined);
const AUDIT = { actor: "session:S-O", action: "mcp.ticket_staff" };
/** The supervisor's requeue as the reconciler calls it: session.spawn is idempotent, 3 attempts. */
const REQUEUE = {
  claimedBefore: NOW,
  idempotentTypes: ["session.spawn"],
  knownTypes: ["session.spawn"],
  exclude: [],
  maxAttempts: 3,
  why: "the supervisor died holding it",
};

let t: TempDb;

beforeEach(async () => {
  t = unwrap(await tempDb(new FakeClock(NOW)));
  unwrap(await seedSpine(t.db, 12));
  // The spine's idle session neither holds a builder slot nor ages into `stale_session`, so every
  // arm these tests see is one they put there.
  unwrap(
    await updateRowForTest(t.db, "sessions", SPINE_SEED.sessionId, {
      state: "exited",
      exit_reason: "ok",
    }),
  );
  unwrap(
    await seedRows(t.db, {
      agents: [
        {
          id: "B1",
          name: "B1",
          kind: "builder",
          runner_id: SPINE_SEED.runnerId,
          executor_id: SPINE_SEED.executorId,
          created_at: 1,
        },
      ],
      tickets: [ticketRow(1, { status: "prioritized" })],
    }),
  );
});
afterEach(() => t.cleanup());

async function staffed(num: number) {
  const outcome = unwrap(
    await staffTicket(
      t.db,
      { ticket_id: `ticket-${num}`, role: "builder", by: OPERATOR },
      allow,
      AUDIT,
    ),
  );
  if (outcome.kind !== "staffed") {
    throw new Error(`staffing refused: ${outcome.reason}: ${outcome.detail}`);
  }
  return outcome;
}

/**
 * The bug, played out: the supervisor claims the spawn and dies before `createSessionRow`, three
 * times, and the reconciler gives up on it. Resolves to the command left terminally failed.
 */
async function supervisorDiesOnIt(commandId: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const claimed = unwrap(
      await claimCommand(t.db, { types: ["session.spawn"] }),
    );
    expect(claimed?.id).toBe(commandId);
    unwrap(await requeueClaimedCommands(t.db, REQUEUE));
  }
}

const arms = async () => unwrap(await listNeedsAttention(t.db));

test("a spawn the supervisor died on strands its ticket, and 021 is what shows it", async () => {
  const { command_id } = await staffed(1);
  expect(unwrap(await getTicket(t.db, "ticket-1")).status).toBe("staffed");
  // Before the failure the ticket is legitimately in flight: a queued spawn, and no arm.
  expect(await arms()).toEqual([]);

  await supervisorDiesOnIt(command_id);

  // The stranded state, exactly as the ticket describes it: staffed, unowned, no session row.
  const ticket = unwrap(await getTicket(t.db, "ticket-1"));
  expect(ticket.status).toBe("staffed");
  expect(ticket.owner_session_id).toBeNull();
  // One arm, and it is the new one: nothing else in the view had anything to say about it.
  expect(await arms()).toEqual([
    { why: "spawn_failed", ref: command_id, ticket_id: "ticket-1" },
  ]);
});

test("the stranded ticket is worth a pulse, and the pulse's own tool can fix it", async () => {
  const { command_id } = await staffed(1);
  await supervisorDiesOnIt(command_id);
  // A pulse arm, so §9.7's free no-op check wakes the orchestrator for it (and this is the only
  // row in the view, so the true below can come from nothing else).
  expect(PULSE_ARMS).toContain("spawn_failed");
  expect(await arms()).toHaveLength(1);
  expect(unwrap(await hasPulseWork(t.db, NOW))).toBe(true);

  // The Done-when: re-staffed, not merely visible. No session row was ever written, so staffing's
  // live-holder guard has nothing to find and does not refuse (this is what makes an earlier change
  // independent of, whose case is an *idle session* still holding its ticket).
  const again = await staffed(1);
  expect(again.command_id).not.toBe(command_id);
  expect(again.created).toBe(true);
  // The newest spawn is pending again, so the arm clears itself — the ticket is back in flight.
  expect(await arms()).toEqual([]);
  expect(unwrap(await getTicket(t.db, "ticket-1")).status).toBe("staffed");
});

test("a spawn that got as far as its session row is not this arm's business", async () => {
  const { command_id, payload } = await staffed(1);
  const sessionId = (payload as { session_id: string }).session_id;
  unwrap(
    await seedRows(t.db, {
      sessions: [
        {
          id: sessionId,
          agent_id: "B1",
          ticket_id: "ticket-1",
          role: "builder",
          run_class: SPINE_SEED.runClass,
          runner_id: SPINE_SEED.runnerId,
          executor_id: SPINE_SEED.executorId,
          session_root: "/tmp/bayon-fixture/work",
          home_dir: "/tmp/bayon-fixture/home",
          config_hash: "0".repeat(64),
          raw_log_path: "/tmp/bayon-fixture/raw.jsonl",
          mcp_token_hash: "1".repeat(64),
          state: "exited",
          exit_reason: "error",
          created_at: NOW,
        },
      ],
    }),
  );
  await supervisorDiesOnIt(command_id);
  // abort edge owns this case: a session row means a run, a terminal and a degraded
  // hand-off, which `handoff_pending` carries. Listing it here would double-report it.
  expect(await arms()).toEqual([]);
});

test("a live session on the ticket outranks an older failed spawn", async () => {
  const { command_id, payload } = await staffed(1);
  await supervisorDiesOnIt(command_id);
  expect(await arms()).toHaveLength(1);
  // Something is working the ticket after all (a resumed session, an operator's own spawn): the
  // arm is about a ticket nothing holds, so it goes quiet.
  unwrap(
    await seedRows(t.db, {
      sessions: [
        {
          id: `${(payload as { session_id: string }).session_id}-other`,
          agent_id: "B1",
          ticket_id: "ticket-1",
          role: "builder",
          run_class: SPINE_SEED.runClass,
          runner_id: SPINE_SEED.runnerId,
          executor_id: SPINE_SEED.executorId,
          session_root: "/tmp/bayon-fixture/work",
          home_dir: "/tmp/bayon-fixture/home",
          config_hash: "0".repeat(64),
          raw_log_path: "/tmp/bayon-fixture/raw.jsonl",
          mcp_token_hash: "2".repeat(64),
          state: "running",
          created_at: NOW,
        },
      ],
    }),
  );
  expect(await arms()).toEqual([]);
});

test("every staffable status but prioritized strands the same way, and every one is listed", async () => {
  // Staffing a `building` or `review_fix` ticket moves no status at all, so the reverting fix would
  // have had nothing to revert: the arm has to take the whole staffable set. `prioritized` is left
  // to `unstaffed_ready`, which already had it, so the two arms never double-report one ticket.
  const statuses = STAFFABLE_STATUSES.filter((s) => s !== "prioritized");
  const nums = statuses.map((_, i) => i + 10);
  unwrap(
    await seedRows(t.db, {
      tickets: statuses.map((status, i) =>
        ticketRow(nums[i] ?? 0, { status, complexity_tier: "standard" }),
      ),
      agents: statuses.map((_, i) => ({
        id: `B${i + 2}`,
        name: `B${i + 2}`,
        kind: "builder" as const,
        runner_id: SPINE_SEED.runnerId,
        executor_id: SPINE_SEED.executorId,
        created_at: i + 2,
      })),
    }),
  );
  const ids: string[] = [];
  for (const num of nums) {
    const { command_id } = await staffed(num);
    ids.push(command_id);
  }
  // Three rounds of the reconciler giving up: every claimed spawn fails `interrupted` together.
  for (let round = 0; round < 3; round += 1) {
    for (let i = 0; i < ids.length; i += 1) {
      const claimed = unwrap(
        await claimCommand(t.db, { types: ["session.spawn"] }),
      );
      expect(claimed).not.toBeNull();
    }
    unwrap(await requeueClaimedCommands(t.db, REQUEUE));
  }
  const listed = (await arms())
    .filter((row) => row.why === "spawn_failed")
    .map((row) => row.ticket_id);
  expect(listed.toSorted()).toEqual(nums.map((n) => `ticket-${n}`).toSorted());
});

test("a prioritized ticket whose spawn failed stays unstaffed_ready, and is listed once", async () => {
  // Nothing moves a ticket back to `prioritized` today, but if a law ever did, the two arms must
  // not both claim it: `spawn_failed` excludes the status `unstaffed_ready` owns.
  const { command_id } = await staffed(1);
  await supervisorDiesOnIt(command_id);
  unwrap(
    await seedRows(t.db, {
      tickets: [ticketRow(2, { status: "prioritized" })],
    }),
  );
  const listed = await arms();
  expect(listed.filter((row) => row.ticket_id === "ticket-2")).toEqual([
    { why: "unstaffed_ready", ref: "ticket-2", ticket_id: "ticket-2" },
  ]);
});
