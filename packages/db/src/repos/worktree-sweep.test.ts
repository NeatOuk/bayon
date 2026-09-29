import { FakeClock, KEPT_DETAIL_CAP } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { internalsOf, type Db } from "../connection.js";
import {
  SPINE_SEED,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "../testing.js";
import { hasPulseWork } from "./pulse-reads.js";
import { createSession, updateSessionState } from "./sessions.js";
import {
  clearWorktreeFlag,
  flagWorktree,
  getSweepWorktree,
  listSweepWorktrees,
  markWorktreeRemoved,
} from "./worktree-sweep.js";
import { insertWorktree, reassignWorktree } from "./worktrees.js";

// The worktree sweep's read and writers, on a real temp database.
const T0 = 1_700_000_000_000;
const clock = new FakeClock(T0);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));

async function world(): Promise<Db> {
  const t = unwrap(await tempDb(clock));
  cleanups.push(t.cleanup);
  unwrap(await seedSpine(t.db, 2));
  unwrap(
    await seedRows(t.db, {
      repos: [
        {
          id: "repo",
          name: "repo",
          mirror_path: "/m/repo.git",
          origin_url: "file:///o",
        },
      ],
      workspaces: [{ id: "ws", name: "ws", kind: "single" }],
      tickets: [
        ticketRow(1, { status: "done" }),
        ticketRow(2, { status: "building" }),
      ],
    }),
  );
  return t.db;
}

/** A session that ran and ended at `endedAt`. */
async function ended(
  db: Db,
  id: string,
  o: { endedAt?: number; handoffIn?: string | null } = {},
): Promise<void> {
  unwrap(
    await createSession(db, {
      ...newSessionInput(),
      id,
      handoff_in_id: o.handoffIn ?? null,
    }),
  );
  unwrap(
    await updateSessionState(db, id, {
      from: ["pending"],
      to: "exited",
      patch: { ended_at: o.endedAt ?? T0 },
    }),
  );
}

async function worktree(
  db: Db,
  path: string,
  sessionId: string,
  ticketId: string | null = "ticket-1",
) {
  return unwrap(
    await insertWorktree(db, {
      session_root: "/w",
      workspace_id: "ws",
      repo_id: "repo",
      path,
      branch: `frm/${sessionId}`,
      base_sha: "abc",
      ticket_id: ticketId,
      session_id: sessionId,
      state: "active",
    }),
  );
}

function handoff(db: Db, id: string, from: string, accepted = false): void {
  unwrap(internalsOf(db))
    .raw.prepare(
      `INSERT INTO handoffs (id, ticket_id, from_session_id, reason, facts_json, packet_path,
        packet_hash, quality, accepted_at, created_at)
       VALUES (?, 'ticket-1', ?, 'ceiling', '{}', '/p', 'h', 'full', ?, ?)`,
    )
    .run(id, from, accepted ? T0 : null, T0);
}

test("listSweepWorktrees joins the holder, its executor, the ticket and the repo; removed rows are left out", async () => {
  const db = await world();
  await ended(db, "s1", { endedAt: T0 - 5 });
  const w = await worktree(db, "/w/a", "s1");
  const gone = await worktree(db, "/w/b", "s1");
  unwrap(
    await markWorktreeRemoved(db, {
      id: gone.id,
      session_id: "s1",
      state: "active",
    }),
  );
  expect(unwrap(await listSweepWorktrees(db))).toEqual([
    expect.objectContaining({
      id: w.id,
      path: "/w/a",
      state: "active",
      kept_reason: null,
      holder_state: "exited",
      holder_ended_at: T0 - 5,
      holder_gate_id: null,
      executor_kind: "local",
      ticket_status: "done",
      mirror_path: "/m/repo.git",
      origin_url: "file:///o",
      default_base_branch: "main",
      unaccepted_handoff: false,
      live_successor: false,
    }),
  ]);
  expect(unwrap(await getSweepWorktree(db, w.id))?.path).toBe("/w/a");
  expect(unwrap(await getSweepWorktree(db, "nope"))).toBeNull();
});

test("an unaccepted hand-off holds the row; a live successor for it too; an accepted one does not", async () => {
  const db = await world();
  await ended(db, "s1");
  const w = await worktree(db, "/w/a", "s1");
  const facts = async () => {
    const row = unwrap(await getSweepWorktree(db, w.id));
    return [row?.unaccepted_handoff, row?.live_successor];
  };
  expect(await facts()).toEqual([false, false]);
  handoff(db, "h1", "s1");
  expect(await facts()).toEqual([true, false]);
  // A successor spawned for h1, still pending: live.
  unwrap(
    await createSession(db, {
      ...newSessionInput(),
      id: "s2",
      handoff_in_id: "h1",
    }),
  );
  expect(await facts()).toEqual([true, true]);
  unwrap(
    await updateSessionState(db, "s2", { from: ["pending"], to: "exited" }),
  );
  expect(await facts()).toEqual([true, false]);
  unwrap(internalsOf(db))
    .raw.prepare("UPDATE handoffs SET accepted_at = 1 WHERE id = 'h1'")
    .run();
  expect(await facts()).toEqual([false, false]);
});

