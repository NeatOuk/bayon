import { FakeClock } from "@bayon/core";
import { afterEach, describe, expect, test } from "vitest";
import {
  dumpAllRows,
  listAudit,
  seedRows,
  tempDb,
  unwrap,
  updateRowForTest,
  type TempDb,
} from "../testing.js";
import { first, qb, read, type Db } from "../connection.js";
import {
  listPullRequestCandidates,
  pullRequestWatch,
} from "./pull-request-reads.js";
import {
  PULL_REQUESTS_ACTION,
  settlePullRequests,
  type PullRequestSeen,
} from "./pull-request-writes.js";
import type { DeliveryState } from "../schema-work.js";
import { recordDelivery } from "./delivery-writes.js";
import { EVIDENCE, exec, findingRow } from "./fixtures.js";

// settlePullRequests against a real temp database: a merge recorded, and the ticket
// closed with it in one transaction when that was the last; a partial merge that moves nothing; a
// request closed unmerged that asks the operator once; a re-settle that writes nothing; a running
// QA harness superseded; and the project's switch off.

const T0 = 1_700_000_000_000;
let t: TempDb | null = null;

afterEach(() => {
  t?.cleanup();
  t = null;
});

const PR = (repo: string) => `https://forge.test/o/${repo}/pull/1`;

interface Spec {
  readonly status?: string;
  readonly closeOnMerge?: 0 | 1;
  readonly repos?: readonly string[];
  /** A running qa_harness gate on the ticket. */
  readonly harness?: boolean;
  readonly states?: Readonly<Record<string, DeliveryState>>;
}

async function fresh(s: Spec = {}) {
  const clock = new FakeClock(T0);
  const temp = unwrap(await tempDb(clock));
  t = temp;
  const repos = s.repos ?? ["r1"];
  unwrap(
    await seedRows(temp.db, {
      repos: repos.map((id) => ({
        id,
        name: id,
        origin_url: `https://forge.test/o/${id}.git`,
        mirror_path: `/mirrors/${id}.git`,
        doctrine_paths_json: "[]",
      })),
      workspaces: [
        {
          id: "P",
          name: "P",
          kind: repos.length > 1 ? "multi" : "single",
          delivery_mode: "pull_request",
          close_on_merge: s.closeOnMerge ?? 1,
        },
      ],
      workspace_repos: repos.map((id, i) => ({
        workspace_id: "P",
        repo_id: id,
        rel_path: id,
        role: i === 0 ? "primary" : "dep",
      })),
      tickets: [
        {
          id: "T1",
          num: 1,
          title: "t1",
          type: "chore",
          status: s.status ?? "qa_human",
          origin: "operator",
          workspace_id: "P",
          created_at: T0,
          updated_at: T0,
        },
      ],
      gates:
        s.harness === true
          ? [
              {
                id: "G-qa",
                ticket_id: "T1",
                kind: "qa_harness",
                state: "running",
                subject_kind: "commit",
                subject_ref: "abc",
                started_at: T0,
              },
            ]
          : [],
      deliveries: repos.map((id, i) => ({
        id: `D${i}`,
        ticket_id: "T1",
        repo_id: id,
        branch: "frm/s",
        head_sha: "abc",
        remote_host: "forge.test",
        remote_url: `https://forge.test/o/${id}.git`,
        state: s.states?.[id] ?? "pr_open",
        pr_url: PR(id),
        pr_number: 1,
        started_at: T0,
      })),
    }),
  );
  return { db: temp.db, clock };
}

const merged = (
  repo_id: string,
  by: string | null = "a-merger",
  at = T0 - 5,
): PullRequestSeen => ({
  repo_id,
  kind: "merged",
  merged_at: at,
  merged_by: by,
});

const settle = (db: Db, seen: readonly PullRequestSeen[]) =>
  settlePullRequests(db, { ticket_id: "T1", ticket_key: "FRM-1", seen });

const ticketOf = async (db: Db) =>
  unwrap(
    await read(db, (ix) =>
      first(
        ix,
        qb
          .selectFrom("tickets")
          .select(["status", "closed_at", "version"])
          .where("id", "=", "T1"),
      ),
    ),
  );

