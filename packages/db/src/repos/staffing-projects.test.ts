import { FakeClock, ok } from "@bayon/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  OPERATOR,
  SPINE_SEED,
  listCommands,
  newSessionInput,
  seedRows,
  tempDb,
  seedSpine,
  ticketRow,
  unwrap,
  type TempDb,
} from "../testing.js";
import {
  listReviewerAgents,
  listUtilAgents,
  projectReviewerRunners,
} from "./gates.js";
import { staffTicket, type StaffTicketRequest } from "./staffing.js";
import { listTicketEvents } from "./ticket-events.js";
import type { Decide } from "./ticket-transition.js";
import { getTicket } from "./tickets.js";

// Staffing scoped to the ticket's project, against a real temp SQLite file. Projects
// P-A and P-B each have a builder; U-1 has no project and is the oldest, so a staffing that ignored
// the project would take it (or A's) first. seedSpine's agent-fixture holds a live session.

const NOW = Date.UTC(2026, 8, 21, 12);
const allow: Decide = () => ok(undefined);

let t: TempDb;

const runner = (id: string) => ({
  id,
  kind: "script",
  adapter: "fixture",
  caps_json: "{}",
});
const workspace = (id: string) => ({ id, name: id, kind: "single" as const });
const agent = (
  id: string,
  created_at: number,
  workspace_id: string | null,
  o: object = {},
) => ({
  id,
  name: id,
  kind: "builder" as const,
  runner_id: SPINE_SEED.runnerId,
  executor_id: SPINE_SEED.executorId,
  workspace_id,
  created_at,
  ...o,
});
const WORKSPACE_OF: Readonly<Record<string, string | null>> = {
  "U-1": null,
  "A-1": "P-A",
  "B-1": "P-B",
  "B-2": "P-B",
  "C-R": "P-C",
};

beforeEach(async () => {
  t = unwrap(await tempDb(new FakeClock(NOW)));
  unwrap(await seedSpine(t.db, 4));
  unwrap(
    await seedRows(t.db, {
      runners: [runner("runner-a"), runner("runner-b"), runner("runner-c")],
      workspaces: [workspace("P-A"), workspace("P-B"), workspace("P-C")],
      tickets: [
        ticketRow(1, { status: "prioritized", workspace_id: "P-B" }),
        ticketRow(2, { status: "prioritized", workspace_id: "P-A" }),
        ticketRow(3, { status: "prioritized" }),
        // P-C has a reviewer but no builder of its own.
        ticketRow(4, { status: "prioritized", workspace_id: "P-C" }),
      ],
    }),
  );
});
afterEach(() => t.cleanup());

const seedAgents = (b1: object = {}, extra: readonly object[] = []) =>
  seedRows(t.db, {
    agents: [
      agent("U-1", 0, null),
      agent("A-1", 1, "P-A", { runner_id: "runner-a" }),
      agent("B-1", 2, "P-B", { runner_id: "runner-b", ...b1 }),
      agent("C-R", 3, "P-C", { kind: "reviewer" as const }),
      ...(extra as ReturnType<typeof agent>[]),
    ],
  });

/** A live session on `agentId`: it holds one of the agent's slots. */
const occupy = (...agentIds: readonly string[]) =>
  seedRows(t.db, {
    sessions: agentIds.map((agent_id, i) => ({
      ...newSessionInput(),
      id: `S-BUSY-${i}`,
      agent_id,
      state: "running" as const,
      created_at: 0,
    })),
  });

const bind = (runner_id: string) =>
  seedRows(t.db, {
    role_bindings: [{ role: "builder", runner_id, updated_at: 0 }],
  });

const staff = (num: number, o: Partial<StaffTicketRequest> = {}) =>
  staffTicket(
    t.db,
    { ticket_id: `ticket-${num}`, role: "builder", by: OPERATOR, ...o },
    allow,
  );

const spawnAgents = async (): Promise<string[]> =>
  unwrap(await listCommands(t.db))
    .filter((c) => c.type === "session.spawn")
    .map((c) => (JSON.parse(c.payload_json) as { agent_id: string }).agent_id);

