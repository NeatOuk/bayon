// The gate's reviewer pick scoped to the ticket's project, over a real temp DB and no
// processes: which reviewer agent a gate's session would take, and on which runner.
import { FakeClock } from "@bayon/core";
import { getGate, getTicket, type Db } from "@bayon/db";
import {
  SPINE_SEED,
  modelRow,
  putRoleBinding,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
  updateRowForTest,
  type TempDb,
} from "@bayon/db/testing";
import type { RunnerAdapter } from "@bayon/runners";
import { createFixtureAdapter } from "@bayon/runners/fixture";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chooseReviewer, type ReviewerPickResult } from "./pick.js";

const T0 = Date.UTC(2026, 8, 21, 12);
const RUNNERS = ["runner-a", "runner-b", "runner-c"] as const;

let t: TempDb;

/** A live certificate of `runner_id` on the spine's executor, for its model of `tier`. */
const certified = (runner_id: string, tier: "cheap" | "complex" = "cheap") => ({
  runner_id,
  executor_id: SPINE_SEED.executorId,
  model_id: `${runner_id}.${tier}`,
  model: `${runner_id}-${tier}-model`,
  runner_version: "1",
  suite_version: "test",
  kit_hash: "k",
  caps_hash: "c",
  result_json: "{}",
  gate_eligible: 1,
  passed_at: T0,
  certified_at: T0,
});
const reviewer = (
  id: string,
  runner_id: string,
  workspace_id: string | null,
  o: object = {},
) => ({
  id,
  name: id,
  kind: "reviewer" as const,
  runner_id,
  executor_id: SPINE_SEED.executorId,
  workspace_id,
  created_at: 0,
  ...o,
});
/** Tickets by number: 1 in P-A, 2 in P-B, 3 in P-C (no reviewers), 4 in P-D, 5 in none. */
const PROJECT_OF = ["P-A", "P-B", "P-C", "P-D", null] as const;

beforeEach(async () => {
  t = unwrap(await tempDb(new FakeClock(T0)));
  unwrap(await seedSpine(t.db, 4));
  unwrap(
    await seedRows(t.db, {
      runners: RUNNERS.map((id) => ({
        id,
        kind: "script",
        adapter: "fixture",
        caps_json: "{}",
      })),
      workspaces: ["P-A", "P-B", "P-C", "P-D"].map((id) => ({
        id,
        name: id,
        kind: "single" as const,
      })),
      agents: [
        // P-A reviews on runner-b only, a runner the binding does not name.
        reviewer("R-A", "runner-b", "P-A"),
        reviewer("R-B", "runner-a", "P-B"),
        // With no project, and first by id: a pick that ignored projects would take it.
        reviewer("R-0", "runner-a", null),
        // P-D has a reviewer of its own, switched off.
        reviewer("R-D", "runner-c", "P-D", { enabled: 0 }),
      ],
      tickets: PROJECT_OF.map((workspace_id, i) =>
        ticketRow(i + 1, { status: "plan_review", workspace_id }),
      ),
      gates: PROJECT_OF.map((_, i) => ({
        id: `G-${i + 1}`,
        ticket_id: `ticket-${i + 1}`,
        kind: "plan_review" as const,
        state: "running" as const,
        subject_kind: "plan",
        subject_ref: "docs/plan.md",
      })),
      models: RUNNERS.flatMap((id) => [
        modelRow(id, "cheap"),
        modelRow(id, "complex"),
      ]),
      runner_certifications: RUNNERS.map((id) => certified(id)),
      // The binding's tier decides the model every reviewer of the role runs.
      role_bindings: [
        {
          role: "plan_reviewer",
          runner_id: "runner-a",
          model_tier: "cheap",
          updated_at: 0,
        },
      ],
    }),
  );
});
afterEach(() => t.cleanup());

/** Every runner "loaded": the pick asks only whether one is, and its caps. */
function adapters(): ReadonlyMap<string, RunnerAdapter> {
  const fixture = createFixtureAdapter({ clock: new FakeClock(T0) });
  return new Map(RUNNERS.map((id) => [id, fixture]));
}

async function pick(db: Db, num: number): Promise<ReviewerPickResult> {
  return unwrap(
    await chooseReviewer({
      db,
      adapters: adapters(),
      gate: unwrap(await getGate(db, `G-${num}`)),
      ticket: unwrap(await getTicket(db, `ticket-${num}`)),
      requireDistinct: false,
      defaultExecutor: SPINE_SEED.executorId,
    }),
  );
}

const found = (r: ReviewerPickResult) =>
  r.found === null
    ? r.detail
    : { runner: r.found.runnerId, agent: r.found.agentId };