const eventsOf = async (db: Db) => {
  const rows = unwrap(await dumpAllRows(db));
  return (rows.ticket_events ?? []) as {
    kind: string;
    to_status: string | null;
    actor_id: string;
    payload_json: string | null;
  }[];
};

const requestsOf = async (db: Db) =>
  (unwrap(await dumpAllRows(db)).human_requests ?? []) as {
    question: string;
    dedupe_key: string;
    kind: string;
  }[];

test("the last merge closes the ticket in the same transaction, naming who merged", async () => {
  const { db } = await fresh();
  const out = unwrap(await settle(db, [merged("r1")]));
  expect(out.merged).toEqual([PR("r1")]);
  expect(out.advance).toMatchObject({
    advanced: true,
    rule: "merge_close",
    from: "qa_human",
    to: "done",
  });
  expect(await ticketOf(db)).toMatchObject({ status: "done", closed_at: T0 });
  const rows = unwrap(await dumpAllRows(db));
  expect(rows.deliveries).toMatchObject([
    { state: "merged", merged_at: T0 - 5, merged_by: "a-merger", error: null },
  ]);
  const events = await eventsOf(db);
  const transition = events.find((e) => e.kind === "transition");
  expect(transition).toMatchObject({ to_status: "done", actor_id: "delivery" });
  expect(JSON.parse(transition?.payload_json ?? "{}")).toMatchObject({
    rule: "merge_close",
    merged_by: "a-merger",
    pr_urls: [PR("r1")],
  });
  const delivery = events.find((e) => e.kind === "delivery");
  expect(JSON.parse(delivery?.payload_json ?? "{}")).toMatchObject({
    merged: [{ repo_id: "r1", url: PR("r1"), merged_by: "a-merger" }],
  });
  const audit = unwrap(await listAudit(db));
  expect(audit.map((a) => a.action)).toEqual(
    expect.arrayContaining([PULL_REQUESTS_ACTION, "supervisor.advance_ticket"]),
  );
});

test("one merge of two records it and moves nothing; the second closes the ticket", async () => {
  const { db } = await fresh({ repos: ["r1", "r2"] });
  const first_ = unwrap(
    await settle(db, [merged("r1"), { repo_id: "r2", kind: "open" }]),
  );
  expect(first_.advance).toMatchObject({ advanced: false });
  expect(await ticketOf(db)).toMatchObject({ status: "qa_human" });
  const second = unwrap(await settle(db, [merged("r2", "another", T0 - 1)]));
  expect(second.advance).toMatchObject({ advanced: true, to: "done" });
  const transition = (await eventsOf(db)).find((e) => e.kind === "transition");
  expect(JSON.parse(transition?.payload_json ?? "{}")).toMatchObject({
    // The last merge closed it: its login, and every merged request's url.
    merged_by: "another",
    pr_urls: [PR("r1"), PR("r2")],
  });
});

test("a request closed without merging is recorded, asks the operator once, and the ticket stays", async () => {
  const { db } = await fresh();
  const out = unwrap(await settle(db, [{ repo_id: "r1", kind: "closed" }]));
  expect(out).toMatchObject({ closed: [PR("r1")], filed: 1 });
  expect(out.advance).toMatchObject({ advanced: false });
  expect(await ticketOf(db)).toMatchObject({ status: "qa_human" });
  const requests = await requestsOf(db);
  expect(requests).toMatchObject([
    {
      kind: "delivery",
      question: `PR closed without merging: ${PR("r1")}`,
      dedupe_key: "delivery:T1:closed/r1#1",
    },
  ]);
  // The row is closed now: the same observation again changes nothing and files nothing.
  const before = unwrap(await dumpAllRows(db));
  const again = unwrap(await settle(db, [{ repo_id: "r1", kind: "closed" }]));
  expect(again).toMatchObject({ closed: [], filed: 0 });
  expect(unwrap(await dumpAllRows(db))).toEqual(before);
});