async function staffedWith(num: number, o: Partial<StaffTicketRequest> = {}) {
  const r = unwrap(await staff(num, o));
  if (r.kind !== "staffed") throw new Error(`${r.reason}: ${r.detail}`);
  return r.payload as { agent_id: string; workspace_id?: string };
}

async function refusal(num: number, o: Partial<StaffTicketRequest> = {}) {
  const r = unwrap(await staff(num, o));
  if (r.kind !== "refused") throw new Error("expected a refusal");
  return r;
}

describe("a project ticket is staffed only by its project's agents", () => {
  test("B's builder at max_concurrency: B's ticket is no_agent with no command, though A's builder and an unscoped one are free", async () => {
    unwrap(await seedAgents());
    unwrap(await occupy("B-1"));
    const r = await refusal(1);
    expect(r.reason).toBe("no_agent");
    expect(r.detail).toContain("P-B");
    expect(await spawnAgents()).toEqual([]);
    expect(unwrap(await getTicket(t.db, "ticket-1")).status).toBe(
      "prioritized",
    );
    // A's builder was free all along: it takes A's ticket.
    expect((await staffedWith(2)).agent_id).toBe("A-1");
  });

  const B2 = agent("B-2", 4, "P-B", { runner_id: "runner-a" });
  test.each<
    [
      string,
      {
        readonly b1?: object;
        readonly extra?: readonly object[];
        readonly busy?: readonly string[];
        readonly agent?: string;
      },
      string | null,
    ]
  >([
    ["free: B's own builder", {}, "B-1"],
    ["busy: B's only builder is full", { busy: ["B-1"] }, null],
    ["disabled: B's only builder is off", { b1: { enabled: 0 } }, null],
    [
      "a second slot: max_concurrency 2 takes a second ticket",
      { b1: { max_concurrency: 2 }, busy: ["B-1"] },
      "B-1",
    ],
    [
      "mixed runners: B's older builder is full, its younger one on another runner takes it",
      { extra: [B2], busy: ["B-1"] },
      "B-2",
    ],
    ["named: B's own builder", { agent: "B-1" }, "B-1"],
    [
      "named: B's younger builder over its older one",
      { extra: [B2], agent: "B-2" },
      "B-2",
    ],
    ["named: A's builder", { agent: "A-1" }, null],
    [
      "named: the unscoped builder, while B has its own",
      { agent: "U-1" },
      null,
    ],
    ["named: B's own builder, full", { agent: "B-1", busy: ["B-1"] }, null],
    ["named: B's own builder, off", { agent: "B-1", b1: { enabled: 0 } }, null],
    ["named: an agent that does not exist", { agent: "NOPE" }, null],
    ["named: an agent of another kind", { agent: "C-R" }, null],
  ])("%s", async (_, c, expected) => {
    unwrap(await seedAgents(c.b1, c.extra));
    if (c.busy !== undefined) unwrap(await occupy(...c.busy));
    const r = unwrap(
      await staff(1, c.agent === undefined ? {} : { agent: c.agent }),
    );
    const spawned = await spawnAgents();
    for (const id of spawned) expect(WORKSPACE_OF[id], id).toBe("P-B");
    if (expected === null) {
      expect(r).toMatchObject({ kind: "refused", reason: "no_agent" });
      expect(spawned).toEqual([]);
    } else {
      expect(r).toMatchObject({
        kind: "staffed",
        payload: { agent_id: expected, workspace_id: "P-B" },
      });
      expect(spawned).toEqual([expected]);
    }
  });

  test("a refused named agent says why", async () => {
    unwrap(await seedAgents({}, [agent("B-2", 4, "P-B", { enabled: 0 })]));
    unwrap(await occupy("B-1"));
    const why = async (agentId: string) =>
      (await refusal(1, { agent: agentId })).detail;
    expect(await why("A-1")).toBe(
      "agent A-1 belongs to project P-A, not ticket #1's project P-B",
    );
    expect(await why("U-1")).toBe(
      "agent U-1 has no project, and ticket #1's project P-B has builder agents of its own",
    );
    expect(await why("B-1")).toBe("agent B-1 is at its max_concurrency (1)");
    expect(await why("B-2")).toBe("agent B-2 is disabled");
    expect(await why("C-R")).toBe("agent C-R is a reviewer, not a builder");
    expect(await why("NOPE")).toBe("agent NOPE does not exist");
  });

  test("the role binding does not narrow a project's own agents; it still narrows an unscoped ticket's", async () => {
    unwrap(await seedAgents());
    unwrap(await bind("runner-c"));
    expect((await staffedWith(1)).agent_id).toBe("B-1");
    const unscoped = await refusal(3);
    expect(unscoped.reason).toBe("no_agent");
    expect(unscoped.detail).toContain("runner runner-c");
    // A named agent is the caller's choice: no binding narrows it.
    expect((await staffedWith(3, { agent: "U-1" })).agent_id).toBe("U-1");
  });
});

