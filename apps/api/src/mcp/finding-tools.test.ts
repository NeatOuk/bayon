import { FakeClock } from "@bayon/core";
import {
  SPINE_SEED,
  listAudit,
  newSessionInput,
  seedHolders,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "@bayon/db/testing";
import { afterAll, expect, test } from "vitest";
import { finding, gate } from "../gates/fixtures.js";
import { mcpDbStore } from "./db-store.js";
import { findingResolve } from "./finding-tools.js";
import type { ToolCtx } from "./tool-kit.js";

// finding_resolve: the builder's own ticket only, the fixing run derived from
// the caller's open run, a note required; its refusals are the closed MCP reasons.

const t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
unwrap(await seedSpine(t.db, 8));
unwrap(
  await seedRows(t.db, {
    tickets: [
      ticketRow(1, { status: "review_fix" }),
      ticketRow(2, { status: "review_fix" }),
    ],
  }),
);
unwrap(await seedHolders(t.db, [1, 2]));
unwrap(
  await seedRows(t.db, {
    sessions: [
      {
        ...newSessionInput(),
        id: "S-idle",
        state: "idle",
        ticket_id: "ticket-1",
        created_at: 0,
      },
    ],
    gates: [
      gate("g1", 1, { state: "failed" }),
      gate("g2", 2, { state: "failed" }),
    ],
    findings: [finding("f1", "g1"), finding("f2", "g2")],
  }),
);
afterAll(() => t.cleanup());

const store = mcpDbStore(t.db);

const ctx = (sessionId: string, ticketId: string): ToolCtx => {
  const who = {
    id: sessionId,
    role: "builder",
    agentId: SPINE_SEED.agentId,
    agentName: SPINE_SEED.agentName,
    ticketId,
    workspaceId: null,
  };
  return {
    session: { ...who, toolsetHash: null, allowlist: [] },
    actor: { kind: "session", ...who },
    store,
    tickets: undefined,
    docs: undefined,
    audit: (targetKind, targetId) => ({
      actor: `session:${sessionId}`,
      action: "mcp.finding_resolve",
      target_kind: targetKind,
      target_id: targetId,
    }),
  };
};

test("resolves the caller's finding with its open run, audited in the same transaction", async () => {
  const outcome = await findingResolve(ctx("S-1", "ticket-1"), {
    finding: "f1",
    note: "restored the null check",
  });
  expect(outcome).toEqual({
    kind: "ok",
    data: { finding_id: "f1", status: "resolved", resolved_by_run_id: "R-1" },
  });
  expect(
    unwrap(await listAudit(t.db)).map((a) => [a.action, a.target_id]),
  ).toContainEqual(["mcp.finding_resolve", "f1"]);
});

test("a finding on another ticket is refused: cross_ticket_write", async () => {
  expect(
    await findingResolve(ctx("S-1", "ticket-1"), { finding: "f2", note: "x" }),
  ).toMatchObject({
    kind: "refused",
    refusal: { reason: "cross_ticket_write", rule: "finding_resolve" },
  });
});

test("no open run, a resolved finding, an unknown one", async () => {
  expect(
    await findingResolve(ctx("S-idle", "ticket-1"), {
      finding: "f2",
      note: "x",
    }),
  ).toMatchObject({ kind: "refused", refusal: { reason: "missing_evidence" } });
  expect(
    await findingResolve(ctx("S-1", "ticket-1"), {
      finding: "f1",
      note: "again",
    }),
  ).toMatchObject({
    kind: "refused",
    refusal: { reason: "illegal_transition" },
  });
  expect(
    await findingResolve(ctx("S-1", "ticket-1"), {
      finding: "nope",
      note: "x",
    }),
  ).toMatchObject({ kind: "refused", refusal: { reason: "not_found" } });
});
