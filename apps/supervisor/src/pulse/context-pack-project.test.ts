// A project's orchestrator's context pack, rendered and written as a pulse compiles it,
// against a real temp database: its header names the project, and nothing in it names another
// project's ticket. A fleet orchestrator's header keeps its old lines (context-pack.test.ts).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, TEMPLATES } from "@bayon/core";
import {
  SPINE_SEED,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "@bayon/db/testing";
import { afterEach, expect, test } from "vitest";
import { buildContextPack } from "./context-pack.js";

const T0 = Date.UTC(2026, 8, 21, 12);
const H = 3_600_000;
const clock = new FakeClock(T0);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const orchestrator = (id: string, workspace_id: string | null) => ({
  id,
  name: id,
  kind: "orchestrator" as const,
  runner_id: SPINE_SEED.runnerId,
  workspace_id,
  created_at: 0,
});
const pulse = (id: string, agent_id: string) => ({
  id,
  agent_id,
  trigger: "cron" as const,
  scheduled_at: T0,
  state: "running" as const,
  lease_token: `lease-${id}`,
  lease_expires_at: T0 + H,
});

async function setup() {
  const t = unwrap(await tempDb(clock));
  const home = mkdtempSync(join(tmpdir(), "bayon-pack-project-"));
  cleanups.push(() => {
    t.cleanup();
    rmSync(home, { recursive: true, force: true });
  });
  unwrap(await seedSpine(t.db, 4));
  unwrap(
    await seedRows(t.db, {
      workspaces: [
        { id: "P-A", name: "alpha", kind: "single" },
        { id: "P-B", name: "beta", kind: "single" },
      ],
      agents: [orchestrator("orch-a", "P-A"), orchestrator("orch-f", null)],
      tickets: [
        ticketRow(1, {
          status: "building",
          workspace_id: "P-A",
          title: "Alpha ledger export",
        }),
        ticketRow(2, {
          status: "prioritized",
          workspace_id: "P-B",
          title: "Beta invoice queue",
        }),
        ticketRow(3, { status: "prioritized", title: "Unfiled cleanup" }),
      ],
      pulses: [pulse("PA", "orch-a"), pulse("PF", "orch-f")],
    }),
  );
  return { db: t.db, home };
}

test("a project's pack names its project in the header and shows none of another project's tickets", async () => {
  const s = await setup();
  const pack = unwrap(
    await buildContextPack(
      { db: s.db, frmHome: s.home },
      { agentId: "orch-a", pulseId: "PA", checks: [] },
    ),
  );
  const bytes = readFileSync(pack.path, "utf8");
  expect(bytes).toContain(
    "## Pulse\n- Pulse #1 for orch-a (cron), scheduled 2026-09-21T12:00:00.000Z\n" +
      "- Project: alpha (P-A)\n" +
      "- Since the last pulse: no pulse ran before this one\n",
  );
  expect(bytes).toContain("- Tickets: building 1\n");
  expect(bytes).toContain("Alpha ledger export");
  expect(bytes).not.toContain("Beta invoice queue");
  expect(bytes).not.toContain("Unfiled cleanup");
  expect(bytes).not.toContain("#2");
  expect(bytes).not.toContain("#3");
  // The rule that goes with the line is the template's (invariant 8), not the pack's.
  expect(TEMPLATES.pulse.body).toContain(
    "When the Pulse section names a project, you are that project's orchestrator",
  );
});

test("a fleet orchestrator's pack has no project line and shows every project's tickets", async () => {
  const s = await setup();
  const pack = unwrap(
    await buildContextPack(
      { db: s.db, frmHome: s.home },
      { agentId: "orch-f", pulseId: "PF", checks: [] },
    ),
  );
  const bytes = readFileSync(pack.path, "utf8");
  expect(bytes).not.toContain("- Project:");
  for (const title of [
    "Alpha ledger export",
    "Beta invoice queue",
    "Unfiled cleanup",
  ]) {
    expect(bytes).toContain(title);
  }
});