describe("a gate's reviewer comes from its ticket's project", () => {
  test("a project with its own reviewers is reviewed by them, on their runner, though the binding names another", async () => {
    expect(found(await pick(t.db, 1))).toEqual({
      runner: "runner-b",
      agent: "R-A",
    });
  });

  test("never by the reviewers with no project, nor another project's, on the same runner", async () => {
    expect(found(await pick(t.db, 2))).toEqual({
      runner: "runner-a",
      agent: "R-B",
    });
  });

  test("a project with no reviewer of its own is reviewed by the ones with no project, under the binding", async () => {
    expect(found(await pick(t.db, 3))).toEqual({
      runner: "runner-a",
      agent: "R-0",
    });
  });

  test("a project whose only reviewer is off gets no_reviewer, not another project's", async () => {
    const r = await pick(t.db, 4);
    expect(r.found).toBeNull();
    expect(found(r)).toBe(
      "plan_reviewer on local (project P-D's reviewer runners): runner-c: no reviewer agent",
    );
  });

  test("a ticket with no project keeps today's pick: the binding's runner, its first reviewer by id", async () => {
    expect(found(await pick(t.db, 5))).toEqual({
      runner: "runner-a",
      agent: "R-0",
    });
  });

  test("the binding's runner goes first among a project's own", async () => {
    unwrap(
      await seedRows(t.db, {
        agents: [reviewer("R-A2", "runner-a", "P-A")],
      }),
    );
    expect(found(await pick(t.db, 1))).toEqual({
      runner: "runner-a",
      agent: "R-A2",
    });
  });
});

describe("the reviewer is certified for the model it would run", () => {
  const bindTier = async (model_tier: string | null) => {
    unwrap(
      await putRoleBinding(
        t.db,
        { role: "plan_reviewer", runner_id: "runner-a", model_tier },
        "operator",
      ),
    );
  };

  test("a binding on complex with only a cheap certificate finds nobody, naming the model", async () => {
    await bindTier("complex");
    const r = await pick(t.db, 5);
    expect(r.found).toBeNull();
    expect(found(r)).toBe(
      "plan_reviewer on local (bound to runner-a): runner-a (model runner-a-complex-model): not certified here",
    );
  });

  test("certified on complex too, the pick takes it and hands the spawn that model's binding", async () => {
    await bindTier("complex");
    unwrap(
      await seedRows(t.db, {
        runner_certifications: [certified("runner-a", "complex")],
      }),
    );
    const r = await pick(t.db, 5);
    expect(r.found).toMatchObject({
      runnerId: "runner-a",
      agentId: "R-0",
      bindingRole: "plan_reviewer",
      modelId: "runner-a.complex",
    });
  });

  test("no tier on the binding: the reviewer agent's profile decides the model", async () => {
    await bindTier(null);
    unwrap(
      await seedRows(t.db, {
        profiles: [
          {
            id: "PR-COMPLEX",
            name: "PR-COMPLEX",
            runner_id: "runner-a",
            model_tier: "complex",
            version: 1,
            hash: "h",
            created_at: 0,
          },
        ],
      }),
    );
    unwrap(
      await updateRowForTest(t.db, "agents", "R-0", {
        profile_id: "PR-COMPLEX",
      }),
    );
    // Its profile runs complex, and only cheap is certified.
    expect(found(await pick(t.db, 5))).toBe(
      "plan_reviewer on local (bound to runner-a): runner-a (model runner-a-complex-model): not certified here",
    );
    unwrap(
      await seedRows(t.db, {
        runner_certifications: [certified("runner-a", "complex")],
      }),
    );
    expect((await pick(t.db, 5)).found).toMatchObject({
      runnerId: "runner-a",
      modelId: "runner-a.complex",
    });
  });
});

