import { FakeClock, ok, type FrmError } from "@bayon/core";
import { afterAll, describe, expect, test } from "vitest";
import { internalsOf } from "../connection.js";
import {
  OPERATOR,
  newSessionInput,
  newTicketInput,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
} from "../testing.js";
import { isMultiRepo, lintGateRepos } from "./law-facts.js";
import { listTicketEvents } from "./ticket-events.js";
import { getTicketFacts, listTicketWorktrees } from "./ticket-facts.js";
import { transitionTicket, type TransitionFacts } from "./ticket-transition.js";
import { createTicket } from "./ticket-writes.js";
import { getTicket } from "./tickets.js";

// TransitionFacts additions (the laws' actor session, the ticket's sessions, the
// prior status), their read-side snapshot, and the worktrees the git check diffs.

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

const SHA = "0".repeat(40);
let n = 0;

/** A backlog ticket held by a live session (with an active worktree) and an ended one. */
async function heldTicket() {
  n += 1;
  const ticket = unwrap(await createTicket(t.db, newTicketInput(), OPERATOR));
  unwrap(
    await seedRows(t.db, {
      sessions: [
        {
          ...newSessionInput(),
          id: `live-${n}`,
          ticket_id: ticket.id,
          state: "running",
          created_at: 1,
        },
        {
          ...newSessionInput(),
          id: `ended-${n}`,
          ticket_id: ticket.id,
          state: "exited",
          created_at: 2,
        },
      ],
      worktrees: [
        {
          id: `wt-${n}`,
          session_root: "/w",
          workspace_id: "ws-1",
          repo_id: "repo-1",
          path: `/w/${n}`,
          branch: `frm/${n}`,
          base_sha: SHA,
          ticket_id: ticket.id,
          session_id: `live-${n}`,
          state: "active",
          created_at: 0,
        },
      ],
    }),
  );
  return ticket;
}

/** Runs one transition whose decide only records what the facts say. */
async function observe<T>(
  id: string,
  version: number,
  to: string,
  look: (facts: TransitionFacts) => T,
): Promise<T> {
  let seen: T | undefined;
  unwrap(
    await transitionTicket(t.db, { id, version, to, by: OPERATOR }, (facts) => {
      seen = look(facts);
      return ok(undefined);
    }),
  );
  if (seen === undefined) throw new Error("decide did not run");
  return seen;
}

describe("TransitionFacts", () => {
  test("name any session, the ticket's sessions, and the prior status", async () => {
    const ticket = await heldTicket();
    await observe(ticket.id, 1, "blocked", () => null);
    const seen = await observe(ticket.id, 2, "backlog", (facts) => ({
      actor: facts.session(`live-${n}`)?.ticket_id,
      stranger: facts.session("nope"),
      sessions: facts.ticketSessions().map((s) => [s.id, s.state]),
      prior: facts.priorStatus(),
    }));
    expect(seen).toEqual({
      actor: ticket.id,
      stranger: null,
      sessions: [
        [`live-${n}`, "running"],
        [`ended-${n}`, "exited"],
      ],
      prior: "backlog",
    });
  });

  test("the prior status is null before any transition, then the latest into the current one", async () => {
    const ticket = unwrap(await createTicket(t.db, newTicketInput(), OPERATOR));
    expect(
      await observe(ticket.id, 1, "blocked", (f) => f.priorStatus()),
    ).toBeNull();
    await observe(ticket.id, 2, "prioritized", () => null);
    await observe(ticket.id, 3, "blocked", () => null);
    expect(await observe(ticket.id, 4, "parked", (f) => f.priorStatus())).toBe(
      "prioritized",
    );
  });
});

