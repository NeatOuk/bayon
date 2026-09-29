import { FakeClock, type DeliveryMode, type DeliveryMoment } from "@bayon/core";
import { afterEach, expect, test } from "vitest";
import {
  dumpAllRows,
  listAudit,
  seedRows,
  tempDb,
  unwrap,
  type TempDb,
} from "../testing.js";
import { deliveryPlan, listDeliveryCandidates } from "./delivery-reads.js";
import { setProjectSettings } from "./project-settings.js";
import {
  DELIVERY_ERROR_MAX,
  commitDelivery,
  recordDelivery,
  type DeliveryRecord,
} from "./delivery-writes.js";

// What the delivery sweep reads and writes, against a real temp database. Two rules are
// what these tests exist for: a project that delivers nothing is never a candidate, and one row per
// (ticket, repo) is replaced in place — which is what makes the job idempotent.

const T0 = 1_700_000_000_000;
let t: TempDb | null = null;

afterEach(() => {
  t?.cleanup();
  t = null;
});

const repo = (id: string, submodule: string | null = null) => ({
  id,
  name: id,
  origin_url: `/remotes/${id}.git`,
  mirror_path: `/mirrors/${id}.git`,
  default_base_branch: submodule === null ? "main" : "trunk",
  doctrine_paths_json: "[]",
});

interface ProjectSpec {
  readonly id: string;
  readonly mode?: DeliveryMode;
  readonly when?: DeliveryMoment;
  readonly repos?: readonly (readonly [string, string | null])[];
}

interface TicketSpec {
  readonly id: string;
  readonly project: string;
  readonly status: string;
  readonly updated_at?: number;
  readonly branches?: Readonly<Record<string, string>>;
}

async function fresh(
  projects: readonly ProjectSpec[],
  tickets: readonly TicketSpec[],
) {
  const clock = new FakeClock(T0);
  const temp = unwrap(await tempDb(clock));
  t = temp;
  // Two projects in one test each bring their own repos: a repo id is unique across them.
  const repos = [
    ...new Map(
      projects
        .flatMap((p) => p.repos ?? [["r1", null] as const])
        .map(([id, path]) => [id, repo(id, path)] as const),
    ).values(),
  ];
  unwrap(
    await seedRows(temp.db, {
      repos,
      // Delivery turned on at T0 and each ticket filed into its status then, as the writers leave
      // them (047): every ticket here reached its moment once delivery was on.
      workspaces: projects.map((p) => ({
        id: p.id,
        name: p.id,
        kind: "single" as const,
        delivery_mode: p.mode ?? "push",
        delivery_when: p.when ?? "review_passed",
        delivery_since: (p.mode ?? "push") === "none" ? null : T0,
      })),
      workspace_repos: projects.flatMap((p) =>
        (p.repos ?? [["r1", null]]).map(([id, path]) => ({
          workspace_id: p.id,
          repo_id: id,
          rel_path: id,
          role: path === null ? "primary" : "dep",
          submodule_path: path,
        })),
      ),
      tickets: tickets.map((tk, i) => ({
        id: tk.id,
        num: i + 1,
        title: `t${i + 1}`,
        type: "chore" as const,
        status: tk.status,
        origin: "operator",
        workspace_id: tk.project,
        created_at: T0,
        updated_at: tk.updated_at ?? T0,
      })),
      ticket_events: tickets.map((tk) => ({
        ticket_id: tk.id,
        ts: T0,
        actor_kind: "operator",
        kind: "created",
        to_status: tk.status,
      })),
      worktrees: tickets.flatMap((tk, i) =>
        Object.entries(tk.branches ?? {}).map(([repoId, branch], j) => ({
          id: `wt-${i}-${j}`,
          session_root: "/root",
          workspace_id: tk.project,
          repo_id: repoId,
          path: `/root/${repoId}`,
          branch,
          base_sha: "0".repeat(40),
          ticket_id: tk.id,
          state: "idle" as const,
          created_at: T0 + j,
        })),
      ),
    }),
  );
  return { db: temp.db, clock };
}

const page = (db: Parameters<typeof listDeliveryCandidates>[0]) =>
  listDeliveryCandidates(db, { limit: 10, after: null });

