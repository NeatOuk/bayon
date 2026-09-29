import { FakeClock, type Actor, type FrmError, type Result } from "@bayon/core";
import { getCommandByIdempotencyKey, listTicketGates } from "@bayon/db";
import { phaseHandoffKey } from "@bayon/db/api";
import {
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "@bayon/db/testing";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { TicketService } from "./ticket-service.js";

// §3.2 L2 end to end: spiking → plan_review through the service, against real git worktrees
// under the work root and a real DB. The git facts are gathered before the transaction; a
// change to the worktree set in between is caught inside it.

const root = realpathSync(mkdtempSync("/tmp/frm-"));
const clock = new FakeClock(1_700_000_000_000);
const t = unwrap(await tempDb(clock));
unwrap(await seedSpine(t.db, 3));
unwrap(
  await seedRows(t.db, {
    executors: [{ id: "box", kind: "container", config_json: "{}" }],
    repos: [{ id: "repo-1", name: "repo-1", mirror_path: "/m/repo-1" }],
    workspaces: [{ id: "ws-1", name: "ws-1", kind: "single" }],
  }),
);
afterAll(() => {
  t.cleanup();
  rmSync(root, { recursive: true, force: true });
});

const service = new TicketService({
  db: t.db,
  clock,
  workRoot: join(root, "work"),
});
const PLAN = "docs/spikes/plan.md";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
    {
      cwd,
      encoding: "utf8",
    },
  ).trim();

const value = <T>(result: Result<T>): T => {
  if (!result.ok)
    throw new Error(`${result.error.class}: ${result.error.message}`);
  return result.value;
};
const failure = <T>(result: Result<T>): FrmError => {
  if (result.ok) throw new Error("expected an error");
  return result.error;
};

let n = 0;

/**
 * A spiking ticket, with a plan_path unless `o` says none, held by a live session whose worktree is
 * a real repo.
 */
async function spiking(
  executor = "local",
  o: { readonly plan_path?: string | null; readonly non_trivial?: 0 | 1 } = {},
) {
  n += 1;
  const num = 2_000 + n;
  const id = `ticket-${num}`;
  const session = `s-${n}`;
  const path = join(root, "work", `t${n}`);
  mkdirSync(join(path, "src"), { recursive: true });
  mkdirSync(join(path, "docs", "spikes"), { recursive: true });
  git(path, "init", "-q", "-b", "main");
  writeFileSync(join(path, "src", "a.ts"), "export const a = 1;\n");
  git(path, "add", "-A");
  git(path, "commit", "-q", "-m", "base");
  const base = git(path, "rev-parse", "HEAD");
  unwrap(
    await seedRows(t.db, {
      tickets: [
        ticketRow(num, {
          status: "spiking",
          plan_path: o.plan_path === undefined ? PLAN : o.plan_path,
          non_trivial: o.non_trivial ?? 0,
        }),
      ],
      sessions: [
        {
          ...newSessionInput(),
          id: session,
          ticket_id: id,
          state: "running",
          executor_id: executor,
          created_at: 0,
        },
      ],
      worktrees: [
        {
          id: `wt-${n}`,
          session_root: path,
          workspace_id: "ws-1",
          repo_id: "repo-1",
          path,
          branch: "main",
          base_sha: base,
          ticket_id: id,
          session_id: session,
          state: "active",
          created_at: 0,
        },
      ],
    }),
  );
  const actor: Actor = { kind: "worker", sessionId: session };
  return { ref: String(num), id, session, path, base, actor };
}

const writePlan = (path: string) => writeFileSync(join(path, PLAN), "# plan\n");

/** The `session.handoff` the move at version 1 inserted for `session`, or null. */
const released = async (session: string) => {
  const found = await getCommandByIdempotencyKey(
    t.db,
    phaseHandoffKey(session, 2),
  );
  return found.ok ? found.value : null;
};