test("a re-settle of a finished merge writes nothing at all", async () => {
  const { db } = await fresh({ closeOnMerge: 0 });
  unwrap(await settle(db, [merged("r1")]));
  const before = unwrap(await dumpAllRows(db));
  const again = unwrap(await settle(db, [merged("r1")]));
  expect(again).toMatchObject({ merged: [], closed: [], filed: 0 });
  expect(unwrap(await dumpAllRows(db))).toEqual(before);
});

test("with close_on_merge off the merge is recorded and the ticket does not move", async () => {
  const { db } = await fresh({ closeOnMerge: 0 });
  const out = unwrap(await settle(db, [merged("r1")]));
  expect(out.merged).toEqual([PR("r1")]);
  expect(out.advance).toMatchObject({
    advanced: false,
    why: "this project does not close a ticket when its pull requests merge",
  });
  expect(await ticketOf(db)).toMatchObject({ status: "qa_human" });
  // Switched on later: the candidates find it again, and an empty settle closes it.
  expect(
    unwrap(await listPullRequestCandidates(db, { limit: 5, after: null })),
  ).toEqual([]);
  unwrap(await updateRowForTest(db, "workspaces", "P", { close_on_merge: 1 }));
  expect(
    unwrap(await listPullRequestCandidates(db, { limit: 5, after: null })).map(
      (c) => c.id,
    ),
  ).toEqual(["T1"]);
  expect(unwrap(await settle(db, [])).advance).toMatchObject({
    advanced: true,
    rule: "merge_close",
  });
});

test("a merge at qa_harness supersedes the harness still running, with no command inserted", async () => {
  const { db } = await fresh({ status: "qa_harness", harness: true });
  const out = unwrap(await settle(db, [merged("r1")]));
  expect(out.advance).toMatchObject({ advanced: true, from: "qa_harness" });
  const rows = unwrap(await dumpAllRows(db));
  expect(rows.gates).toMatchObject([
    { id: "G-qa", state: "failed", evidence_json: '{"reason":"superseded"}' },
  ]);
  // §9.5: the supervisor inserts no command; the gate engine's poll kills the job.
  expect(rows.commands).toEqual([]);
  const gateEvent = (await eventsOf(db)).find((e) => e.kind === "gate");
  expect(JSON.parse(gateEvent?.payload_json ?? "{}")).toMatchObject({
    gate_id: "G-qa",
    step: "supersede",
  });
});

test("a harness running at qa_harness without a merge is left alone", async () => {
  const { db } = await fresh({ status: "qa_harness", harness: true });
  unwrap(await settle(db, [{ repo_id: "r1", kind: "open" }]));
  const rows = unwrap(await dumpAllRows(db));
  expect(rows.gates).toMatchObject([{ id: "G-qa", state: "running" }]);
  expect(await ticketOf(db)).toMatchObject({ status: "qa_harness" });
});

test("a poll error is recorded once, scrubbed text as given; a refusal asks once; a later read clears it", async () => {
  const { db } = await fresh();
  const error: PullRequestSeen = {
    repo_id: "r1",
    kind: "error",
    error: "forge.test refused pull request #1 (HTTP 401)",
    retryable: false,
  };
  expect(unwrap(await settle(db, [error])).filed).toBe(1);
  const rowOf = async () =>
    (unwrap(await dumpAllRows(db)).deliveries ?? [])[0] as {
      state: string;
      error: string | null;
    };
  expect(await rowOf()).toMatchObject({
    state: "pr_open",
    error: "forge.test refused pull request #1 (HTTP 401)",
  });
  const before = unwrap(await dumpAllRows(db));
  expect(unwrap(await settle(db, [error])).filed).toBe(0);
  expect(unwrap(await dumpAllRows(db))).toEqual(before);
  // A retryable one files nothing.
  unwrap(await settle(db, [{ ...error, error: "HTTP 502", retryable: true }]));
  expect((await requestsOf(db)).length).toBe(1);
  unwrap(await settle(db, [{ repo_id: "r1", kind: "open" }]));
  expect(await rowOf()).toMatchObject({ state: "pr_open", error: null });
});