describe("getTicketFacts", () => {
  test("reads the same facts outside a write transaction", async () => {
    const ticket = await heldTicket();
    const txns = t.db.stats.txns;
    const snapshot = unwrap(await getTicketFacts(t.db, ticket.id, `live-${n}`));
    expect(t.db.stats.txns).toBe(txns);
    expect(snapshot).toMatchObject({
      ticket: { id: ticket.id, version: 1 },
      children: [],
      worktrees: [{ id: `wt-${n}`, state: "active" }],
      ticketSessions: [{ id: `live-${n}` }, { id: `ended-${n}` }],
      actorSession: { id: `live-${n}`, ticket_id: ticket.id },
      priorStatus: null,
    });
    expect(
      unwrap(await getTicketFacts(t.db, ticket.id, null)).actorSession,
    ).toBeNull();
  });

  test("an unknown ticket is not_found", async () => {
    expect(await getTicketFacts(t.db, "nope", null)).toMatchObject({
      ok: false,
      error: { class: "not_found" },
    });
  });
});

describe("listTicketWorktrees", () => {
  test("names each worktree's executor — kind and id — through its session", async () => {
    const ticket = await heldTicket();
    unwrap(
      await seedRows(t.db, {
        worktrees: [
          {
            id: `wt-${n}-orphan`,
            session_root: "/w",
            workspace_id: "ws-1",
            repo_id: "repo-1",
            path: `/w/${n}-orphan`,
            branch: `frm/${n}-orphan`,
            base_sha: SHA,
            ticket_id: ticket.id,
            session_id: null,
            state: "orphan",
            created_at: 5,
          },
        ],
      }),
    );
    expect(unwrap(await listTicketWorktrees(t.db, ticket.id))).toEqual([
      {
        id: `wt-${n}`,
        path: `/w/${n}`,
        branch: expect.any(String),
        workspace_id: expect.any(String),
        repo_id: expect.any(String),
        base_sha: SHA,
        head_sha: null,
        state: "active",
        session_id: `live-${n}`,
        executor_kind: "local",
        executor_id: "local",
      },
      {
        id: `wt-${n}-orphan`,
        path: `/w/${n}-orphan`,
        branch: `frm/${n}-orphan`,
        workspace_id: "ws-1",
        repo_id: "repo-1",
        base_sha: SHA,
        head_sha: null,
        state: "orphan",
        session_id: null,
        executor_kind: null,
        executor_id: null,
      },
    ]);
  });

  test("a reviewer's detached worktree is its gate's, never the ticket's", async () => {
    // The M3 smoke's round 2: code_review's reviewer worktree, the newest on the ticket, was taken
    // for the builder's, so ce_review ran on the reviewer's runner and agent.
    const ticket = await heldTicket();
    // The gate first: the reviewer session's gate_id references it.
    unwrap(
      await seedRows(t.db, {
        gates: [
          {
            id: `gate-${n}`,
            ticket_id: ticket.id,
            kind: "code_review",
            state: "running",
            attempt: 1,
            subject_kind: "diff",
            subject_ref: "unpinned",
            started_at: 3,
          },
        ],
      }),
    );
    unwrap(
      await seedRows(t.db, {
        sessions: [
          {
            ...newSessionInput(),
            id: `reviewer-${n}`,
            role: "reviewer",
            ticket_id: ticket.id,
            gate_id: `gate-${n}`,
            state: "running",
            created_at: 3,
          },
        ],
        worktrees: [
          {
            id: `wt-${n}-review`,
            session_root: "/w",
            workspace_id: "ws-1",
            repo_id: "repo-1",
            path: `/w/${n}-review`,
            branch: `detached@${SHA.slice(0, 12)}`,
            base_sha: SHA,
            ticket_id: ticket.id,
            session_id: `reviewer-${n}`,
            state: "active",
            created_at: 4,
          },
        ],
      }),
    );
    expect(
      unwrap(await listTicketWorktrees(t.db, ticket.id)).map((w) => w.id),
    ).toEqual([`wt-${n}`]);
  });
});