test("a successor's own incoming hand-off, unaccepted, holds the rows it was given", async () => {
  const db = await world();
  await ended(db, "s1");
  handoff(db, "h1", "s1");
  await ended(db, "s2", { handoffIn: "h1" });
  const w = await worktree(db, "/w/a", "s2");
  expect(unwrap(await getSweepWorktree(db, w.id))).toMatchObject({
    unaccepted_handoff: true,
    live_successor: false,
  });
});

test("flagWorktree writes kept_* only, capped, while the holder still has it; clearWorktreeFlag nulls it", async () => {
  const db = await world();
  await ended(db, "s1");
  const w = await worktree(db, "/w/a", "s1");
  const flagged = unwrap(
    await flagWorktree(db, {
      id: w.id,
      session_id: "s1",
      reason: "ignored",
      detail: "x".repeat(KEPT_DETAIL_CAP + 50),
    }),
  );
  expect(flagged).toMatchObject({
    state: "active",
    kept_reason: "ignored",
    last_used_at: null,
  });
  expect(flagged.kept_detail).toHaveLength(KEPT_DETAIL_CAP);
  expect(
    await flagWorktree(db, {
      id: w.id,
      session_id: "other",
      reason: "dirty",
      detail: null,
    }),
  ).toMatchObject({ ok: false, error: { class: "conflict" } });
  expect(
    unwrap(await clearWorktreeFlag(db, { id: w.id, session_id: "s1" })),
  ).toMatchObject({ kept_reason: null, kept_detail: null });
});

test("a row with no holder is flagged by its NULL session", async () => {
  const db = await world();
  unwrap(
    await seedRows(db, {
      worktrees: [
        {
          id: "w-none",
          session_root: "/w",
          workspace_id: "ws",
          repo_id: "repo",
          path: "/w/none",
          branch: "x",
          base_sha: "abc",
          state: "orphan",
          created_at: T0,
        },
      ],
    }),
  );
  expect(
    unwrap(
      await flagWorktree(db, {
        id: "w-none",
        session_id: null,
        reason: "unverifiable",
        detail: "no holder",
      }),
    ),
  ).toMatchObject({ kept_reason: "unverifiable" });
  expect(
    unwrap(
      await markWorktreeRemoved(db, {
        id: "w-none",
        session_id: null,
        state: "orphan",
      }),
    ),
  ).toMatchObject({ state: "removed", kept_reason: null });
});

test("markWorktreeRemoved moves only the state it read, under its holder, and clears the flag; a removed row takes no flag", async () => {
  const db = await world();
  await ended(db, "s1");
  const w = await worktree(db, "/w/a", "s1");
  unwrap(
    await flagWorktree(db, {
      id: w.id,
      session_id: "s1",
      reason: "remove_failed",
      detail: "B16",
    }),
  );
  expect(
    await markWorktreeRemoved(db, {
      id: w.id,
      session_id: "s1",
      state: "idle",
    }),
  ).toMatchObject({ ok: false, error: { class: "conflict" } });
  await clock.advance(7);
  expect(
    unwrap(
      await markWorktreeRemoved(db, {
        id: w.id,
        session_id: "s1",
        state: "active",
      }),
    ),
  ).toMatchObject({
    state: "removed",
    kept_reason: null,
    kept_detail: null,
    last_used_at: clock.now(),
  });
  expect(
    await flagWorktree(db, {
      id: w.id,
      session_id: "s1",
      reason: "dirty",
      detail: null,
    }),
  ).toMatchObject({ ok: false, error: { class: "conflict" } });
});

test("reassignWorktree clears the sweep's flag: a live session owns the row again", async () => {
  const db = await world();
  await ended(db, "s1");
  const w = await worktree(db, "/w/a", "s1");
  unwrap(
    await flagWorktree(db, {
      id: w.id,
      session_id: "s1",
      reason: "dirty",
      detail: "a.txt",
    }),
  );
  unwrap(await createSession(db, { ...newSessionInput(), id: "s2" }));
  expect(
    unwrap(
      await reassignWorktree(db, {
        id: w.id,
        from_session_id: "s1",
        to_session_id: "s2",
      }),
    ),
  ).toMatchObject({ session_id: "s2", kept_reason: null, kept_detail: null });
});

test("hasPulseWork skips the arms only a human can act on (HUMAN_ONLY_ARMS)", async () => {
  const t = unwrap(await tempDb(clock));
  cleanups.push(t.cleanup);
  const db = t.db;
  unwrap(await seedSpine(db, 2));
  unwrap(
    await seedRows(db, {
      repos: [{ id: "repo", name: "repo", mirror_path: "/m/repo.git" }],
      workspaces: [{ id: "ws", name: "ws", kind: "single" }],
    }),
  );
  const w = await worktree(db, "/w/a", SPINE_SEED.sessionId, null);
  unwrap(
    await flagWorktree(db, {
      id: w.id,
      session_id: SPINE_SEED.sessionId,
      reason: "dirty",
      detail: null,
    }),
  );
  const w2 = await worktree(db, "/w/b", SPINE_SEED.sessionId, null);
  unwrap(
    await flagWorktree(db, {
      id: w2.id,
      session_id: SPINE_SEED.sessionId,
      reason: "locked",
      detail: "initializing",
    }),
  );
  expect(unwrap(await hasPulseWork(db, 0))).toBe(false);
  unwrap(
    await seedRows(db, {
      tickets: [ticketRow(3, { status: "prioritized" })],
    }),
  );
  expect(unwrap(await hasPulseWork(db, 0))).toBe(true);
});