test("the candidates are the open tickets with an open request, paged", async () => {
  const { db } = await fresh({ states: { r1: "pushed" } });
  expect(
    unwrap(await listPullRequestCandidates(db, { limit: 5, after: null })),
  ).toEqual([]);
  unwrap(await updateRowForTest(db, "deliveries", "D0", { state: "pr_open" }));
  expect(
    unwrap(await listPullRequestCandidates(db, { limit: 5, after: null })),
  ).toEqual([{ id: "T1", status: "qa_human", updated_at: T0 }]);
  expect(
    unwrap(
      await listPullRequestCandidates(db, {
        limit: 5,
        after: { updated_at: T0, id: "T1" },
      }),
    ),
  ).toEqual([]);
  expect(
    await listPullRequestCandidates(db, { limit: 0, after: null }),
  ).toMatchObject({ ok: false, error: { class: "validation" } });
  const watch = unwrap(await pullRequestWatch(db, "T1"));
  expect(watch).toMatchObject({
    ticket_key: expect.stringMatching(/-1$/),
    open: [
      {
        repo_id: "r1",
        pr_url: PR("r1"),
        pr_number: 1,
        target_url: "https://forge.test/o/r1.git",
        error: null,
      },
    ],
  });
  // A row from before 039 has no remote_url: the repo's push target stands in.
  unwrap(await updateRowForTest(db, "deliveries", "D0", { remote_url: null }));
  unwrap(
    await updateRowForTest(db, "repos", "r1", {
      push_url: "git@forge.test:o/pushed.git",
    }),
  );
  expect(unwrap(await pullRequestWatch(db, "T1")).open[0]?.target_url).toBe(
    "git@forge.test:o/pushed.git",
  );
  expect(await pullRequestWatch(db, "nope")).toMatchObject({
    ok: false,
    error: { class: "not_found" },
  });
});

