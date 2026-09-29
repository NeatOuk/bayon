import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import {
  SPINE_SEED,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "../testing.js";
import { createSession, updateSessionState } from "./sessions.js";
import {
  insertWorktree,
  listHandoffWorktrees,
  listSessionWorktrees,
  reassignWorktree,
  reassignWorktrees,
  setWorktreeState,
  setWorktreeSubmodules,
  type NewWorktree,
} from "./worktrees.js";

const T0 = 1_700_000_000_000;
const clock = new FakeClock(T0);
const t = unwrap(await tempDb(clock));
afterAll(() => t.cleanup());
unwrap(await seedSpine(t.db, 2));
unwrap(
  await seedRows(t.db, {
    repos: [{ id: "repo", name: "repo", mirror_path: "/m/repo" }],
    workspaces: [{ id: "ws", name: "ws", kind: "single" }],
  }),
);

const worktree = (path: string): NewWorktree => ({
  session_root: "/w/s",
  workspace_id: "ws",
  repo_id: "repo",
  path,
  branch: `frm/${SPINE_SEED.sessionId}`,
  base_sha: "abc123",
  session_id: SPINE_SEED.sessionId,
  state: "active",
});

test("insertWorktree stamps created_at; a second row on one path is a conflict", async () => {
  const row = unwrap(await insertWorktree(t.db, worktree("/w/s/repo")));
  expect(row).toMatchObject({
    state: "active",
    created_at: T0,
    last_used_at: null,
  });
  expect(row.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(await insertWorktree(t.db, worktree("/w/s/repo"))).toMatchObject({
    ok: false,
    error: { class: "conflict" },
  });
});

test("setWorktreeState moves a worktree and stamps last_used_at", async () => {
  await clock.advance(1); // a later created_at than the first row, so the order is by time
  const row = unwrap(await insertWorktree(t.db, worktree("/w/s/other")));
  await clock.advance(5);
  expect(unwrap(await setWorktreeState(t.db, row.id, "orphan"))).toMatchObject({
    state: "orphan",
    last_used_at: T0 + 6,
  });
  expect(await setWorktreeState(t.db, "nope", "orphan")).toMatchObject({
    ok: false,
    error: { class: "not_found" },
  });
});

test("listSessionWorktrees lists one session's worktrees, oldest first", async () => {
  const paths = unwrap(
    await listSessionWorktrees(t.db, SPINE_SEED.sessionId),
  ).map((w) => w.path);
  expect(paths).toEqual(["/w/s/repo", "/w/s/other"]);
  expect(unwrap(await listSessionWorktrees(t.db, "nope"))).toEqual([]);
});

// M2-c: a successor takes its predecessor's worktree over; the one row moves (path is UNIQUE).
async function ended(id: string, handoffIn: string | null = null) {
  unwrap(
    await createSession(t.db, {
      ...newSessionInput(),
      id,
      handoff_in_id: handoffIn,
    }),
  );
  unwrap(
    await updateSessionState(t.db, id, { from: ["pending"], to: "exited" }),
  );
}

test("reassignWorktree moves the row only while its ended holder has it; never a live one's", async () => {
  await ended("s-old");
  const wt = unwrap(
    await insertWorktree(t.db, {
      ...worktree("/w/h/repo"),
      session_id: "s-old",
    }),
  );
  await clock.advance(10);
  const now = clock.now();
  expect(
    unwrap(
      await reassignWorktree(t.db, {
        id: wt.id,
        from_session_id: "s-old",
        to_session_id: "s-new",
      }),
    ),
  ).toMatchObject({
    id: wt.id,
    path: "/w/h/repo",
    branch: wt.branch,
    session_id: "s-new",
    state: "active",
    last_used_at: now,
  });
  expect(unwrap(await listSessionWorktrees(t.db, "s-old"))).toEqual([]);
  const refused = [
    // taken already
    { id: wt.id, from_session_id: "s-old", to_session_id: "s-3" },
    // the spine's session is idle: live
    {
      id: unwrap(await listSessionWorktrees(t.db, SPINE_SEED.sessionId))[0]
        ?.id as string,
      from_session_id: SPINE_SEED.sessionId,
      to_session_id: "s-3",
    },
  ];
  for (const r of refused) {
    expect(await reassignWorktree(t.db, r)).toMatchObject({
      ok: false,
      error: { class: "conflict" },
    });
  }
  await ended("s-gone");
  const gone = unwrap(
    await insertWorktree(t.db, {
      ...worktree("/w/h/gone"),
      session_id: "s-gone",
      state: "removed",
    }),
  );
  expect(
    await reassignWorktree(t.db, {
      id: gone.id,
      from_session_id: "s-gone",
      to_session_id: "s-3",
    }),
  ).toMatchObject({ ok: false, error: { class: "conflict" } });
});

test("listHandoffWorktrees follows the chain: the from-session's, then an unaccepted successor's", async () => {
  await ended("p-1");
  await ended("p-other");
  unwrap(
    await seedRows(t.db, {
      tickets: [ticketRow(1)],
      handoffs: [
        {
          id: "H1",
          ticket_id: "ticket-1",
          from_session_id: "p-1",
          reason: "operator",
          facts_json: "{}",
          quality: "degraded",
          packet_path: ".foreman/handoff-1.md",
          packet_hash: "0".repeat(64),
          created_at: 0,
        },
      ],
    }),
  );
  const wt = unwrap(
    await insertWorktree(t.db, { ...worktree("/w/c/repo"), session_id: "p-1" }),
  );
  for (const [path, holder, state] of [
    ["/w/c/other", "p-other", "active"],
    ["/w/c/gone", "p-1", "merged"],
  ] as const) {
    unwrap(
      await insertWorktree(t.db, {
        ...worktree(path),
        session_id: holder,
        state,
      }),
    );
  }
  const chain = { id: "H1", from_session_id: "p-1" };
  expect(unwrap(await listHandoffWorktrees(t.db, chain))).toEqual([
    {
      ...wt,
      holder_id: "p-1",
      holder_state: "exited",
      holder_executor_id: "local",
    },
  ]);
  // A successor for H1 took it and died unaccepted: the chain still finds it, now its.
  await ended("succ-1", "H1");
  unwrap(
    await reassignWorktree(t.db, {
      id: wt.id,
      from_session_id: "p-1",
      to_session_id: "succ-1",
    }),
  );
  expect(
    unwrap(await listHandoffWorktrees(t.db, chain)).map((w) => [
      w.id,
      w.holder_id,
      w.holder_state,
    ]),
  ).toEqual([[wt.id, "succ-1", "exited"]]);
});

// an earlier change §9: a multi-repo hand-off moves every worktree at once, or none.
test("reassignWorktrees moves every row in one transaction, or none of them", async () => {
  await ended("m-old");
  const [app, lib] = [
    unwrap(
      await insertWorktree(t.db, {
        ...worktree("/w/m/app"),
        session_id: "m-old",
      }),
    ),
    unwrap(
      await insertWorktree(t.db, {
        ...worktree("/w/m/lib"),
        session_id: "m-old",
      }),
    ),
  ];
  const moved = unwrap(
    await reassignWorktrees(t.db, {
      ids: [app.id, lib.id],
      from_session_id: "m-old",
      to_session_id: "m-new",
    }),
  );
  expect(moved.map((w) => [w.id, w.session_id, w.state])).toEqual([
    [app.id, "m-new", "active"],
    [lib.id, "m-new", "active"],
  ]);

  await ended("n-old");
  const kept = unwrap(
    await insertWorktree(t.db, {
      ...worktree("/w/n/app"),
      session_id: "n-old",
    }),
  );
  const taken = unwrap(
    await insertWorktree(t.db, {
      ...worktree("/w/n/lib"),
      session_id: "n-old",
    }),
  );
  unwrap(
    await reassignWorktree(t.db, {
      id: taken.id,
      from_session_id: "n-old",
      to_session_id: "someone-else",
    }),
  );
  expect(
    await reassignWorktrees(t.db, {
      ids: [kept.id, taken.id],
      from_session_id: "n-old",
      to_session_id: "n-new",
    }),
  ).toMatchObject({ ok: false, error: { class: "conflict" } });
  // The first row's move was rolled back with the refusal.
  expect(
    unwrap(await listSessionWorktrees(t.db, "n-old")).map((w) => w.id),
  ).toEqual([kept.id]);
  expect(unwrap(await listSessionWorktrees(t.db, "n-new"))).toEqual([]);
});

test("setWorktreeSubmodules writes the start SHAs; bad SHAs are validation, an unknown row not_found", async () => {
  const row = unwrap(await insertWorktree(t.db, worktree("/w/sub/super")));
  const shas = {
    v: 1 as const,
    git: "2.50.1",
    shas: [{ path: "libs/mid", repo_id: "repo", sha: "a".repeat(40) }],
  };
  const written = unwrap(await setWorktreeSubmodules(t.db, row.id, shas));
  expect(JSON.parse(written.submodule_shas_json ?? "null")).toEqual(shas);
  expect(
    await setWorktreeSubmodules(t.db, row.id, {
      ...shas,
      shas: [{ path: "libs/mid", repo_id: "repo", sha: "not-a-sha" }],
    }),
  ).toMatchObject({ ok: false, error: { class: "validation" } });
  expect(await setWorktreeSubmodules(t.db, "nope", shas)).toMatchObject({
    ok: false,
    error: { class: "not_found" },
  });
});