test("only a delivering project's tickets, and only at a deliverable status", async () => {
  const { db } = await fresh(
    [
      { id: "P-on", repos: [["r-on", null]] },
      { id: "P-off", mode: "none", repos: [["r-off", null]] },
    ],
    [
      { id: "T-due", project: "P-on", status: "qa_human" },
      { id: "T-early", project: "P-on", status: "code_review" },
      { id: "T-back", project: "P-on", status: "rework" },
      { id: "T-quiet", project: "P-off", status: "done" },
    ],
  );
  expect(unwrap(await page(db)).map((c) => c.id)).toEqual(["T-due"]);
});

test("the candidates page from where the last one ended", async () => {
  const { db } = await fresh(
    [{ id: "P" }],
    [
      { id: "T-1", project: "P", status: "qa_human", updated_at: 1 },
      { id: "T-2", project: "P", status: "done", updated_at: 2 },
      { id: "T-3", project: "P", status: "qa_harness", updated_at: 3 },
    ],
  );
  const first = unwrap(
    await listDeliveryCandidates(db, { limit: 2, after: null }),
  );
  expect(first.map((c) => c.id)).toEqual(["T-1", "T-2"]);
  const next = unwrap(
    await listDeliveryCandidates(db, {
      limit: 2,
      after: { updated_at: 2, id: "T-2" },
    }),
  );
  expect(next.map((c) => c.id)).toEqual(["T-3"]);
});

test("a limit outside its bounds is refused rather than guessed", async () => {
  const { db } = await fresh([{ id: "P" }], []);
  const bad = await listDeliveryCandidates(db, { limit: 0, after: null });
  expect(bad.ok).toBe(false);
  if (!bad.ok) expect(bad.error.class).toBe("validation");
});

test("a plan that is not due carries the config and no repos at all", async () => {
  const { db } = await fresh(
    [{ id: "P", when: "done" }],
    [
      {
        id: "T",
        project: "P",
        status: "qa_human",
        branches: { r1: "frm/s1" },
      },
    ],
  );
  const plan = unwrap(await deliveryPlan(db, "T"));
  expect(plan).toMatchObject({
    due: false,
    repos: [],
    config: { mode: "push", when: "done" },
    ticket_key: "FRM-1",
  });
});

test("a due plan lists submodules before the parent, with each repo's own base", async () => {
  const { db } = await fresh(
    [
      {
        id: "P",
        repos: [
          ["super", null],
          ["dep", "deps/dep"],
        ],
      },
    ],
    [
      {
        id: "T",
        project: "P",
        status: "done",
        branches: { super: "frm/s1", dep: "frm/s1" },
      },
    ],
  );
  const plan = unwrap(await deliveryPlan(db, "T"));
  expect(plan.due).toBe(true);
  expect(plan.repos.map((r) => r.repo_id)).toEqual(["dep", "super"]);
  expect(plan.repos[0]).toMatchObject({
    submodule_path: "deps/dep",
    default_base_branch: "trunk",
    branch: "frm/s1",
    delivered: null,
  });
});

test("a plan carries each repo's push target beside its origin (039)", async () => {
  const { db } = await fresh(
    [
      {
        id: "P",
        repos: [
          ["super", null],
          ["dep", "deps/dep"],
        ],
      },
    ],
    [
      {
        id: "T",
        project: "P",
        status: "done",
        branches: { super: "frm/s1", dep: "frm/s1" },
      },
    ],
  );
  unwrap(
    await setProjectSettings(
      db,
      "P",
      {
        push_urls: [
          { repo_id: "super", push_url: "git@forge.example:o/s.git" },
        ],
      },
      "operator",
    ),
  );
  const plan = unwrap(await deliveryPlan(db, "T"));
  expect(plan.repos.map((r) => [r.repo_id, r.origin_url, r.push_url])).toEqual([
    ["dep", "/remotes/dep.git", null],
    ["super", "/remotes/super.git", "git@forge.example:o/s.git"],
  ]);
});