// a ticket already closed when it was delivered keeps its open request watched until it
// settles, and the end recorded moves nothing.
describe("a closed ticket's open request", () => {
  test.each(["done", "rejected"])(
    "a %s ticket is a candidate while a request is open, and only then",
    async (status) => {
      const { db } = await fresh({ status });
      expect(
        unwrap(await listPullRequestCandidates(db, { limit: 5, after: null })),
      ).toEqual([{ id: "T1", status, updated_at: T0 }]);
      unwrap(
        await updateRowForTest(db, "deliveries", "D0", { state: "closed" }),
      );
      expect(
        unwrap(await listPullRequestCandidates(db, { limit: 5, after: null })),
      ).toEqual([]);
    },
  );

  test("a done ticket with a merged request is not a candidate", async () => {
    const { db } = await fresh({ status: "done", states: { r1: "merged" } });
    expect(
      unwrap(await listPullRequestCandidates(db, { limit: 5, after: null })),
    ).toEqual([]);
  });

  test("closed later: the row is closed, the ticket does not move, and the operator hears the work never landed", async () => {
    const { db } = await fresh({ status: "done" });
    const before = await ticketOf(db);
    const out = unwrap(await settle(db, [{ repo_id: "r1", kind: "closed" }]));
    expect(out).toEqual({
      merged: [],
      closed: [PR("r1")],
      filed: 1,
      advance: null,
    });
    expect(await ticketOf(db)).toEqual(before);
    expect(unwrap(await dumpAllRows(db)).deliveries).toMatchObject([
      { state: "closed", ended_at: T0, error: null },
    ]);
    expect(unwrap(await dumpAllRows(db)).human_requests).toMatchObject([
      {
        kind: "delivery",
        question: `PR closed without merging on a done ticket: ${PR("r1")}`,
        context_md:
          "FRM-1 is done, but its pull request on `r1` was closed unmerged — the work has not landed. Reopen the PR, or reopen the ticket.",
        dedupe_key: "delivery:T1:closed/r1#1",
      },
    ]);
    // Settled: the same observation again files nothing.
    expect(
      unwrap(await settle(db, [{ repo_id: "r1", kind: "closed" }])).filed,
    ).toBe(0);
    const events = await eventsOf(db);
    expect(events.map((e) => e.kind).sort()).toEqual([
      "delivery",
      "human_request",
    ]);
    expect(
      unwrap(await listPullRequestCandidates(db, { limit: 5, after: null })),
    ).toEqual([]);
  });

  test("merged later: the row is merged, and the done ticket takes no step", async () => {
    const { db } = await fresh({ status: "done" });
    const before = await ticketOf(db);
    const out = unwrap(await settle(db, [merged("r1")]));
    expect(out).toEqual({
      merged: [PR("r1")],
      closed: [],
      filed: 0,
      advance: null,
    });
    expect(await ticketOf(db)).toEqual(before);
    expect(unwrap(await dumpAllRows(db)).deliveries).toMatchObject([
      { state: "merged", merged_by: "a-merger", merged_at: T0 - 5 },
    ]);
    expect((await eventsOf(db)).map((e) => e.kind)).toEqual(["delivery"]);
    const audit = unwrap(await listAudit(db)).map((a) => a.action);
    expect(audit).toContain(PULL_REQUESTS_ACTION);
    expect(audit).not.toContain("supervisor.advance_ticket");
    expect(
      unwrap(await listPullRequestCandidates(db, { limit: 5, after: null })),
    ).toEqual([]);
  });

  test("a rejected ticket's request, closed or merged, moves nothing and asks nothing", async () => {
    const { db } = await fresh({ status: "rejected", repos: ["r1", "r2"] });
    const before = await ticketOf(db);
    const out = unwrap(
      await settle(db, [merged("r1"), { repo_id: "r2", kind: "closed" }]),
    );
    expect(out).toMatchObject({
      merged: [PR("r1")],
      closed: [PR("r2")],
      filed: 0,
      advance: null,
    });
    expect(await ticketOf(db)).toEqual(before);
    expect(await requestsOf(db)).toEqual([]);
  });

  const refusal: PullRequestSeen = {
    repo_id: "r1",
    kind: "error",
    error: "forge.test refused pull request #1 (HTTP 401)",
    retryable: false,
  };

  test("a rejected ticket's unreadable request records the error and asks nothing", async () => {
    const { db } = await fresh({ status: "rejected" });
    expect(unwrap(await settle(db, [refusal])).filed).toBe(0);
    expect(unwrap(await dumpAllRows(db)).deliveries).toMatchObject([
      { state: "pr_open", error: refusal.error },
    ]);
    expect(await requestsOf(db)).toEqual([]);
  });

  test("a done ticket's unreadable request still asks once", async () => {
    const { db } = await fresh({ status: "done" });
    expect(unwrap(await settle(db, [refusal])).filed).toBe(1);
    expect((await requestsOf(db)).map((r) => r.question)).toEqual([
      `FRM-1's pull request could not be read: ${PR("r1")}`,
    ]);
  });
});

test("a new delivery of the repo forgets the merge an earlier poll recorded", async () => {
  const { db } = await fresh({ closeOnMerge: 0 });
  unwrap(await settle(db, [merged("r1")]));
  unwrap(
    await recordDelivery(db, {
      ticket_id: "T1",
      repo_id: "r1",
      branch: "frm/s",
      head_sha: "def",
      remote_host: "forge.test",
      remote_url: "https://forge.test/o/r1.git",
      state: "pr_open",
      pr_url: "https://forge.test/o/r1/pull/2",
      pr_number: 2,
      error: null,
      started_at: T0,
    }),
  );
  expect(unwrap(await dumpAllRows(db)).deliveries).toMatchObject([
    { state: "pr_open", merged_at: null, merged_by: null, pr_number: 2 },
  ]);
});

test("a bad settle is refused before anything is read", async () => {
  const { db } = await fresh();
  expect(
    await settlePullRequests(db, {
      ticket_id: "",
      ticket_key: "FRM-1",
      seen: [],
    }),
  ).toMatchObject({ ok: false, error: { class: "validation" } });
  expect(
    await settlePullRequests(db, {
      ticket_id: "nope",
      ticket_key: "FRM-1",
      seen: [],
    }),
  ).toMatchObject({ ok: false, error: { class: "not_found" } });
});

