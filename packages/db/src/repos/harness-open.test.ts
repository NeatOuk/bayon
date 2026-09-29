import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { gateDb, seedRows, unwrap } from "../testing.js";
import { EVIDENCE, exec, gateRow, rows } from "./fixtures.js";
import { decideGate } from "./gate-decide.js";
import { openOwedHarness } from "./harness-open.js";

// openOwedHarness: the QA gate a ticket already at qa_harness is owed — it crossed
// pass_review while its project ran no QA — opened by the supervisor as pass_review would have
// opened it, on a real temp SQLite file. Anything not owed writes nothing.

let t: Awaited<ReturnType<typeof gateDb>>;
beforeEach(async () => {
  // ticket-1 qa_harness, ticket-2 code_review.
  t = await gateDb(["qa_harness", "code_review"]);
  unwrap(
    await seedRows(t.db, {
      repos: [
        {
          id: "r1",
          name: "r1",
          origin_url: "file:///r1",
          mirror_path: "/m/r1.git",
        },
      ],
      workspaces: [
        {
          id: "ws-qa",
          name: "ws-qa",
          kind: "single",
          qa_mode: "command",
          qa_cmd: "./scripts/check",
        },
        {
          id: "ws-ci",
          name: "ws-ci",
          kind: "single",
          qa_mode: "ci",
          delivery_mode: "pull_request",
          delivery_when: "review_passed",
        },
        { id: "ws-none", name: "ws-none", kind: "single" },
      ],
    }),
  );
  // The review round that took ticket-1 to qa_harness, decided, with no QA gate after it.
  unwrap(
    await seedRows(t.db, {
      gates: [
        gateRow("g-cr", {
          state: "passed",
          evidence_json: JSON.stringify(EVIDENCE),
          decided_at: t.clock.now(),
          round: 1,
        }),
      ],
    }),
  );
});
afterEach(() => t.cleanup());

const inWorkspace = (ticket: string, ws: string) =>
  exec(
    t.db,
    `UPDATE tickets SET workspace_id = '${ws}' WHERE id = '${ticket}'`,
  );

const qaGates = (ticket = "ticket-1") =>
  rows(
    t.db,
    "SELECT id, kind, state, repo_id, attempt, round, subject_kind, subject_ref FROM gates WHERE ticket_id = ? AND kind = 'qa_harness' ORDER BY id",
    ticket,
  ) as { id: string; state: string }[];

/** Every row a writer could touch: none may change when nothing is owed. */
const snapshot = () => ({
  gates: rows(t.db, "SELECT * FROM gates ORDER BY id"),
  events: rows(t.db, "SELECT * FROM ticket_events ORDER BY id"),
  audit: rows(t.db, "SELECT * FROM audit_log ORDER BY id"),
  commands: rows(t.db, "SELECT * FROM commands ORDER BY id"),
  tickets: rows(t.db, "SELECT * FROM tickets ORDER BY id"),
});