test("a repo with no session branch is not in the plan", async () => {
  const { db } = await fresh(
    [
      {
        id: "P",
        repos: [
          ["a", null],
          ["b", null],
        ],
      },
    ],
    [
      {
        id: "T",
        project: "P",
        status: "done",
        // A reviewer's detached worktree is no branch of a session's.
        branches: { a: "frm/s1", b: "detached@abc123" },
      },
    ],
  );
  const plan = unwrap(await deliveryPlan(db, "T"));
  expect(plan.repos.map((r) => r.repo_id)).toEqual(["a"]);
});

test("a ticket in no project, and one that does not exist, are both refused", async () => {
  const { db } = await fresh([{ id: "P" }], []);
  unwrap(
    await seedRows(db, {
      tickets: [
        {
          id: "T-loose",
          num: 9,
          title: "loose",
          type: "chore",
          status: "done",
          origin: "operator",
          workspace_id: null,
          created_at: T0,
          updated_at: T0,
        },
      ],
    }),
  );
  const loose = await deliveryPlan(db, "T-loose");
  expect(loose.ok).toBe(false);
  if (!loose.ok) expect(loose.error.class).toBe("validation");
  const missing = await deliveryPlan(db, "T-nope");
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.error.class).toBe("not_found");
});

const record = (over: Partial<DeliveryRecord> = {}): DeliveryRecord => ({
  ticket_id: "T",
  repo_id: "r1",
  branch: "frm/s1",
  head_sha: "a".repeat(40),
  remote_host: null,
  remote_url: null,
  state: "pushed",
  pr_url: null,
  pr_number: null,
  error: null,
  started_at: T0,
  ...over,
});

async function delivering() {
  return fresh(
    [{ id: "P" }],
    [{ id: "T", project: "P", status: "done", branches: { r1: "frm/s1" } }],
  );
}

test("a second record for the same (ticket, repo) replaces the first", async () => {
  const { db } = await delivering();
  const first = unwrap(await recordDelivery(db, record()));
  const second = unwrap(
    await recordDelivery(
      db,
      record({
        head_sha: "b".repeat(40),
        state: "pr_open",
        pr_url: "u",
        pr_number: 3,
      }),
    ),
  );
  expect(second.id).toBe(first.id);
  const rows = unwrap(await dumpAllRows(db)).deliveries ?? [];
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    head_sha: "b".repeat(40),
    state: "pr_open",
    pr_url: "u",
    pr_number: 3,
  });
});

test("an over-long error is capped rather than stored whole", async () => {
  const { db } = await delivering();
  unwrap(
    await recordDelivery(
      db,
      record({ state: "failed", error: "x".repeat(5_000) }),
    ),
  );
  const rows = (unwrap(await dumpAllRows(db)).deliveries ??
    []) as readonly Record<string, unknown>[];
  expect(String(rows[0]?.error)).toHaveLength(DELIVERY_ERROR_MAX);
});

test("a record with an impossible shape is refused, not written", async () => {
  const { db } = await delivering();
  const bad = await recordDelivery(db, record({ branch: "" }));
  expect(bad.ok).toBe(false);
  if (!bad.ok) expect(bad.error.class).toBe("validation");
  expect(unwrap(await dumpAllRows(db)).deliveries ?? []).toHaveLength(0);
});

test("a commit writes the rows, the links, pr_url, one audit row and one timeline entry", async () => {
  const { db } = await delivering();
  const out = unwrap(
    await commitDelivery(db, {
      ticket_id: "T",
      records: [
        record({
          state: "pr_open",
          pr_url: "https://f.test/pull/1",
          pr_number: 1,
        }),
      ],
      prs: [{ repo_id: "r1", url: "https://f.test/pull/1" }],
      pr_url: "https://f.test/pull/1",
      note: "delivered",
    }),
  );
  expect(out).toMatchObject({ linked: 1, pr_url: "https://f.test/pull/1" });
  const rows = unwrap(await dumpAllRows(db));
  expect(rows.ticket_links).toEqual([
    expect.objectContaining({
      ticket_id: "T",
      kind: "pr",
      url: "https://f.test/pull/1",
    }),
  ]);
  expect((rows.tickets ?? [])[0]).toMatchObject({
    pr_url: "https://f.test/pull/1",
  });
  const audit = unwrap(await listAudit(db));
  expect(audit).toEqual([
    expect.objectContaining({
      actor: "supervisor",
      action: "supervisor.delivery",
    }),
  ]);
  const events = (rows.ticket_events ?? []) as readonly Record<
    string,
    unknown
  >[];
  expect(events.filter((e) => e.kind === "delivery")).toHaveLength(1);
});