describe("§3.2: a transition and its ticket_event commit together", () => {
  test("a failed event insert leaves the status and version as they were", async () => {
    const ticket = unwrap(await createTicket(t.db, newTicketInput(), OPERATOR));
    const raw = unwrap(internalsOf(t.db)).raw;
    raw.exec(
      "CREATE TEMP TRIGGER fail_transition_event BEFORE INSERT ON ticket_events " +
        "WHEN NEW.kind = 'transition' BEGIN SELECT RAISE(ABORT, 'no event'); END",
    );
    try {
      const moved = await transitionTicket(
        t.db,
        { id: ticket.id, version: 1, to: "prioritized", by: OPERATOR },
        () => ok(undefined),
      );
      expect(moved.ok).toBe(false);
      expect(unwrap(await getTicket(t.db, ticket.id))).toEqual(ticket);
      const events = unwrap(
        await listTicketEvents(t.db, {
          ticket_id: ticket.id,
          since: 0,
          limit: 10,
        }),
      );
      expect(events.rows.map((e) => e.kind)).toEqual(["created"]);
    } finally {
      raw.exec("DROP TRIGGER fail_transition_event");
    }
  });

  test("a refusal from decide comes back as it was, and writes nothing", async () => {
    const ticket = unwrap(await createTicket(t.db, newTicketInput(), OPERATOR));
    const refusal: FrmError = {
      class: "law_refused",
      message: "prioritize: no",
      retryable: false,
      cause: { rule: "prioritize", reason: "actor_not_allowed", detail: "no" },
    };
    expect(
      await transitionTicket(
        t.db,
        { id: ticket.id, version: 1, to: "prioritized", by: OPERATOR },
        () => ({ ok: false, error: refusal }),
      ),
    ).toEqual({ ok: false, error: refusal });
    expect(unwrap(await getTicket(t.db, ticket.id)).version).toBe(1);
  });
});

// the fact `when: "multi_repo"` is judged on. `ticket_repos` is no substitute — a
// submodule workspace has one entry there and is exactly the case parity_check exists for.
describe("workspaceKind", () => {
  test.each([
    ["single", "ws-1"],
    ["multi", "ws-multi"],
    ["submodule", "ws-sub"],
  ])("reads %s through tickets.workspace_id", async (kind, id) => {
    if (id !== "ws-1") {
      unwrap(
        await seedRows(t.db, {
          workspaces: [{ id, name: id, kind: kind as "multi" }],
        }),
      );
    }
    const ticket = unwrap(
      await createTicket(
        t.db,
        { ...newTicketInput(), workspace_id: id },
        OPERATOR,
      ),
    );
    const facts = unwrap(await getTicketFacts(t.db, ticket.id, null));
    expect(facts.workspaceKind).toBe(kind);
  });

  test("a ticket with no workspace has no kind: nothing to check parity between", async () => {
    const ticket = unwrap(await createTicket(t.db, newTicketInput(), OPERATOR));
    const facts = unwrap(await getTicketFacts(t.db, ticket.id, null));
    expect(facts.workspaceKind).toBeNull();
  });
});

const gateSettings = (o: { parity_check?: boolean; lint_check?: boolean }) => ({
  wall_clock_ms: 1,
  blocking_severities: [],
  base_drift: "fail" as const,
  timeout_retries: 0,
  parity_check: o.parity_check ?? false,
  lint_check: o.lint_check ?? false,
  drift_rounds_max: 3,
});

// the fact `when: "lint_configured"` is judged on — the repos a lint_check
// opens for, which is per repo because the gate runs *that repo's* command in *that repo's*
// worktree. With no `ticket_repos` it is the one repo-less gate, `[null]`, pinned to the primary.
// Seeded once: every test below files its own ticket into this one workspace.
unwrap(
  await seedRows(t.db, {
    repos: [
      {
        id: "repo-lint",
        name: "repo-lint",
        mirror_path: "/m/repo-lint",
        lint_cmd: "pnpm -w lint",
      },
      {
        id: "repo-dep",
        name: "repo-dep",
        mirror_path: "/m/repo-dep",
        lint_cmd: "make dep-lint",
      },
      { id: "repo-quiet", name: "repo-quiet", mirror_path: "/m/repo-quiet" },
    ],
    workspaces: [{ id: "ws-lint", name: "ws-lint", kind: "multi" }],
    workspace_repos: [
      {
        workspace_id: "ws-lint",
        repo_id: "repo-lint",
        rel_path: ".",
        role: "primary",
      },
      {
        workspace_id: "ws-lint",
        repo_id: "repo-dep",
        rel_path: "dep",
        role: "dep",
      },
      {
        workspace_id: "ws-lint",
        repo_id: "repo-quiet",
        rel_path: "quiet",
        role: "dep",
      },
    ],
  }),
);