describe("agents with no project: only for a project with none of the role", () => {
  test("P-C has a reviewer but no builder: its ticket takes the unscoped builder, never A's or B's", async () => {
    unwrap(await seedAgents());
    expect(await staffedWith(4)).toMatchObject({
      agent_id: "U-1",
      workspace_id: "P-C",
    });
    // The ticket keeps its own project: nothing is pinned.
    expect(unwrap(await getTicket(t.db, "ticket-4")).workspace_id).toBe("P-C");
  });

  test("the unscoped builder full: P-C's ticket is no_agent, though A's and B's are free", async () => {
    unwrap(await seedAgents());
    unwrap(await occupy("U-1"));
    expect(await refusal(4)).toMatchObject({ reason: "no_agent" });
    expect(await spawnAgents()).toEqual([]);
  });

  test("an unscoped builder named for P-C's ticket is taken; another project's is refused", async () => {
    unwrap(await seedAgents());
    expect(await refusal(4, { agent: "B-1" })).toMatchObject({
      reason: "no_agent",
      detail: "agent B-1 belongs to project P-B, not ticket #4's project P-C",
    });
    expect((await staffedWith(4, { agent: "U-1" })).agent_id).toBe("U-1");
  });

  test("the unscoped agents stay under the binding, as they are for a ticket with no project", async () => {
    unwrap(await seedAgents());
    unwrap(await bind("runner-c"));
    expect(await refusal(4)).toMatchObject({ reason: "no_agent" });
  });
});

describe("a ticket with no project keeps the fleet's list, and is pinned to the project it is staffed into", () => {
  const events = async (num: number) =>
    unwrap(
      await listTicketEvents(t.db, {
        ticket_id: `ticket-${num}`,
        since: 0,
        limit: 50,
      }),
    ).rows;

  test("staffed onto a project's agent: pinned to that project in the same transaction, with an updated ticket_event", async () => {
    unwrap(await seedAgents());
    unwrap(await occupy("U-1"));
    const txns = t.db.stats.txns;
    expect(await staffedWith(3)).toMatchObject({
      agent_id: "A-1",
      workspace_id: "P-A",
    });
    expect(t.db.stats.txns - txns).toBe(1);
    expect(unwrap(await getTicket(t.db, "ticket-3"))).toMatchObject({
      status: "staffed",
      workspace_id: "P-A",
      version: 3,
    });
    const pinned = (await events(3)).filter((e) => e.kind === "updated");
    expect(pinned).toEqual([
      expect.objectContaining({
        actor_kind: "operator",
        actor_id: "operator",
        reason: "staffed onto agent A-1 of project P-A",
      }),
    ]);
    expect(JSON.parse(pinned[0]?.payload_json ?? "")).toEqual({
      agent_id: "A-1",
      fields: ["workspace_id"],
      workspace_id: "P-A",
    });
  });

  test("staffed onto an agent with no project: nothing is pinned", async () => {
    unwrap(await seedAgents());
    const payload = await staffedWith(3);
    expect(payload.agent_id).toBe("U-1");
    expect(payload).not.toHaveProperty("workspace_id");
    expect(unwrap(await getTicket(t.db, "ticket-3"))).toMatchObject({
      workspace_id: null,
      version: 2,
    });
    expect((await events(3)).filter((e) => e.kind === "updated")).toEqual([]);
  });

  test("a named agent of any project may take it, and pins it", async () => {
    unwrap(await seedAgents());
    expect(await staffedWith(3, { agent: "B-1" })).toMatchObject({
      agent_id: "B-1",
      workspace_id: "P-B",
    });
    expect(unwrap(await getTicket(t.db, "ticket-3")).workspace_id).toBe("P-B");
  });

  test("a repeated key that named another agent is a conflict; the same agent replays", async () => {
    unwrap(await seedAgents());
    const first = await staffedWith(3, { agent: "B-1", idempotencyKey: "k" });
    const again = unwrap(await staff(3, { agent: "B-1", idempotencyKey: "k" }));
    expect(again).toMatchObject({
      kind: "staffed",
      created: false,
      payload: first,
    });
    expect(await staff(3, { agent: "A-1", idempotencyKey: "k" })).toMatchObject(
      { ok: false, error: { class: "conflict" } },
    );
  });

  test("a key first auto-picked, then repeated naming another agent, is a conflict", async () => {
    unwrap(await seedAgents());
    const first = await staffedWith(3, { idempotencyKey: "auto" });
    const other = first.agent_id === "A-1" ? "B-1" : "A-1";
    expect(
      await staff(3, { agent: other, idempotencyKey: "auto" }),
    ).toMatchObject({ ok: false, error: { class: "conflict" } });
    // Naming the agent it picked replays.
    expect(
      unwrap(await staff(3, { agent: first.agent_id, idempotencyKey: "auto" })),
    ).toMatchObject({ kind: "staffed", created: false });
  });
});

