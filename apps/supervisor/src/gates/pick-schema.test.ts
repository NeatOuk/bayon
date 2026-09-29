// code_review needs a reviewer with outputSchema (amendment 20, Q1). Every LLM runner the registry
// loads declares it, so each one reviews code on its own and is never `no_reviewer` for want of
// structured output, even when it built the change too (single_runner_review). Over a real temp DB
// and the real adapters' caps, no processes. Runners are found by registration kind, never by name
// (Invariant 1).
import { FakeClock } from "@bayon/core";
import { getGate, getTicket, type Db } from "@bayon/db";
import {
  SPINE_SEED,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import { loadAdapter, registrations, type RunnerAdapter } from "@bayon/runners";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { upsertBootRows } from "../boot.js";
import { chooseReviewer, type ReviewerPickResult } from "./pick.js";

const T0 = Date.UTC(2026, 8, 22, 12);
const LLM_KINDS: ReadonlySet<string> = new Set([
  "llm_sdk",
  "llm_cli",
  "llm_http",
]);
const LLM = registrations().filter((r) => LLM_KINDS.has(r.runner.kind));
const LLM_IDS = LLM.map((r) => r.runner.id);

let t: TempDb;

beforeEach(async () => {
  t = unwrap(await tempDb(new FakeClock(T0)));
  unwrap(await seedSpine(t.db, 4));
  unwrap(await upsertBootRows(t.db, { registrations: LLM }));
});
afterEach(() => t.cleanup());

/** `runnerId`, certified and gate-eligible on the spine's executor, with a reviewer agent. */
async function reviewerOn(db: Db, runnerId: string, builderRunner: string) {
  // The builder first: the ticket names it as its owner.
  unwrap(
    await seedRows(db, {
      sessions: [
        {
          ...newSessionInput(),
          id: "builder-1",
          runner_id: builderRunner,
          state: "idle",
          created_at: 0,
        },
      ],
    }),
  );
  unwrap(
    await seedRows(db, {
      agents: [
        {
          id: "rev-1",
          name: "rev-1",
          kind: "reviewer",
          runner_id: runnerId,
          executor_id: SPINE_SEED.executorId,
          created_at: 0,
        },
      ],
      tickets: [
        ticketRow(1, { status: "code_review", owner_session_id: "builder-1" }),
      ],
      gates: [
        {
          id: "g-code",
          ticket_id: "ticket-1",
          kind: "code_review",
          state: "running",
          attempt: 1,
          subject_kind: "diff",
          subject_ref: "unpinned",
          started_at: T0,
        },
      ],
      runner_certifications: [
        {
          runner_id: runnerId,
          executor_id: SPINE_SEED.executorId,
          model_id: `${runnerId}.cheap`,
          model: "m",
          runner_version: "1",
          suite_version: "test",
          kit_hash: "k",
          caps_hash: "c",
          result_json: "{}",
          gate_eligible: 1,
          passed_at: T0,
          certified_at: T0,
        },
      ],
      role_bindings: [
        // The binding's tier is the model the reviewer runs, and the one certified.
        {
          role: "code_reviewer",
          runner_id: runnerId,
          model_tier: "cheap",
          updated_at: 0,
        },
      ],
    }),
  );
}

/** Every LLM runner loaded, with its real caps: the pick asks only whether one is, and them. */
function adapters(): ReadonlyMap<string, RunnerAdapter> {
  return new Map(LLM_IDS.map((id) => [id, unwrap(loadAdapter(id))]));
}

async function pick(db: Db): Promise<ReviewerPickResult> {
  return unwrap(
    await chooseReviewer({
      db,
      adapters: adapters(),
      gate: unwrap(await getGate(db, "g-code")),
      ticket: unwrap(await getTicket(db, "ticket-1")),
      requireDistinct: false,
      defaultExecutor: SPINE_SEED.executorId,
    }),
  );
}

test("the registry loads LLM runners to review with", () => {
  expect(LLM_IDS.length).toBeGreaterThan(0);
});

describe.each(LLM_IDS)("code_review bound to %s", (runnerId) => {
  test("picks its reviewer agent in schema mode, not no_reviewer", async () => {
    await reviewerOn(t.db, runnerId, SPINE_SEED.runnerId);
    const r = await pick(t.db);
    expect(r.found === null ? r.detail : r.found).toEqual({
      runnerId,
      fallbackFrom: null,
      singleRunnerReview: false,
      outputSchema: true,
      agentId: "rev-1",
      profileId: null,
      executorId: SPINE_SEED.executorId,
      bindingRole: "code_reviewer",
      modelId: `${runnerId}.cheap`,
    });
  });

  test("when it built the change too, it still reviews, flagged single_runner_review", async () => {
    await reviewerOn(t.db, runnerId, runnerId);
    const r = await pick(t.db);
    expect(r.found === null ? r.detail : r.found).toMatchObject({
      runnerId,
      singleRunnerReview: true,
      outputSchema: true,
      agentId: "rev-1",
    });
  });
});