describe("spiking → plan_review", () => {
  test("a plan with no source change moves, and its evidence is recorded", async () => {
    const s = await spiking();
    writePlan(s.path);
    const moved = value(
      await service.transition(s.ref, 1, { to: "plan_review" }, s.actor),
    );
    // Trivial: no plan_review round opens, so the plan is approved as it is submitted.
    expect(moved.status).toBe("planned");
    const events = value(await service.events(s.ref, { since: 0, limit: 10 }));
    expect(events.items.at(-1)?.payload).toEqual({
      rule: "submit_plan",
      evidence: {
        plan_path: PLAN,
        worktrees: [
          { id: `wt-${n}`, base_sha: s.base, files: 1, paths: [PLAN] },
        ],
      },
    });
  });

  // the transition also releases the spike session that has just finished its phase,
  // as a `session.handoff` inserted in its own transaction (Invariant 5: the API inserts commands;
  // the supervisor claims them). Without this the ticket sits `planned` and unstaffable for ever.
  test("the spike session that submitted the plan is released, naming the phase it hands on to", async () => {
    const s = await spiking();
    writePlan(s.path);
    value(await service.transition(s.ref, 1, { to: "plan_review" }, s.actor));
    const command = await released(s.session);
    expect(command?.type).toBe("session.handoff");
    expect(JSON.parse(command?.payload_json ?? "null")).toEqual({
      session_id: s.session,
      reason: "phase_change",
      // `planned` asks for the build class; the spike session carries fixture_only.
      phase_to: "build",
    });
  });

  test("a non-trivial ticket's plan rests in plan_review, and releases its spike session too", async () => {
    const s = await spiking("local", { non_trivial: 1 });
    writePlan(s.path);
    const moved = value(
      await service.transition(s.ref, 1, { to: "plan_review" }, s.actor),
    );
    // A plan_review round opened, so the ticket waits there — and the waiting room asks for no run
    // class at all, which is still a boundary: the spike's phase is over either way.
    expect(moved.status).toBe("plan_review");
    expect(
      JSON.parse((await released(s.session))?.payload_json ?? "null"),
    ).toEqual({ session_id: s.session, reason: "phase_change" });
  });

  test("a refused submit_plan releases nobody: the roll-back takes the command with it", async () => {
    const s = await spiking();
    writePlan(s.path);
    writeFileSync(join(s.path, "src", "b.ts"), "export const b = 2;\n");
    failure(await service.transition(s.ref, 1, { to: "plan_review" }, s.actor));
    expect(await released(s.session)).toBeNull();
  });

  test("a source change is refused, naming the file", async () => {
    const s = await spiking();
    writePlan(s.path);
    writeFileSync(join(s.path, "src", "b.ts"), "export const b = 2;\n");
    const refused = failure(
      await service.transition(s.ref, 1, { to: "plan_review" }, s.actor),
    );
    expect(refused).toMatchObject({
      class: "law_refused",
      cause: { rule: "submit_plan", reason: "source_changes" },
    });
    expect(refused.message).toContain("src/b.ts");
  });

  test("no plan file is a missing artifact", async () => {
    const s = await spiking();
    expect(
      failure(
        await service.transition(s.ref, 1, { to: "plan_review" }, s.actor),
      ),
    ).toMatchObject({
      cause: { reason: "missing_artifact" },
    });
  });

  test("a worktree on a container executor is unverifiable", async () => {
    const s = await spiking("box");
    writePlan(s.path);
    expect(
      failure(
        await service.transition(s.ref, 1, { to: "plan_review" }, s.actor),
      ),
    ).toMatchObject({
      cause: { reason: "diff_unverifiable" },
    });
  });

  test("a worktree appearing between the git check and the transaction is refused", async () => {
    const s = await spiking();
    writePlan(s.path);
    const racing = new TicketService({
      db: t.db,
      clock,
      workRoot: join(root, "work"),
      hooks: {
        afterFacts: async () => {
          unwrap(
            await seedRows(t.db, {
              worktrees: [
                {
                  id: `wt-${n}-late`,
                  session_root: s.path,
                  workspace_id: "ws-1",
                  repo_id: "repo-1",
                  path: `${s.path}-late`,
                  branch: "late",
                  base_sha: s.base,
                  ticket_id: s.id,
                  session_id: s.session,
                  state: "active",
                  created_at: 1,
                },
              ],
            }),
          );
        },
      },
    });
    const refused = failure(
      await racing.transition(s.ref, 1, { to: "plan_review" }, s.actor),
    );
    expect(refused).toMatchObject({
      class: "law_refused",
      cause: {
        reason: "diff_unverifiable",
        detail: expect.stringContaining("worktrees changed"),
      },
    });
    expect(value(await service.get(s.ref, s.actor)).ticket.version).toBe(1);
  });
});

