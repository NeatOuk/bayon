// The Jira mirror's doors against a real temp database: a page files backlog tickets,
// a replay writes nothing, a change reaches only an unstarted ticket, a departed unstarted ticket is
// parked with its note while a started one is left alone, another project's issue is skipped, and
// the reads see exactly the tickets the mirror may still move.
import {
  FakeClock,
  err,
  jiraFingerprint,
  ok,
  type ComplexityColumns,
  type JiraMirrorItem,
} from "@bayon/core";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import {
  dumpAllRows,
  seedRows,
  tempDb,
  ticketRow,
  unwrap,
  type TempDb,
} from "../testing.js";
import { appendAudit } from "./audit.js";
import { lastJiraSync, mirroredOpenFingerprints } from "./jira-reads.js";
import { mirrorJiraPage, parkDepartedJira } from "./jira-mirror.js";
import { findTicketByFingerprint } from "./tickets.js";
import { transitionTicket, type Decide } from "./ticket-transition.js";

const T0 = 1_700_000_000_000;
const HOST = "acme.atlassian.net";
const opened: TempDb[] = [];
afterEach(() => {
  for (const t of opened.splice(0)) t.cleanup();
});

async function fresh() {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  opened.push(t);
  unwrap(
    await seedRows(t.db, {
      workspaces: [
        { id: "P-A", name: "P-A", kind: "single" },
        { id: "P-B", name: "P-B", kind: "single" },
      ],
    }),
  );
  return { db: t.db, clock };
}

const COMPLEXITY: ComplexityColumns = {
  complexity_score: 0,
  complexity_tier: "standard",
  non_trivial: 0,
  complexity_factors_json: '{"facts":{}}',
};

const item = (id: string, o: Partial<JiraMirrorItem> = {}): JiraMirrorItem => ({
  issue_id: id,
  fingerprint: jiraFingerprint(HOST, id),
  origin_ref: `ABC-${id}`,
  title: `Issue ${id}`,
  body_md: `Jira: [ABC-${id}](https://${HOST}/browse/ABC-${id})`,
  type: "feature",
  priority: 3,
  status_category: "new",
  status_name: "To Do",
  ...o,
});

const page = (items: readonly JiraMirrorItem[], workspaceId = "P-A") => ({
  workspaceId,
  host: HOST,
  items,
  complexity: COMPLEXITY,
});

const allow: Decide = () => ok(undefined);

const ticketOf = async (db: TempDb["db"], id: string) => {
  const found = unwrap(
    await findTicketByFingerprint(db, jiraFingerprint(HOST, id)),
  );
  if (found === null) throw new Error(`no ticket for issue ${id}`);
  return found;
};

const TicketEvents = z.array(
  z.object({
    ticket_id: z.string(),
    kind: z.string(),
    actor_kind: z.string(),
    actor_id: z.string().nullable(),
    reason: z.string().nullable(),
    from_status: z.string().nullable(),
    to_status: z.string().nullable(),
    payload_json: z.string().nullable(),
  }),
);
const eventsOf = async (db: TempDb["db"]) =>
  TicketEvents.parse(unwrap(await dumpAllRows(db)).ticket_events);

test("a first page files backlog tickets with their origin, ref and fingerprint", async () => {
  const { db } = await fresh();
  expect(
    unwrap(
      await mirrorJiraPage(
        db,
        page([item("10001", { type: "bug", priority: 2 }), item("10002")]),
      ),
    ),
  ).toEqual({ created: 2, updated: 0, unchanged: 0, skipped: [] });

  const first = await ticketOf(db, "10001");
  expect(first).toMatchObject({
    title: "Issue 10001",
    type: "bug",
    priority: 2,
    status: "backlog",
    origin: "jira",
    origin_ref: "ABC-10001",
    origin_fingerprint: "jira:acme.atlassian.net:10001",
    workspace_id: "P-A",
    version: 1,
    needs_human: 0,
    ...COMPLEXITY,
  });
  expect(
    (await eventsOf(db)).map((e) => [
      e.kind,
      e.actor_kind,
      e.actor_id,
      e.to_status,
    ]),
  ).toEqual([
    ["created", "operator", "jira:acme.atlassian.net", "backlog"],
    ["created", "operator", "jira:acme.atlassian.net", "backlog"],
  ]);
});