describe("reviewer agents are scoped the same way", () => {
  const reviewer = (
    id: string,
    runner_id: string,
    workspace_id: string | null,
    o: object = {},
  ) =>
    agent(id, 1, workspace_id, { kind: "reviewer" as const, runner_id, ...o });
  const ids = (rows: readonly { readonly id: string }[]) =>
    rows.map((r) => r.id);

  beforeEach(async () => {
    unwrap(
      await seedRows(t.db, {
        agents: [
          reviewer("R-U", "runner-a", null),
          reviewer("R-A", "runner-a", "P-A"),
          reviewer("R-B1", "runner-b", "P-B"),
          reviewer("R-B2", "runner-c", "P-B", { enabled: 0 }),
          {
            ...agent("J-U", 1, null),
            kind: "util" as const,
            runner_id: "runner-a",
          },
        ],
      }),
    );
  });

  test("a project's own reviewers of the runner; unscoped ones only when it has none; no project: all", async () => {
    expect(
      ids(unwrap(await listReviewerAgents(t.db, "runner-a", "P-A"))),
    ).toEqual(["R-A"]);
    // P-B's reviewers are on runner-b and runner-c: none on runner-a, and never A's or the fleet's.
    expect(unwrap(await listReviewerAgents(t.db, "runner-a", "P-B"))).toEqual(
      [],
    );
    expect(
      ids(unwrap(await listReviewerAgents(t.db, "runner-b", "P-B"))),
    ).toEqual(["R-B1"]);
    // Disabled reviewers are never listed.
    expect(unwrap(await listReviewerAgents(t.db, "runner-c", "P-B"))).toEqual(
      [],
    );
    // P-C has no reviewer agent in this block: the ones with no project review it.
    expect(
      ids(unwrap(await listReviewerAgents(t.db, "runner-a", "P-C"))),
    ).toEqual(["R-U"]);
    expect(
      ids(unwrap(await listReviewerAgents(t.db, "runner-a", null))),
    ).toEqual(["R-A", "R-U"]);
    // Util agents (script gates' jobs) are not project-scoped.
    expect(ids(unwrap(await listUtilAgents(t.db, "runner-a")))).toEqual([
      "J-U",
    ]);
  });

  test("projectReviewerRunners: a project's own reviewer runners by id, disabled ones' too; null when it has none", async () => {
    expect(unwrap(await projectReviewerRunners(t.db, "P-B"))).toEqual([
      "runner-b",
      "runner-c",
    ]);
    expect(unwrap(await projectReviewerRunners(t.db, "P-A"))).toEqual([
      "runner-a",
    ]);
    expect(unwrap(await projectReviewerRunners(t.db, "P-C"))).toBeNull();
    expect(unwrap(await projectReviewerRunners(t.db, null))).toBeNull();
  });
});