test("a ticket not in a status a merge closes records the merge and takes no step", async () => {
  const { db } = await fresh({ status: "building" });
  const out = unwrap(await settle(db, [merged("r1")]));
  expect(out).toMatchObject({ merged: [PR("r1")], advance: null });
  expect(await ticketOf(db)).toMatchObject({ status: "building" });
});

test("the transition says who merged it as a string, even when the forge named no one", async () => {
  const { db } = await fresh();
  unwrap(await settle(db, [merged("r1", null)]));
  const transition = (await eventsOf(db)).find((e) => e.kind === "transition");
  const payload = JSON.parse(transition?.payload_json ?? "{}") as Record<
    string,
    unknown
  >;
  expect(payload).toEqual({
    rule: "merge_close",
    merged_by: "unknown",
    pr_urls: [PR("r1")],
  });
});

//, HIGH 1: settle hands advanceTicketIn the merge whenever the ticket sits where a
// merge closes it. When the step then taken is the harness's, not merge_close, the move must carry
// no merge at all — else the timeline, the audit log and the Jira write-back say "Merged by …" of a
// QA verdict.
describe("a harness step taken while the merge is incomplete carries no merge", () => {
  const noMerge = async (db: Db, rule: string) => {
    const transition = (await eventsOf(db)).find(
      (e) => e.kind === "transition",
    );
    const payload = JSON.parse(transition?.payload_json ?? "{}") as Record<
      string,
      unknown
    >;
    expect(payload.rule).toBe(rule);
    expect(payload).not.toHaveProperty("merged_by");
    expect(payload).not.toHaveProperty("pr_urls");
    const audit = unwrap(await listAudit(db)).filter(
      (a) => a.action === "supervisor.advance_ticket",
    );
    expect(audit).toHaveLength(1);
    const logged = JSON.parse(audit[0]?.payload_json ?? "{}") as Record<
      string,
      unknown
    >;
    expect(logged).toMatchObject({ rule });
    expect(logged).not.toHaveProperty("merged_by");
    expect(logged).not.toHaveProperty("pr_urls");
  };

  test("fail_harness, one request merged and another still open", async () => {
    const { db } = await fresh({ status: "qa_harness", repos: ["r1", "r2"] });
    unwrap(
      await seedRows(db, {
        gates: [
          {
            id: "G-fail",
            ticket_id: "T1",
            kind: "qa_harness",
            state: "failed",
            subject_kind: "commit",
            subject_ref: "abc",
            evidence_json: JSON.stringify({
              ...EVIDENCE,
              reason: "blocking_findings",
            }),
            started_at: T0,
            decided_at: T0,
          },
        ],
        findings: [findingRow("F1", "G-fail")],
      }),
    );
    const out = unwrap(
      await settle(db, [merged("r1"), { repo_id: "r2", kind: "open" }]),
    );
    expect(out.advance).toMatchObject({ advanced: true, rule: "fail_harness" });
    await noMerge(db, "fail_harness");
  });

  test("pass_harness on a waived gate, one request merged and another closed unmerged", async () => {
    const { db } = await fresh({ status: "qa_harness", repos: ["r1", "r2"] });
    unwrap(
      await seedRows(db, {
        gates: [
          {
            id: "G-waived",
            ticket_id: "T1",
            kind: "qa_harness",
            state: "waived",
            waived_by: "operator",
            waive_reason: "checked by hand",
            subject_kind: "commit",
            subject_ref: "abc",
            started_at: T0,
            decided_at: T0,
          },
        ],
      }),
    );
    exec(
      db,
      `INSERT INTO qa_runs (id, ticket_id, gate_id, state, started_at) VALUES ('Q1', 'T1', 'G-waived', 'passed', ${T0})`,
    );
    const out = unwrap(
      await settle(db, [merged("r1"), { repo_id: "r2", kind: "closed" }]),
    );
    expect(out.advance).toMatchObject({ advanced: true, rule: "pass_harness" });
    await noMerge(db, "pass_harness");
  });
});