test("a replay writes nothing: the same versions, no new ticket_events", async () => {
  const { db, clock } = await fresh();
  const items = [item("10001"), item("10002")];
  unwrap(await mirrorJiraPage(db, page(items)));
  const before = unwrap(await dumpAllRows(db));
  await clock.advance(60_000);
  expect(unwrap(await mirrorJiraPage(db, page(items)))).toEqual({
    created: 0,
    updated: 0,
    unchanged: 2,
    skipped: [],
  });
  const after = unwrap(await dumpAllRows(db));
  expect(after.tickets).toEqual(before.tickets);
  expect(after.ticket_events).toEqual(before.ticket_events);
});

test("an issue twice in one page is mirrored once", async () => {
  const { db } = await fresh();
  expect(
    unwrap(await mirrorJiraPage(db, page([item("10001"), item("10001")]))),
  ).toMatchObject({ created: 1 });
});

test("a changed summary updates a backlog ticket, and never a building one", async () => {
  const { db } = await fresh();
  unwrap(await mirrorJiraPage(db, page([item("10001")])));
  unwrap(
    await seedRows(db, {
      tickets: [
        ticketRow(90, {
          status: "building",
          origin: "jira",
          origin_ref: "ABC-10002",
          origin_fingerprint: jiraFingerprint(HOST, "10002"),
          workspace_id: "P-A",
          title: "Issue 10002",
        }),
      ],
    }),
  );
  expect(
    unwrap(
      await mirrorJiraPage(
        db,
        page([
          item("10001", { title: "Renamed", priority: 1 }),
          item("10002", { title: "Renamed too" }),
        ]),
      ),
    ),
  ).toEqual({ created: 0, updated: 1, unchanged: 1, skipped: [] });

  expect(await ticketOf(db, "10001")).toMatchObject({
    title: "Renamed",
    priority: 1,
    version: 2,
  });
  expect(await ticketOf(db, "10002")).toMatchObject({
    title: "Issue 10002",
    status: "building",
    version: 1,
  });
  const updated = (await eventsOf(db)).filter((e) => e.kind === "updated");
  expect(updated.map((e) => [e.actor_id, e.payload_json])).toEqual([
    ["jira:acme.atlassian.net", '{"fields":["priority","title"]}'],
  ]);
});

test("a prioritized ticket is still the mirror's: it takes a new body", async () => {
  const { db } = await fresh();
  unwrap(
    await seedRows(db, {
      tickets: [
        ticketRow(1, {
          status: "prioritized",
          origin: "jira",
          origin_ref: "ABC-10001",
          origin_fingerprint: jiraFingerprint(HOST, "10001"),
          workspace_id: "P-A",
          title: "Issue 10001",
          type: "feature",
          priority: 3,
        }),
      ],
    }),
  );
  expect(
    unwrap(await mirrorJiraPage(db, page([item("10001", { body_md: "new" })]))),
  ).toMatchObject({ updated: 1 });
  expect(await ticketOf(db, "10001")).toMatchObject({
    body_md: "new",
    status: "prioritized",
  });
});

test("an issue already mirrored into another project is skipped, naming it, and nothing is written", async () => {
  const { db } = await fresh();
  unwrap(await mirrorJiraPage(db, page([item("10001")], "P-B")));
  const before = unwrap(await dumpAllRows(db));
  expect(
    unwrap(await mirrorJiraPage(db, page([item("10001", { title: "Mine" })]))),
  ).toEqual({
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: [{ key: "ABC-10001", project: "P-B" }],
  });
  expect(unwrap(await dumpAllRows(db)).tickets).toEqual(before.tickets);
});

test("a fingerprint of another site is refused and writes nothing", async () => {
  const { db } = await fresh();
  const stray = item("10001", { fingerprint: "jira:evil.atlassian.net:10001" });
  expect(await mirrorJiraPage(db, page([item("10002"), stray]))).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
  expect(
    await parkDepartedJira(db, {
      workspaceId: "P-A",
      host: HOST,
      departed: [{ fingerprint: "probe:x", reason: "gone" }],
      decide: allow,
    }),
  ).toMatchObject({ ok: false, error: { class: "validation" } });
  expect(unwrap(await dumpAllRows(db)).tickets).toEqual([]);
});

