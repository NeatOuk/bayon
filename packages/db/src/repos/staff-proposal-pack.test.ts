import { FakeClock, ok } from "@bayon/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  OPERATOR,
  SPINE_SEED,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
  type TempDb,
} from "../testing.js";
import { getContextPackInputs } from "./context-pack.js";
import { hasPulseWork } from "./pulse-reads.js";
import { answerStaffProposal } from "./staff-proposal-answer.js";
import { staffTicket } from "./staffing.js";
import type { Decide } from "./ticket-transition.js";
import { listNeedsAttention } from "./work-views.js";

// What a pulse reads while a ticket's staffing proposal is open: the ticket's pending
// hand-off (like its unstaffed and failed-spawn rows) waits on the operator, so the pack neither
// lists it as staffing to do nor flags the ticket, and shows the proposal among the human requests
// instead. The operator's attention view is unchanged. The answer puts the rows back.

const NOW = Date.UTC(2026, 8, 22, 12);
const allow: Decide = () => ok(undefined);
const HASH = "0".repeat(64);

let t: TempDb;

const agent = (id: string, kind: "builder" | "orchestrator") => ({
  id,
  name: id,
  kind,
  runner_id: SPINE_SEED.runnerId,
  executor_id: SPINE_SEED.executorId,
  workspace_id: "P-A",
  created_at: 1,
});

beforeEach(async () => {
  t = unwrap(await tempDb(new FakeClock(NOW)));
  unwrap(await seedSpine(t.db, 4));
  unwrap(
    await seedRows(t.db, {
      workspaces: [
        { id: "P-A", name: "alpha", kind: "single", staff_approval: 1 },
      ],
      agents: [agent("O-A", "orchestrator"), agent("A-1", "builder")],
      // A building ticket whose last session handed off: its successor is the next staffing.
      tickets: [ticketRow(1, { status: "building", workspace_id: "P-A" })],
      handoffs: [
        {
          id: "H-1",
          ticket_id: "ticket-1",
          reason: "turn_ceiling",
          facts_json: "{}",
          packet_path: "/tmp/H-1.md",
          packet_hash: HASH,
          quality: "full",
          created_at: 5,
        },
      ],
      sessions: [
        {
          ...newSessionInput(),
          id: "S-OA",
          agent_id: "O-A",
          role: "orchestrator",
          state: "running",
          created_at: 0,
        },
      ],
      pulses: [
        {
          id: "PA",
          agent_id: "O-A",
          trigger: "cron",
          scheduled_at: NOW,
          state: "running",
          lease_token: "lease-PA",
          lease_expires_at: NOW + 60_000,
        },
      ],
    }),
  );
});
afterEach(() => t.cleanup());

const pack = async () =>
  unwrap(await getContextPackInputs(t.db, { agentId: "O-A", pulseId: "PA" }));
const whys = (p: Awaited<ReturnType<typeof pack>>) =>
  p.attention.map((g) => g.why);

test("an open proposal takes its ticket's hand-off out of the pack and the no-op check, not out of the attention view", async () => {
  const before = await pack();
  expect(whys(before)).toContain("handoff_pending");
  expect(before.handoffs.rows.map((h) => h.id)).toEqual(["H-1"]);
  expect(before.tickets.rows).toMatchObject([
    { num: 1, handoff_pending: true },
  ]);

  const proposed = unwrap(
    await staffTicket(
      t.db,
      {
        ticket_id: "ticket-1",
        role: "builder",
        by: { actor_kind: "session", actor_id: "S-OA" },
      },
      allow,
    ),
  );
  expect(proposed).toMatchObject({
    reason: "approval_pending",
    proposal: { run_class: "build", handoff_id: "H-1" },
  });
  const id =
    proposed.kind === "refused" ? (proposed.proposal?.request_id ?? "") : "";

  const during = await pack();
  expect(whys(during)).not.toContain("handoff_pending");
  expect(during.handoffs).toEqual({ total: 0, rows: [] });
  expect(during.tickets.rows).toMatchObject([
    { num: 1, handoff_pending: false },
  ]);
  expect(during.human_requests.rows).toMatchObject([
    {
      id,
      kind: "staff_approval",
      question: "Staff FRM-1 with A-1 (builder, build)?",
      ticket_num: 1,
    },
  ]);
  expect(unwrap(await hasPulseWork(t.db, NOW, null))).toBe(false);
  // The operator still sees the hand-off waiting.
  expect(
    unwrap(await listNeedsAttention(t.db)).map((r) => [r.why, r.ref]),
  ).toContainEqual(["handoff_pending", "H-1"]);

  // Rejected, the proposal is no longer open: the hand-off is staffing to do again.
  unwrap(
    await answerStaffProposal(
      t.db,
      { id, decision: "reject", answered_by: "operator", by: OPERATOR },
      allow,
    ),
  );
  const after = await pack();
  expect(whys(after)).toContain("handoff_pending");
  expect(after.handoffs.rows.map((h) => h.id)).toEqual(["H-1"]);
  expect(after.human_requests.rows).toEqual([]);
});