// a spike's own plan_path rides with its submit_plan, and the laws judge the row with it
// set, in the one transaction that writes both.
describe("a plan_path set with the move", () => {
  const withPlan = { plan_path: PLAN };

  test("is the one the laws judge: without it the move is refused, with it the ticket moves once", async () => {
    const s = await spiking("local", { plan_path: null });
    writePlan(s.path);
    expect(
      failure(
        await service.transition(s.ref, 1, { to: "plan_review" }, s.actor),
      ),
    ).toMatchObject({ cause: { reason: "missing_artifact" } });
    const moved = value(
      await service.transition(
        s.ref,
        1,
        { to: "plan_review" },
        s.actor,
        undefined,
        withPlan,
      ),
    );
    expect(moved).toMatchObject({
      // Trivial, so the same move carries it on past plan_review.
      status: "planned",
      plan_path: PLAN,
      version: 2,
    });
    const events = value(await service.events(s.ref, { since: 0, limit: 10 }));
    expect(events.items.map((e) => e.kind)).toEqual(["transition"]);
    expect(events.items[0]?.payload).toMatchObject({
      rule: "submit_plan",
      evidence: { plan_path: PLAN },
    });
  });

  test("a source change refuses the move and the plan_path together", async () => {
    const s = await spiking("local", { plan_path: null });
    writePlan(s.path);
    writeFileSync(join(s.path, "src", "b.ts"), "export const b = 2;\n");
    expect(
      failure(
        await service.transition(
          s.ref,
          1,
          { to: "plan_review" },
          s.actor,
          undefined,
          withPlan,
        ),
      ),
    ).toMatchObject({
      class: "law_refused",
      cause: { rule: "submit_plan", reason: "source_changes" },
    });
    expect(value(await service.get(s.ref, s.actor)).ticket).toMatchObject({
      status: "spiking",
      plan_path: null,
      version: 1,
    });
  });

  test("a plan_path naming no file is a missing artifact, even over a stored one that exists", async () => {
    const s = await spiking();
    writePlan(s.path);
    expect(
      failure(
        await service.transition(
          s.ref,
          1,
          { to: "plan_review" },
          s.actor,
          undefined,
          { plan_path: "docs/spikes/other.md" },
        ),
      ),
    ).toMatchObject({
      cause: {
        reason: "missing_artifact",
        detail: expect.stringContaining("docs/spikes/other.md"),
      },
    });
  });

  test("a worker sets it on the ticket its session holds, never another's", async () => {
    const s = await spiking("local", { plan_path: null });
    const other = await spiking("local", { plan_path: null });
    writePlan(s.path);
    expect(
      failure(
        await service.transition(
          s.ref,
          1,
          { to: "plan_review" },
          other.actor,
          undefined,
          withPlan,
        ),
      ),
    ).toMatchObject({
      class: "law_refused",
      cause: { rule: "patch", reason: "cross_ticket_write" },
    });
  });

  test("a non-trivial ticket's plan_review round reviews the plan_path set with the move", async () => {
    const s = await spiking("local", { plan_path: null, non_trivial: 1 });
    writePlan(s.path);
    value(
      await service.transition(
        s.ref,
        1,
        { to: "plan_review" },
        s.actor,
        undefined,
        withPlan,
      ),
    );
    expect(unwrap(await listTicketGates(t.db, s.id))).toEqual([
      expect.objectContaining({
        kind: "plan_review",
        attempt: 1,
        state: "running",
        subject_ref: PLAN,
      }),
    ]);
  });
});

// a trivial ticket opens no plan_review round (M3 amendment c), and approve_plan is the
// only way out of plan_review — so it waited there for a review nobody owed it while paid pulses
// looked on. The same move now carries it to planned; a ticket that does open a round still stops.
describe("a plan that needs no review", () => {
  test("a trivial ticket lands on planned, staffable at once, with no gate open", async () => {
    const s = await spiking();
    writePlan(s.path);
    const moved = value(
      await service.transition(s.ref, 1, { to: "plan_review" }, s.actor),
    );
    expect(moved.status).toBe("planned");
    expect(unwrap(await listTicketGates(t.db, s.id))).toEqual([]);
  });

  test("the event records where it actually went, under the rule that took it", async () => {
    const s = await spiking();
    writePlan(s.path);
    value(await service.transition(s.ref, 1, { to: "plan_review" }, s.actor));
    const events = value(await service.events(s.ref, { since: 0, limit: 10 }));
    expect(events.items.at(-1)).toMatchObject({
      from_status: "spiking",
      to_status: "planned",
      payload: { rule: "submit_plan" },
    });
  });

  test("a non-trivial ticket still stops at plan_review for its review", async () => {
    const s = await spiking("local", { non_trivial: 1 });
    writePlan(s.path);
    const moved = value(
      await service.transition(s.ref, 1, { to: "plan_review" }, s.actor),
    );
    expect(moved.status).toBe("plan_review");
  });
});

describe("the detail view runs no git", () => {
  test("plan_review is offered, deferred to the diff check on submit", async () => {
    const s = await spiking();
    writePlan(s.path);
    const detail = value(await service.get(s.ref, s.actor));
    expect(detail.transitions.find((o) => o.to === "plan_review")).toEqual({
      to: "plan_review",
      rule: "submit_plan",
      allowed: true,
      deferred: ["no_source_changes"],
    });
  });

  test("without the plan file, it is refused with the reason", async () => {
    const s = await spiking();
    const detail = value(await service.get(s.ref, s.actor));
    expect(
      detail.transitions.find((o) => o.to === "plan_review"),
    ).toMatchObject({
      allowed: false,
      reason: "missing_artifact",
    });
  });
});