test("a departed unstarted ticket is parked with its note; a started, a parked or another project's is left alone", async () => {
  const { db } = await fresh();
  unwrap(await mirrorJiraPage(db, page([item("10001"), item("10003")])));
  unwrap(await mirrorJiraPage(db, page([item("10004")], "P-B")));
  unwrap(
    await seedRows(db, {
      tickets: [
        ticketRow(90, {
          status: "building",
          origin: "jira",
          origin_fingerprint: jiraFingerprint(HOST, "10002"),
          workspace_id: "P-A",
        }),
      ],
    }),
  );
  const departed = [
    {
      fingerprint: jiraFingerprint(HOST, "10001"),
      reason: "moved to In Progress in Jira",
    },
    {
      fingerprint: jiraFingerprint(HOST, "10002"),
      reason: "no longer visible in Jira",
    },
    {
      fingerprint: jiraFingerprint(HOST, "10004"),
      reason: "no longer visible in Jira",
    },
    {
      fingerprint: jiraFingerprint(HOST, "10009"),
      reason: "no longer visible in Jira",
    },
  ];
  expect(
    unwrap(
      await parkDepartedJira(db, {
        workspaceId: "P-A",
        host: HOST,
        departed,
        decide: allow,
      }),
    ),
  ).toEqual({ parked: 1 });

  expect(await ticketOf(db, "10001")).toMatchObject({
    status: "parked",
    version: 2,
  });
  expect(await ticketOf(db, "10002")).toMatchObject({
    status: "building",
    version: 1,
  });
  expect(await ticketOf(db, "10003")).toMatchObject({ status: "backlog" });
  expect(await ticketOf(db, "10004")).toMatchObject({ status: "backlog" });
  const moves = (await eventsOf(db)).filter((e) => e.kind === "transition");
  expect(
    moves.map((e) => [
      e.from_status,
      e.to_status,
      e.actor_kind,
      e.actor_id,
      e.reason,
    ]),
  ).toEqual([
    [
      "backlog",
      "parked",
      "operator",
      "jira:acme.atlassian.net",
      "moved to In Progress in Jira",
    ],
  ]);

  // Again: the parked one is no longer unstarted, so nothing moves.
  expect(
    unwrap(
      await parkDepartedJira(db, {
        workspaceId: "P-A",
        host: HOST,
        departed,
        decide: allow,
      }),
    ),
  ).toEqual({ parked: 0 });
  expect(unwrap(await dumpAllRows(db)).tickets).toHaveLength(4);
});

test("a law refusal parks nothing: every park of the call rolls back", async () => {
  const { db } = await fresh();
  unwrap(await mirrorJiraPage(db, page([item("10001"), item("10002")])));
  let calls = 0;
  const refuseSecond: Decide = () => {
    calls += 1;
    return calls === 1
      ? ok(undefined)
      : err({ class: "law_refused", message: "no", retryable: false });
  };
  expect(
    await parkDepartedJira(db, {
      workspaceId: "P-A",
      host: HOST,
      departed: ["10001", "10002"].map((id) => ({
        fingerprint: jiraFingerprint(HOST, id),
        reason: "gone",
      })),
      decide: refuseSecond,
    }),
  ).toMatchObject({ ok: false, error: { class: "law_refused" } });
  expect((await ticketOf(db, "10001")).status).toBe("backlog");
});

test("mirroredOpenFingerprints: this project's unstarted tickets of this site, with their issue ids", async () => {
  const { db } = await fresh();
  unwrap(await mirrorJiraPage(db, page([item("10001"), item("10002")])));
  unwrap(await mirrorJiraPage(db, page([item("10003")], "P-B")));
  unwrap(
    await mirrorJiraPage(db, {
      ...page([
        item("10004", {
          fingerprint: jiraFingerprint("other.atlassian.net", "10004"),
        }),
      ]),
      host: "other.atlassian.net",
    }),
  );
  unwrap(
    await seedRows(db, {
      tickets: [
        ticketRow(90, {
          status: "prioritized",
          origin: "jira",
          origin_fingerprint: jiraFingerprint(HOST, "10005"),
          workspace_id: "P-A",
        }),
        ticketRow(91, {
          status: "staffed",
          origin: "jira",
          origin_fingerprint: jiraFingerprint(HOST, "10006"),
          workspace_id: "P-A",
        }),
        ticketRow(92, {
          status: "backlog",
          origin: "probe",
          origin_fingerprint: "jira:acme.atlassian.net:10007",
          workspace_id: "P-A",
        }),
      ],
    }),
  );
  unwrap(
    await parkDepartedJira(db, {
      workspaceId: "P-A",
      host: HOST,
      departed: [
        { fingerprint: jiraFingerprint(HOST, "10002"), reason: "gone" },
      ],
      decide: allow,
    }),
  );
  expect(unwrap(await mirroredOpenFingerprints(db, "P-A", HOST))).toEqual([
    {
      fingerprint: "jira:acme.atlassian.net:10001",
      issueId: "10001",
      status: "backlog",
    },
    {
      fingerprint: "jira:acme.atlassian.net:10005",
      issueId: "10005",
      status: "prioritized",
    },
  ]);
});

