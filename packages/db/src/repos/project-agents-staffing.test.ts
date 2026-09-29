// The M5 proof for, against a real temp SQLite file: a project whose two builders, on
// two runners, were both added through `createProjectAgent` (POST /projects/:id/agents) is staffed
// across both (scope), and one disabled through `setAgentFromApi` (PATCH /agents/:id)
// takes no more work — the project waits (`no_agent`) rather than borrow.
import { FakeClock, ok, projectAgentProfile, type FrmError } from "@bayon/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  OPERATOR,
  listCommands,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
  type TempDb,
} from "../testing.js";
import { createProjectAgent } from "./agent-create.js";
import { setAgentFromApi } from "./agent-set.js";
import { claimCommand, completeCommand } from "./commands.js";
import { staffTicket } from "./staffing.js";
import type { Decide } from "./ticket-transition.js";

const NOW = Date.UTC(2026, 8, 21, 12);
const allow: Decide = () => ok(undefined);
const runner = (id: string) => ({
  id,
  kind: "script",
  adapter: "fixture",
  caps_json: "{}",
});

let t: TempDb;
beforeEach(async () => {
  t = unwrap(await tempDb(new FakeClock(NOW)));
  // The spine's unscoped builder is free all along: a project that borrowed would take it.
  unwrap(await seedSpine(t.db, 4));
  unwrap(
    await seedRows(t.db, {
      runners: [runner("runner-a"), runner("runner-b")],
      workspaces: [{ id: "shop", name: "shop", kind: "single" }],
      // The binding names one runner; a project's own builders are not narrowed by it.
      role_bindings: [
        { role: "builder", runner_id: "runner-a", updated_at: 0 },
      ],
      tickets: [1, 2, 3].map((num) =>
        ticketRow(num, { status: "prioritized", workspace_id: "shop" }),
      ),
    }),
  );
});
afterEach(() => t.cleanup());

async function addBuilder(runnerId: string): Promise<string> {
  const created = unwrap(
    await createProjectAgent(t.db, {
      workspace: "shop",
      kind: "builder",
      runner: runnerId,
      profile: {
        ...projectAgentProfile({
          workspace: "shop",
          kind: "builder",
          runner: runnerId,
        }),
        version: 1,
        hash: "0".repeat(64),
        created_at: NOW,
      },
    }),
  );
  return created.agent.id;
}

async function staff(num: number) {
  return unwrap(
    await staffTicket(
      t.db,
      { ticket_id: `ticket-${num}`, role: "builder", by: OPERATOR },
      allow,
    ),
  );
}

async function staffedAgent(num: number): Promise<string> {
  const r = await staff(num);
  if (r.kind !== "staffed") throw new Error(`${r.reason}: ${r.detail}`);
  return (r.payload as { agent_id: string }).agent_id;
}

const SPAWN_FAILED: FrmError = {
  class: "spawn_failed",
  message: "the test ends this spawn",
  retryable: false,
};

/** Claims every queued spawn, then fails `agentId`'s: its slot is free, the others stay held. */
async function freeSlotOf(agentId: string): Promise<void> {
  for (;;) {
    const claimed = unwrap(await claimCommand(t.db));
    if (claimed === null) return;
    const payload = JSON.parse(claimed.payload_json) as { agent_id: string };
    if (payload.agent_id === agentId) {
      unwrap(
        await completeCommand(t.db, claimed.id, {
          state: "failed",
          error: SPAWN_FAILED,
        }),
      );
    }
  }
}

test("two builders on two runners, added over the API, take the project's tickets; one disabled over the API leaves the next one no_agent", async () => {
  const onA = await addBuilder("runner-a");
  const onB = await addBuilder("runner-b");
  expect([onA, onB]).toEqual(["shop-builder-1", "shop-builder-2"]);

  // Two tickets, two builders, two runners.
  expect(await staffedAgent(1)).toBe(onA);
  expect(await staffedAgent(2)).toBe(onB);

  // A's slot freed, then A disabled: B is busy with ticket 2, so the project has no free builder.
  await freeSlotOf(onA);
  expect(
    unwrap(await setAgentFromApi(t.db, onA, { enabled: false })),
  ).toMatchObject({ changed: true, to: { enabled: 0 } });
  const spawnsBefore = unwrap(await listCommands(t.db)).length;
  const refused = await staff(3);
  expect(refused).toMatchObject({ kind: "refused", reason: "no_agent" });
  expect(unwrap(await listCommands(t.db))).toHaveLength(spawnsBefore);

  // The control: A enabled again takes the same ticket — it was the switch, not the slot.
  unwrap(await setAgentFromApi(t.db, onA, { enabled: true }));
  expect(await staffedAgent(3)).toBe(onA);
});

test("sized to 0 over the API, a builder takes nothing either", async () => {
  const onA = await addBuilder("runner-a");
  const onB = await addBuilder("runner-b");
  expect(await staffedAgent(1)).toBe(onA);
  unwrap(await setAgentFromApi(t.db, onB, { max_concurrency: 0 }));
  expect(await staff(2)).toMatchObject({ kind: "refused", reason: "no_agent" });
});