describe("a ticket at qa_harness in a project that runs a harness command", () => {
  beforeEach(() => inWorkspace("ticket-1", "ws-qa"));

  test("gets the QA gate pass_review would have opened: next round, repo-less, over the workspace, no command", async () => {
    const out = unwrap(await openOwedHarness(t.db, "ticket-1"));
    expect(out.opened.map((g) => g.kind)).toEqual(["qa_harness"]);
    expect(qaGates()).toEqual([
      {
        id: out.opened[0]?.id,
        kind: "qa_harness",
        state: "running",
        repo_id: null,
        attempt: 1,
        round: 2,
        subject_kind: "workspace",
        subject_ref: "unpinned",
      },
    ]);
    // §9.5: the supervisor never inserts a command; the gate engine's poll starts it.
    expect(rows(t.db, "SELECT count(*) AS n FROM commands")).toEqual([
      { n: 0 },
    ]);
    // The ticket does not move: it is already where the gate is judged.
    expect(
      rows(t.db, "SELECT status, version FROM tickets WHERE id = 'ticket-1'"),
    ).toEqual([{ status: "qa_harness", version: 1 }]);
    expect(
      rows(
        t.db,
        "SELECT kind, actor_kind, actor_id, payload_json FROM ticket_events WHERE ticket_id = 'ticket-1'",
      ),
    ).toEqual([
      {
        kind: "gate",
        actor_kind: "supervisor",
        actor_id: "gate_engine",
        payload_json: expect.stringContaining('"step":"open"'),
      },
    ]);
    expect(
      rows(
        t.db,
        "SELECT actor, action, target_id, payload_json FROM audit_log WHERE action = 'supervisor.open_harness'",
      ),
    ).toEqual([
      {
        actor: "supervisor",
        action: "supervisor.open_harness",
        target_id: "ticket-1",
        payload_json: JSON.stringify({ gate_ids: [out.opened[0]?.id] }),
      },
    ]);
  });

  test("a second call opens no second gate, and writes nothing", async () => {
    unwrap(await openOwedHarness(t.db, "ticket-1"));
    const before = snapshot();
    const again = unwrap(await openOwedHarness(t.db, "ticket-1"));
    expect(again).toEqual({
      opened: [],
      why: "a qa_harness gate is running",
    });
    expect(snapshot()).toEqual(before);
  });

  test("once the gate has decided, even as infra, it is never reopened: a rerun is the operator's", async () => {
    const [opened] = unwrap(await openOwedHarness(t.db, "ticket-1")).opened;
    if (opened === undefined) throw new Error("no gate opened");
    unwrap(
      await decideGate(t.db, {
        gate_id: opened.id,
        session_id: null,
        evidence: { reason: "no_reviewer" },
        findings: [],
      }),
    );
    // decideGate's own retry may open attempt 2; what matters is that this writer adds none.
    const before = snapshot();
    const again = unwrap(await openOwedHarness(t.db, "ticket-1"));
    expect(again.opened).toEqual([]);
    expect(snapshot()).toEqual(before);
  });
});

describe("owed nothing, writes nothing", () => {
  test("a project that runs no QA", async () => {
    inWorkspace("ticket-1", "ws-none");
    const before = snapshot();
    expect(unwrap(await openOwedHarness(t.db, "ticket-1"))).toEqual({
      opened: [],
      why: "the ticket's project runs no QA harness",
    });
    expect(snapshot()).toEqual(before);
  });

  test("a ticket that is not at qa_harness", async () => {
    inWorkspace("ticket-2", "ws-qa");
    const before = snapshot();
    const out = unwrap(await openOwedHarness(t.db, "ticket-2"));
    expect(out.opened).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  test("a CI project with no pull request to read", async () => {
    inWorkspace("ticket-1", "ws-ci");
    const before = snapshot();
    const out = unwrap(await openOwedHarness(t.db, "ticket-1"));
    expect(out.opened).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  test("an unknown ticket is not_found", async () => {
    const out = await openOwedHarness(t.db, "ticket-99");
    expect(out.ok ? null : out.error.class).toBe("not_found");
  });
});

test("a CI project whose pull request has no delivered head gets no gate", async () => {
  inWorkspace("ticket-1", "ws-ci");
  unwrap(
    await seedRows(t.db, {
      deliveries: [
        {
          id: "D1",
          ticket_id: "ticket-1",
          repo_id: "r1",
          branch: "frm/s",
          head_sha: null,
          state: "pr_open" as const,
          pr_url: "https://forge.test/pull/1",
          pr_number: 1,
          started_at: 1,
        },
      ],
    }),
  );
  const before = snapshot();
  const out = unwrap(await openOwedHarness(t.db, "ticket-1"));
  expect(out.opened).toEqual([]);
  expect(snapshot()).toEqual(before);
});

test("a CI project with a pull request open gets a CI gate, over the pull request", async () => {
  inWorkspace("ticket-1", "ws-ci");
  unwrap(
    await seedRows(t.db, {
      deliveries: [
        {
          id: "D1",
          ticket_id: "ticket-1",
          repo_id: "r1",
          branch: "frm/s",
          head_sha: "b".repeat(40),
          state: "pr_open" as const,
          pr_url: "https://forge.test/pull/1",
          pr_number: 1,
          started_at: 1,
        },
      ],
    }),
  );
  const out = unwrap(await openOwedHarness(t.db, "ticket-1"));
  expect(out.opened.map((g) => [g.kind, g.subject_kind])).toEqual([
    ["qa_harness", "pull_request"],
  ]);
});