describe("the project's review tier decides the reviewer's model", () => {
  const bindTier = async (model_tier: string | null) => {
    unwrap(
      await putRoleBinding(
        t.db,
        { role: "plan_reviewer", runner_id: "runner-a", model_tier },
        "operator",
      ),
    );
  };
  const reviewTier = async (project: string, review_tier: "complex" | null) => {
    unwrap(
      await updateRowForTest(t.db, "workspaces", project, { review_tier }),
    );
  };

  test("P-B reviews on complex: only cheap certified finds nobody, naming the complex model; certified, it is picked", async () => {
    await bindTier(null);
    await reviewTier("P-B", "complex");
    expect(found(await pick(t.db, 2))).toBe(
      "plan_reviewer on local (project P-B's reviewer runners): runner-a (model runner-a-complex-model): not certified here",
    );
    unwrap(
      await seedRows(t.db, {
        runner_certifications: [certified("runner-a", "complex")],
      }),
    );
    expect((await pick(t.db, 2)).found).toMatchObject({
      runnerId: "runner-a",
      agentId: "R-B",
      bindingRole: "plan_reviewer",
      modelId: "runner-a.complex",
    });
  });

  test("a review-tier model certified but not gate-eligible is refused as such", async () => {
    await bindTier(null);
    await reviewTier("P-B", "complex");
    unwrap(
      await seedRows(t.db, {
        runner_certifications: [
          { ...certified("runner-a", "complex"), gate_eligible: 0 },
        ],
      }),
    );
    expect(found(await pick(t.db, 2))).toBe(
      "plan_reviewer on local (project P-B's reviewer runners): runner-a (model runner-a-complex-model): not gate-eligible",
    );
  });

  test("the binding's own tier wins over the project's review tier", async () => {
    await bindTier("cheap");
    await reviewTier("P-B", "complex");
    expect((await pick(t.db, 2)).found).toMatchObject({
      runnerId: "runner-a",
      modelId: "runner-a.cheap",
    });
  });

  test("the project the session is placed in decides, when the gate names one; else the ticket's", async () => {
    await bindTier(null);
    await reviewTier("P-B", "complex");
    unwrap(
      await seedRows(t.db, {
        runner_certifications: [certified("runner-a", "complex")],
      }),
    );
    // Ticket 5 has no project: no review tier, and R-0 has no profile, so no model to run.
    expect((await pick(t.db, 5)).found).toBeNull();
    const placed = unwrap(
      await chooseReviewer({
        db: t.db,
        adapters: adapters(),
        gate: unwrap(await getGate(t.db, "G-5")),
        ticket: unwrap(await getTicket(t.db, "ticket-5")),
        requireDistinct: false,
        defaultExecutor: SPINE_SEED.executorId,
        workspaceId: "P-B",
      }),
    );
    expect(placed.found).toMatchObject({
      runnerId: "runner-a",
      agentId: "R-0",
      modelId: "runner-a.complex",
    });
  });
});

describe("context compression: the pick asks for the certificate its session needs", () => {
  /** Every runner loaded, each declaring context compression on a local executor. */
  function compressing(): ReadonlyMap<string, RunnerAdapter> {
    const fixture = createFixtureAdapter({ clock: new FakeClock(T0) });
    const adapter: RunnerAdapter = {
      ...fixture,
      compressesContext: (ex) => ex.kind === "local",
    };
    return new Map(RUNNERS.map((id) => [id, adapter]));
  }
  const pickWith = async (
    runners: ReadonlyMap<string, RunnerAdapter>,
    num: number,
  ): Promise<ReviewerPickResult> =>
    unwrap(
      await chooseReviewer({
        db: t.db,
        adapters: runners,
        gate: unwrap(await getGate(t.db, `G-${num}`)),
        ticket: unwrap(await getTicket(t.db, `ticket-${num}`)),
        requireDistinct: false,
        defaultExecutor: SPINE_SEED.executorId,
      }),
    );

  test("a project that compresses, on a runner that compresses: its compression-off certificate does not stand in", async () => {
    unwrap(
      await updateRowForTest(t.db, "workspaces", "P-B", {
        context_compression: 1,
      }),
    );
    const none = await pickWith(compressing(), 2);
    expect(none.found).toBeNull();
    expect(found(none)).toContain(
      "runner-a (model runner-a-cheap-model, context compression): not certified here",
    );
    expect(none.found === null && none.considered?.runners).toContainEqual({
      runner_id: "runner-a",
      model: "runner-a-cheap-model",
      compression: true,
      why: ["not_certified"],
    });

    unwrap(
      await seedRows(t.db, {
        runner_certifications: [{ ...certified("runner-a"), compression: 1 }],
      }),
    );
    expect(found(await pickWith(compressing(), 2))).toEqual({
      runner: "runner-a",
      agent: "R-B",
    });
  });

  test("a project that does not compress, or a runner that does not, is picked on the compression-off certificate", async () => {
    // P-B off, runners that compress: the normal certificate.
    expect(found(await pickWith(compressing(), 2))).toEqual({
      runner: "runner-a",
      agent: "R-B",
    });
    // P-B on, the fixture as it is (no declaration): its sessions run uncompressed.
    unwrap(
      await updateRowForTest(t.db, "workspaces", "P-B", {
        context_compression: 1,
      }),
    );
    expect(found(await pick(t.db, 2))).toEqual({
      runner: "runner-a",
      agent: "R-B",
    });
  });
});