describe("lintRepos", () => {
  const lintTicket = async (repos: readonly string[]) => {
    const ticket = unwrap(
      await createTicket(
        t.db,
        { ...newTicketInput(), workspace_id: "ws-lint" },
        OPERATOR,
      ),
    );
    if (repos.length > 0) {
      unwrap(
        await seedRows(t.db, {
          ticket_repos: repos.map((repo_id) => ({
            ticket_id: ticket.id,
            repo_id,
          })),
        }),
      );
    }
    return unwrap(await getTicketFacts(t.db, ticket.id, null)).lintRepos;
  };

  test("no ticket_repos: the one repo-less gate, when the primary declares a command", async () => {
    expect(await lintTicket([])).toEqual([null]);
  });

  test("ticket_repos: one entry per repo that declares a command, and no other", async () => {
    expect(await lintTicket(["repo-lint", "repo-dep"])).toEqual([
      "repo-dep",
      "repo-lint",
    ]);
    // The case an earlier change was filed for: a repo with no command is an explicit skip, not a gate
    // whose job would have nothing to run.
    expect(await lintTicket(["repo-lint", "repo-quiet"])).toEqual([
      "repo-lint",
    ]);
    // The mirror case: the primary declares nothing to do with it — the dep's own command decides.
    expect(await lintTicket(["repo-quiet", "repo-dep"])).toEqual(["repo-dep"]);
    expect(await lintTicket(["repo-quiet"])).toEqual([]);
  });

  test("a workspace whose primary declares none, and a ticket with no workspace, read []", async () => {
    unwrap(
      await seedRows(t.db, {
        workspaces: [{ id: "ws-nolint", name: "ws-nolint", kind: "single" }],
        workspace_repos: [
          {
            workspace_id: "ws-nolint",
            repo_id: "repo-1",
            rel_path: ".",
            role: "primary",
          },
        ],
      }),
    );
    const withWs = unwrap(
      await createTicket(
        t.db,
        { ...newTicketInput(), workspace_id: "ws-nolint" },
        OPERATOR,
      ),
    );
    expect(
      unwrap(await getTicketFacts(t.db, withWs.id, null)).lintRepos,
    ).toEqual([]);
    const without = unwrap(
      await createTicket(t.db, newTicketInput(), OPERATOR),
    );
    expect(
      unwrap(await getTicketFacts(t.db, without.id, null)).lintRepos,
    ).toEqual([]);
  });
});

describe("lintGateRepos", () => {
  test("off (024's default): no repo, whatever the repos declare", () => {
    for (const repos of [[null], ["r1", "r2"], []]) {
      expect(lintGateRepos(repos, gateSettings({ lint_check: false }))).toEqual(
        [],
      );
    }
  });

  // The half that makes the switch safe to flip: a fleet with no lint command configured has
  // nothing for the gate to run, so turning it on changes nothing rather than stalling every
  // ticket behind a job with no command.
  test("on: the repos as the facts read them, empty included", () => {
    const on = gateSettings({ lint_check: true });
    expect(lintGateRepos([null], on)).toEqual([null]);
    expect(lintGateRepos(["r1"], on)).toEqual(["r1"]);
    expect(lintGateRepos([], on)).toEqual([]);
  });
});

describe("isMultiRepo", () => {
  const settings = (parity_check: boolean) => gateSettings({ parity_check });

  test("off (020's default): never, whatever the workspace is", () => {
    for (const kind of ["single", "multi", "submodule", null]) {
      expect(isMultiRepo(kind, settings(false))).toBe(false);
    }
  });

  test("on: every kind but single, and never a ticket with no workspace", () => {
    expect(isMultiRepo("multi", settings(true))).toBe(true);
    expect(isMultiRepo("submodule", settings(true))).toBe(true);
    expect(isMultiRepo("single", settings(true))).toBe(false);
    expect(isMultiRepo(null, settings(true))).toBe(false);
  });
});