test("lastJiraSync: null before a sync, then the project's newest jira.sync row", async () => {
  const { db, clock } = await fresh();
  expect(unwrap(await lastJiraSync(db, "P-A"))).toBeNull();
  const sync = (project: string, n: number) =>
    appendAudit(db, {
      actor: "operator",
      action: "jira.sync",
      target_kind: "project",
      target_id: project,
      payload: { n },
    });
  unwrap(await sync("P-A", 1));
  await clock.advance(1_000);
  unwrap(await sync("P-A", 2));
  unwrap(await sync("P-B", 3));
  unwrap(
    await appendAudit(db, {
      actor: "operator",
      action: "project.set",
      target_kind: "project",
      target_id: "P-A",
    }),
  );
  expect(unwrap(await lastJiraSync(db, "P-A"))).toEqual({
    ts: T0 + 1_000,
    payload_json: '{"n":2}',
  });
});

/** Walks ticket `id` of issue `issue` through `path`, as REST's transitions would, one by one. */
async function walk(db: TempDb["db"], issue: string, path: readonly string[]) {
  for (const to of path) {
    const t = await ticketOf(db, issue);
    unwrap(
      await transitionTicket(
        db,
        {
          id: t.id,
          version: t.version,
          to,
          by: { actor_kind: "operator", actor_id: "operator" },
        },
        allow,
      ),
    );
  }
}

test("the loop guard: a ticket Bayon began is never parked or overwritten, even back among the unstarted; a never-begun one still is", async () => {
  const { db } = await fresh();
  unwrap(
    await mirrorJiraPage(
      db,
      page([item("10001"), item("10002"), item("10003"), item("10004")]),
    ),
  );
  // ask_human: begun, then back in prioritized while the operator answers.
  await walk(db, "10001", [
    "prioritized",
    "staffed",
    "spiking",
    "planned",
    "building",
    "prioritized",
  ]);
  // unpark: begun, set aside, then back in backlog.
  await walk(db, "10002", ["prioritized", "staffed", "parked", "backlog"]);
  // Prioritized, blocked and back, but never begun.
  await walk(db, "10003", ["prioritized", "blocked", "prioritized"]);

  // A second sync with every issue renamed: only the two never begun take the change.
  const before = {
    a: await ticketOf(db, "10001"),
    b: await ticketOf(db, "10002"),
  };
  expect(
    unwrap(
      await mirrorJiraPage(
        db,
        page(
          ["10001", "10002", "10003", "10004"].map((id) =>
            item(id, { title: `Renamed ${id}`, body_md: `new body ${id}` }),
          ),
        ),
      ),
    ),
  ).toMatchObject({ updated: 2, unchanged: 2 });
  for (const [issue, was] of [
    ["10001", before.a],
    ["10002", before.b],
  ] as const) {
    expect(await ticketOf(db, issue)).toMatchObject({
      title: was.title,
      body_md: was.body_md,
      version: was.version,
    });
  }
  expect((await ticketOf(db, "10003")).title).toBe("Renamed 10003");
  expect((await ticketOf(db, "10004")).body_md).toBe("new body 10004");

  // Only the two never begun are still the mirror's to park.
  expect(
    unwrap(await mirroredOpenFingerprints(db, "P-A", HOST)).map(
      (o) => o.issueId,
    ),
  ).toEqual(["10003", "10004"]);

  const departed = ["10001", "10002", "10003", "10004"].map((id) => ({
    fingerprint: jiraFingerprint(HOST, id),
    reason: "moved to In Progress in Jira",
  }));
  expect(
    unwrap(
      await parkDepartedJira(db, {
        workspaceId: "P-A",
        host: HOST,
        departed,
        decide: allow,
      }),
    ),
  ).toEqual({ parked: 2 });
  expect((await ticketOf(db, "10001")).status).toBe("prioritized");
  expect((await ticketOf(db, "10002")).status).toBe("backlog");
  expect((await ticketOf(db, "10003")).status).toBe("parked");
  expect((await ticketOf(db, "10004")).status).toBe("parked");
});