test("committing the same delivery again adds no second link and moves nothing", async () => {
  const { db } = await delivering();
  const commit = {
    ticket_id: "T",
    records: [
      record({
        state: "pr_open",
        pr_url: "https://f.test/pull/1",
        pr_number: 1,
      }),
    ],
    prs: [{ repo_id: "r1", url: "https://f.test/pull/1" }],
    pr_url: "https://f.test/pull/1",
    note: "",
  };
  unwrap(await commitDelivery(db, commit));
  const before = unwrap(await dumpAllRows(db));
  const again = unwrap(await commitDelivery(db, commit));
  expect(again.linked).toBe(0);
  const after = unwrap(await dumpAllRows(db));
  expect(after.ticket_links).toEqual(before.ticket_links);
  expect(after.tickets).toEqual(before.tickets);
});

test("a commit never clears a pr_url it has none for, and an unknown ticket is refused", async () => {
  const { db } = await delivering();
  unwrap(
    await commitDelivery(db, {
      ticket_id: "T",
      records: [record({ state: "pr_open", pr_url: "u1", pr_number: 1 })],
      prs: [{ repo_id: "r1", url: "u1" }],
      pr_url: "u1",
      note: "",
    }),
  );
  const kept = unwrap(
    await commitDelivery(db, {
      ticket_id: "T",
      records: [record()],
      prs: [],
      pr_url: null,
      note: "",
    }),
  );
  expect(kept.pr_url).toBe("u1");

  const missing = await commitDelivery(db, {
    ticket_id: "T-nope",
    records: [],
    prs: [],
    pr_url: null,
    note: "",
  });
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.error.class).toBe("not_found");

  const empty = await commitDelivery(db, {
    ticket_id: "  ",
    records: [],
    prs: [],
    pr_url: null,
    note: "",
  });
  expect(empty.ok).toBe(false);
  if (!empty.ok) expect(empty.error.class).toBe("validation");
});

test("a record whose remote_url still carries a credential is refused, not written (039)", async () => {
  const { db } = await fresh(
    [{ id: "P" }],
    [{ id: "T", project: "P", status: "done" }],
  );
  const refused = await recordDelivery(
    db,
    record({ remote_url: "https://me:a-secret@forge.example/o/r.git" }),
  );
  expect(refused).toMatchObject({ ok: false, error: { class: "validation" } });
  expect(unwrap(await dumpAllRows(db)).deliveries ?? []).toHaveLength(0);
  const kept = unwrap(
    await recordDelivery(
      db,
      record({ remote_url: "ssh://git@forge.example/o/r.git" }),
    ),
  );
  expect(kept.remote_url).toBe("ssh://git@forge.example/o/r.git");
});

test("close_on_merge is set through the audited door, and only a change writes (040)", async () => {
  const { db } = await fresh([{ id: "P", mode: "pull_request" }], []);
  const off = unwrap(
    await setProjectSettings(
      db,
      "P",
      {
        delivery: {
          mode: "pull_request",
          when: "review_passed",
          close_on_merge: false,
        },
      },
      "operator",
    ),
  );
  expect(off).toMatchObject({
    changed: true,
    delivery: { mode: "pull_request", close_on_merge: false },
  });
  const workspaces = unwrap(await dumpAllRows(db)).workspaces as {
    close_on_merge: number;
  }[];
  expect(workspaces.map((w) => w.close_on_merge)).toEqual([0]);
  const audit = unwrap(await listAudit(db)).filter(
    (a) => a.action === "project.set",
  );
  expect(audit.map((a) => JSON.parse(a.payload_json ?? "{}"))).toEqual([
    {
      delivery: {
        mode: "pull_request",
        when: "review_passed",
        close_on_merge: false,
      },
    },
  ]);
  const again = unwrap(
    await setProjectSettings(
      db,
      "P",
      {
        delivery: {
          mode: "pull_request",
          when: "review_passed",
          close_on_merge: false,
        },
      },
      "operator",
    ),
  );
  expect(again.changed).toBe(false);
});
