import { FakeClock, type Actor, type FrmError, type Result } from "@bayon/core";
import {
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "@bayon/db/testing";
import { listGates } from "@bayon/db";
import { afterAll, describe, expect, test } from "vitest";
import { EVIDENCE, gate } from "../gates/fixtures.js";
import { TicketService } from "./ticket-service.js";

// The TicketService over a real temp-file DB (M1 contract 1's writers): what an earlier change (MCP) and
// an earlier change (GUI) call. The laws themselves are tested in core; here, that they reach the writer.

const clock = new FakeClock(1_700_000_000_000);
const t = unwrap(await tempDb(clock));
unwrap(await seedSpine(t.db, 3));
unwrap(
  await seedRows(t.db, {
    repos: [{ id: "repo-1", name: "repo-1", mirror_path: "/m/repo-1" }],
    workspaces: [{ id: "ws-1", name: "ws-1", kind: "single" }],
  }),
);
afterAll(() => t.cleanup());

const service = new TicketService({ db: t.db, clock, workRoot: null });

const OPERATOR: Actor = { kind: "operator" };
const ORCH: Actor = { kind: "orchestrator", sessionId: "orch-1" };
const worker = (sessionId: string): Actor => ({ kind: "worker", sessionId });

const value = <T>(result: Result<T>): T => {
  if (!result.ok)
    throw new Error(`${result.error.class}: ${result.error.message}`);
  return result.value;
};
const failure = <T>(result: Result<T>): FrmError => {
  if (result.ok) throw new Error("expected an error");
  return result.error;
};

let sessions = 0;
/** A live session holding `ticketId`, with an active worktree unless told otherwise. */
async function holder(ticketId: string, worktree = true): Promise<string> {
  sessions += 1;
  const id = `s-${sessions}`;
  unwrap(
    await seedRows(t.db, {
      sessions: [
        {
          ...newSessionInput(),
          id,
          ticket_id: ticketId,
          state: "running",
          created_at: 0,
        },
      ],
      worktrees: worktree
        ? [
            {
              id: `wt-${id}`,
              session_root: "/w",
              workspace_id: "ws-1",
              repo_id: "repo-1",
              path: `/w/${id}`,
              branch: `frm/${id}`,
              base_sha: "0".repeat(40),
              ticket_id: ticketId,
              session_id: id,
              state: "active",
              created_at: 0,
            },
          ]
        : [],
    }),
  );
  return id;
}

/** A ticket seeded straight into `status` (for the M3 and QA-tail laws), by its num. */
let seeded = 1_000;
async function seed(status: string): Promise<string> {
  seeded += 1;
  unwrap(await seedRows(t.db, { tickets: [ticketRow(seeded, { status })] }));
  return String(seeded);
}

const create = async (title = "fixture", actor: Actor = OPERATOR) =>
  value(await service.create({ title, type: "chore" }, actor));

describe("create", () => {
  test("files a backlog ticket keyed FRM-<num>, scored from its facts", async () => {
    const view = value(
      await service.create(
        {
          title: "Add auth",
          type: "feature",
          body_md: "tokens",
          complexity_facts: { sensitive_data: true, concurrency: true },
        },
        OPERATOR,
      ),
    );
    expect(view).toMatchObject({
      key: `FRM-${view.num}`,
      status: "backlog",
      origin: "operator",
      needs_human: false,
      complexity_score: 6,
      complexity_tier: "complex",
      non_trivial: true,
      version: 1,
    });
    expect(view.complexity_factors).toMatchObject({
      contributions: { concurrency: 3, sensitive_data: 3 },
      rubric_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  test("a worker's ticket needs a human (§11.1); an orchestrator's does not", async () => {
    const fromWorker = await create("from a worker", worker("s-x"));
    expect(fromWorker).toMatchObject({
      needs_human: true,
      origin: "agent",
      origin_ref: "s-x",
    });
    const fromOrch = await create("from the orchestrator", ORCH);
    expect(fromOrch).toMatchObject({ needs_human: false, origin: "agent" });
  });

  test("an unknown complexity fact is a validation error", async () => {
    expect(
      failure(
        await service.create(
          { title: "t", type: "chore", complexity_facts: { vibes: true } },
          OPERATOR,
        ),
      ).class,
    ).toBe("validation");
  });
});

describe("get", () => {
  test("by id or num, with the caller's transitions, events and extras", async () => {
    const ticket = await create("readable");
    const byId = value(await service.get(ticket.id, OPERATOR));
    expect(value(await service.get(String(ticket.num), OPERATOR))).toEqual(
      byId,
    );
    expect(byId.ticket).toEqual(ticket);
    expect(byId.transitions).toContainEqual({
      to: "prioritized",
      rule: "prioritize",
      allowed: true,
    });
    expect(byId.events.items.map((e) => e.kind)).toEqual(["created"]);
    expect(byId).toMatchObject({
      links: [],
      gates: [],
      handoffs: [],
      exports: [],
      economics: {
        cost_usd: 0,
        review_rounds: 0,
        handoff_count: 0,
        sessions: 0,
      },
    });
  });

  test("a worker sees why it may not prioritize", async () => {
    const ticket = await create("not yours to rank");
    const detail = value(await service.get(ticket.id, worker("s-x")));
    expect(
      detail.transitions.find((o) => o.to === "prioritized"),
    ).toMatchObject({
      allowed: false,
      reason: "actor_not_allowed",
    });
  });

  test("an unknown ticket is not_found, and a bad ref is a validation error", async () => {
    expect(failure(await service.get("999999", OPERATOR)).class).toBe(
      "not_found",
    );
    expect(failure(await service.get("not a ref", OPERATOR)).class).toBe(
      "validation",
    );
  });
});

describe("update", () => {
  test("a compare-and-set bumps the version and rescores", async () => {
    const ticket = await create("to edit");
    const edited = value(
      await service.update(
        ticket.id,
        1,
        { title: "edited", complexity_facts: { cosmetic_only: true } },
        OPERATOR,
      ),
    );
    expect(edited).toMatchObject({
      title: "edited",
      version: 2,
      complexity_score: -3,
      complexity_tier: "cheap",
    });
    expect(
      failure(await service.update(ticket.id, 1, { title: "stale" }, OPERATOR)),
    ).toMatchObject({
      class: "conflict",
      cause: { current_version: 2 },
    });
  });

  test("a worker raises needs_human on its own ticket, but may not clear it, rank it, or touch another", async () => {
    const own = await create("mine");
    const other = await create("theirs");
    const s = await holder(own.id);
    const raised = value(
      await service.update(own.id, 1, { needs_human: true }, worker(s)),
    );
    expect(raised.needs_human).toBe(true);
    const refused = async (id: string, version: number, patch: object) =>
      failure(await service.update(id, version, patch, worker(s)));
    expect(await refused(own.id, 2, { needs_human: false })).toMatchObject({
      class: "law_refused",
      cause: { rule: "patch", reason: "actor_not_allowed" },
    });
    expect(await refused(own.id, 2, { priority: 1 })).toMatchObject({
      cause: { reason: "actor_not_allowed" },
    });
    expect(await refused(other.id, 1, { title: "x" })).toMatchObject({
      cause: { reason: "cross_ticket_write" },
    });
  });
});

describe("transition", () => {
  test("the operator prioritizes; the event carries the actor and the rule", async () => {
    const ticket = await create("to rank");
    const moved = value(
      await service.transition(
        ticket.id,
        1,
        { to: "prioritized", reason: "top" },
        OPERATOR,
      ),
    );
    expect(moved).toMatchObject({ status: "prioritized", version: 2 });
    const events = value(
      await service.events(ticket.id, { since: 0, limit: 10 }),
    );
    expect(events.items.at(-1)).toMatchObject({
      kind: "transition",
      from_status: "backlog",
      to_status: "prioritized",
      actor_kind: "operator",
      reason: "top",
      payload: { rule: "prioritize" },
    });
  });

  test("a refusal is law_refused with its rule and reason, and writes nothing", async () => {
    const ticket = await create("workers may not rank");
    const s = await holder(ticket.id);
    expect(
      failure(
        await service.transition(
          ticket.id,
          1,
          { to: "prioritized" },
          worker(s),
        ),
      ),
    ).toMatchObject({
      class: "law_refused",
      cause: { rule: "prioritize", reason: "actor_not_allowed" },
    });
    expect(value(await service.get(ticket.id, OPERATOR)).ticket.version).toBe(
      1,
    );
  });

  test("a stale version is a conflict naming the current one", async () => {
    const ticket = await create("raced");
    value(
      await service.transition(ticket.id, 1, { to: "prioritized" }, OPERATOR),
    );
    expect(
      failure(
        await service.transition(ticket.id, 1, { to: "parked" }, OPERATOR),
      ),
    ).toMatchObject({
      class: "conflict",
      cause: { current_version: 2 },
    });
  });

  test("block, then unblock back to the prior status", async () => {
    const ticket = await create("blocked on CI");
    value(await service.transition(ticket.id, 1, { to: "prioritized" }, ORCH));
    const blocked = value(
      await service.transition(
        ticket.id,
        2,
        {
          to: "blocked",
          blocked_reason: "CI is down",
          unblock_condition: "CI is up",
        },
        ORCH,
      ),
    );
    expect(blocked).toMatchObject({
      blocked_reason: "CI is down",
      unblock_condition: "CI is up",
    });
    const back = value(
      await service.transition(ticket.id, 3, { to: "prioritized" }, ORCH),
    );
    expect(back).toMatchObject({
      status: "prioritized",
      blocked_reason: null,
      unblock_condition: null,
    });
  });

  test("blocking without the fields is refused", async () => {
    const ticket = await create("vague block");
    expect(
      failure(
        await service.transition(ticket.id, 1, { to: "blocked" }, OPERATOR),
      ),
    ).toMatchObject({
      class: "law_refused",
      cause: { reason: "missing_note" },
    });
  });

  test("a worker starts the spike on its own staffed ticket; without a session nobody can", async () => {
    const ticket = await create("spike me");
    value(await service.transition(ticket.id, 1, { to: "prioritized" }, ORCH));
    value(await service.transition(ticket.id, 2, { to: "staffed" }, ORCH));
    expect(
      failure(await service.transition(ticket.id, 3, { to: "spiking" }, ORCH)),
    ).toMatchObject({ cause: { rule: "start_spike", reason: "no_session" } });
    const s = await holder(ticket.id);
    const other = await holder(`ticket-${await seed("staffed")}`);
    expect(
      failure(
        await service.transition(
          ticket.id,
          3,
          { to: "spiking" },
          worker(other),
        ),
      ),
    ).toMatchObject({ cause: { reason: "cross_ticket_write" } });
    expect(
      value(
        await service.transition(ticket.id, 3, { to: "spiking" }, worker(s)),
      ).status,
    ).toBe("spiking");
  });

  test("M3 gate laws refuse rather than pass: code review with no gate is missing_evidence", async () => {
    const id = await seed("code_review");
    expect(
      failure(await service.transition(id, 1, { to: "qa_harness" }, OPERATOR)),
    ).toMatchObject({
      class: "law_refused",
      cause: { rule: "pass_review", reason: "missing_evidence" },
    });
  });

  // the operator's own pass_review on a CI project opens the QA gate over the pull
  // request — the API's round plan reads the same `qa_mode` the supervisor's does.
  test("pass_review on a CI project opens its QA gate over the pull request", async () => {
    unwrap(
      await seedRows(t.db, {
        workspaces: [
          {
            id: "ws-ci",
            name: "ws-ci",
            kind: "single",
            qa_mode: "ci",
            delivery_mode: "pull_request",
            delivery_when: "review_passed",
          },
        ],
      }),
    );
    seeded += 1;
    const num = seeded;
    unwrap(
      await seedRows(t.db, {
        tickets: [
          ticketRow(num, { status: "code_review", workspace_id: "ws-ci" }),
        ],
        gates: [
          gate(`g-cr-${String(num)}`, num, {
            state: "passed",
            evidence_json: JSON.stringify(EVIDENCE),
            decided_at: 2,
          }),
        ],
      }),
    );
    value(
      await service.transition(String(num), 1, { to: "qa_harness" }, OPERATOR),
    );
    const opened = unwrap(
      await listGates(t.db, {
        ticket_id: `ticket-${String(num)}`,
        latest: true,
        limit: 10,
      }),
    ).rows.filter((g) => g.kind === "qa_harness");
    expect(opened.map((g) => [g.state, g.subject_kind])).toEqual([
      ["running", "pull_request"],
    ]);
  });

  test("the operator may override a missing qa_run with a note, which is recorded", async () => {
    const id = await seed("qa_harness");
    value(
      await service.transition(
        id,
        1,
        { to: "qa_human", override_note: "checked by hand" },
        OPERATOR,
      ),
    );
    const events = value(await service.events(id, { since: 0, limit: 10 }));
    expect(events.items.at(-1)?.payload).toEqual({
      rule: "pass_harness",
      override_note: "checked by hand",
    });
  });

  test("only a failed human QA goes back to building; done sets closed_at", async () => {
    const harness = await seed("qa_harness");
    value(await service.transition(harness, 1, { to: "rework" }, OPERATOR));
    expect(
      failure(
        await service.transition(harness, 2, { to: "building" }, OPERATOR),
      ),
    ).toMatchObject({
      cause: { rule: "rebuild", reason: "not_from_human_qa" },
    });
    const human = await seed("qa_human");
    value(
      await service.transition(
        human,
        1,
        { to: "rework", reason: "button gone" },
        OPERATOR,
      ),
    );
    expect(
      value(await service.transition(human, 2, { to: "building" }, OPERATOR))
        .status,
    ).toBe("building");
    const passing = await seed("qa_human");
    expect(
      value(await service.transition(passing, 1, { to: "done" }, OPERATOR))
        .closed_at,
    ).toBe(clock.now());
  });
});

describe("comments, links and search", () => {
  test("a comment and a link land in the ticket's history and detail", async () => {
    const ticket = await create("linked");
    const target = await create("target");
    const comment = value(
      await service.comment(ticket.id, { body_md: "a note" }, OPERATOR),
    );
    expect(comment).toMatchObject({
      kind: "comment",
      payload: { body_md: "a note" },
    });
    value(
      await service.link(
        ticket.id,
        { kind: "relates", target: String(target.num) },
        OPERATOR,
      ),
    );
    value(
      await service.link(
        ticket.id,
        { kind: "pr", url: "https://example.com/pr/1" },
        OPERATOR,
      ),
    );
    const detail = value(await service.get(ticket.id, OPERATOR));
    expect(detail.links).toMatchObject([
      { kind: "relates", target_ticket_id: target.id },
      { kind: "pr", url: "https://example.com/pr/1" },
    ]);
    expect(detail.events.items.map((e) => e.kind)).toEqual([
      "created",
      "comment",
      "linked",
      "linked",
    ]);
  });

  test("list filters by status, searches titles, and pages by num", async () => {
    const found = await create("quasar telemetry");
    const page = value(await service.list({ q: "quasar", limit: 50 }));
    expect(page.items.map((i) => i.id)).toEqual([found.id]);
    expect(page.items[0]).toMatchObject({ key: found.key, status: "backlog" });
    const first = value(await service.list({ status: ["backlog"], limit: 1 }));
    expect(first).toMatchObject({ has_more: true });
    const next = value(
      await service.list({
        status: ["backlog"],
        limit: 1,
        cursor: first.next_cursor,
      }),
    );
    expect(next.items[0]?.num).toBeGreaterThan(first.items[0]?.num ?? 0);
  });

  test("the key prefix is the operator's setting", async () => {
    unwrap(
      await seedRows(t.db, {
        settings: [
          { key: "tickets.key_prefix", value_json: '"BAY-"', updated_at: 0 },
        ],
      }),
    );
    const view = await create("prefixed");
    expect(view.key).toBe(`BAY-${view.num}`);
  });
});
