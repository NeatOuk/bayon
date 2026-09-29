// session.attach and session.detach end to end (§12.5): the fixture runner on a real LocalExecutor,
// a real tmux session under a real FRM_HOME, a real git worktree and ticket. Attach: the session
// reaches human_attached, a real tmux session exists, and an automated turn is refused rather than
// queued. Detach: tmux is gone, a fresh automated process is adopted, a ticket_event records the
// human intervention, and a hand-off run opens.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FakeClock, TEMPLATES } from "@bayon/core";
import { listTicketEvents, listSessionsInStates, type Db } from "@bayon/db";
import { seedRows, tempDb, unwrap } from "@bayon/db/testing";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import {
  createFixtureAdapter,
  FIXTURE_CAPS,
  type FixtureScriptInput,
} from "@bayon/runners/fixture";
import type { RunnerAdapter } from "@bayon/runners";
import { afterAll, describe, expect, test, vi } from "vitest";
import { PHASE_RELEASED_STATES } from "./commands.js";
import {
  CMD,
  EXECUTOR_ID,
  startLifecycle,
  tempHome,
} from "./testing/fixtures.js";
import {
  TE as TURN_END,
  TICKET,
  TS as TURN_START,
  WAIT,
  capturing,
  makeRepo,
  session,
  spawnOn,
  waitFor,
  waitState,
  worldRows,
  type World,
} from "./testing/handoff-world.js";

// Real processes, git and tmux: more than the default 5 s on a loaded host.
vi.setConfig({ testTimeout: 30_000 });

const T0 = 1_700_000_000_000;
/** Run 1 completes at once (spawnOn's "go" prompt); run 2 (the hand-off request) opens and gates,
 * so the test can assert handoff_writing cleanly without racing its completion. */
const SCRIPT: FixtureScriptInput = {
  runs: [
    { events: [TURN_START, TURN_END] },
    { events: [TURN_START], gate: "release" },
  ],
};

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/** Lets one test see the adapter the supervisor holds, to observe what is true when it is called. */
type Decorate = (a: RunnerAdapter) => RunnerAdapter;

async function setup(
  decorate: Decorate = (a) => a,
): Promise<
  World & { readonly frmHome: string; readonly adapter: RunnerAdapter }
> {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const home = tempHome("frm-at-");
  const { src, mirror } = makeRepo(home.path);
  const rows = worldRows({ script: SCRIPT, src, mirror });
  // §12.5 needs the pty cap; worldRows/lifecycleRows seed the row from FIXTURE_CAPS (no pty), and
  // ctx.adapters looks up the adapter object's own caps(), not the row, so both must agree.
  const runner = rows.runners[0];
  if (runner === undefined) throw new Error("worldRows seeded no runner");
  runner.caps_json = JSON.stringify({ ...FIXTURE_CAPS, pty: true });
  unwrap(await seedRows(t.db, rows));
  const slots = new SlotCounter(4);
  const executor = new LocalExecutor({ id: EXECUTOR_ID, slots });
  const base = createFixtureAdapter({ clock });
  const fixture = capturing({
    ...base,
    caps: () => ({ ...base.caps(), pty: true }),
  });
  const started = await startLifecycle({
    db: t.db,
    clock,
    frmHome: home.path,
    executor,
    slots,
    adapter: decorate(fixture.adapter),
  });
  cleanups.push(async () => {
    await started.lifecycle.shutdown();
    const live = await listSessionsInStates(t.db, [
      "running",
      "idle",
      "human_attached",
      "stopping",
      "handoff_writing",
      "handed_off",
    ]);
    for (const s of live.ok ? live.value : []) {
      if (s.executor_ref !== null)
        await executor.cleanup(s.executor_ref, "hard");
    }
    t.cleanup();
    home.cleanup();
  });
  return {
    ...started,
    db: t.db,
    clock,
    executor,
    slots,
    src,
    mirror,
    release: fixture.release,
    adopts: fixture.adopts,
    stops: fixture.stops,
    frmHome: home.path,
    adapter: fixture.adapter,
  };
}

/** `tmux -S <socket> has-session -t main`: true only if a real session is live there. */
function tmuxAlive(socket: string): boolean {
  try {
    execFileSync("tmux", ["-S", socket, "has-session", "-t", "main"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

async function ticketEventKinds(db: Db): Promise<readonly string[]> {
  const page = unwrap(
    await listTicketEvents(db, { ticket_id: TICKET, since: 0, limit: 1000 }),
  );
  return page.rows.map((r) => r.kind);
}

describe("session.attach and session.detach", () => {
  test("attach takes the lease, starts a real tmux session, and refuses an automated turn; detach releases it, re-adopts, and hands off", async () => {
    const w = await setup();
    const id = "s-attach-1";
    await spawnOn(w, id);
    await waitState(w, id, "idle");

    const attached = await w.lifecycle.handlers.attach.handle(
      { session_id: id },
      CMD,
    );
    expect(attached.ok).toBe(true);
    await waitState(w, id, "human_attached");

    // Invariant 12: attaching must stop the pre-existing automated process before the interactive
    // resume starts, never let both run at once on the same runner_session_id.
    expect(w.stops()).toContain("graceful");

    const s1 = await session(w.db, id);
    expect(s1.attach_lease_owner).not.toBeNull();
    expect(s1.attach_lease_expires_at).not.toBeNull();
    expect(s1.tmux_target).not.toBeNull();
    expect(tmuxAlive(s1.tmux_target as string)).toBe(true);

    // Automated turn admission is refused, not queued: startRun's own first check is a live
    // adapter-driven process (ctx.live.get(id).proc), which attach clears — there is none while a
    // human holds the lease. Structurally reinforced too: no edge out of human_attached leads back
    // to running, so even a run seq that got past this check could not move the session.
    const duringAttach = await w.lifecycle.startRun(id, {
      seq: 2,
      trigger: "retry",
      template: TEMPLATES.operator,
      inputs: { task: "x" },
    });
    expect(duringAttach).toMatchObject({
      ok: false,
      error: { class: "conflict" },
    });

    // A second attach command re-delivered now is likewise refused: the edge's from-set no longer
    // matches.
    const reAttached = await w.lifecycle.handlers.attach.handle(
      { session_id: id },
      CMD,
    );
    expect(reAttached.ok).toBe(true); // accepted (idempotent contract); attachOp itself no-ops
    await new Promise((r) => setTimeout(r, 50));
    expect((await session(w.db, id)).state).toBe("human_attached");

    // A container executor routes exec by cwd; "/" matches none of its routes. Spying on the same
    // executor instance the supervisor already holds (not a stand-in) catches a regression back to
    // that hard-coded "/" without needing a real container executor in this test.
    const execSpy = vi.spyOn(w.executor, "exec");
    const detached = await w.lifecycle.handlers.detach.handle(
      { session_id: id },
      CMD,
    );
    expect(detached.ok).toBe(true);

    await waitFor(w, async () => {
      expect((await session(w.db, id)).state).toBe("handoff_writing");
    });
    const s2 = await session(w.db, id);
    expect(s2.attach_lease_owner).toBeNull();
    expect(s2.attach_lease_expires_at).toBeNull();
    expect(s2.tmux_target).toBeNull();
    expect(tmuxAlive(s1.tmux_target as string)).toBe(false);
    expect(await ticketEventKinds(w.db)).toContain("human_attach");

    const killServerCall = execSpy.mock.calls.find(([argv]) =>
      argv.includes("kill-server"),
    );
    expect(killServerCall).toBeDefined();
    expect(killServerCall?.[1].cwd).toBe(s1.session_root);
    expect(killServerCall?.[1].cwd).not.toBe("/");

    // Let the gated hand-off run settle so the process ends cleanly at teardown.
    await w.release(id);
  });

  test("a client-supplied token becomes the lease owner verbatim, so the caller can recognize its own lease by equality", async () => {
    const w = await setup();
    const id = "s-attach-token";
    await spawnOn(w, id);
    await waitState(w, id, "idle");

    const token = "web-tab-9f2c1a3e";
    const attached = await w.lifecycle.handlers.attach.handle(
      { session_id: id, client_token: token },
      CMD,
    );
    expect(attached.ok).toBe(true);
    await waitState(w, id, "human_attached");

    const s = await session(w.db, id);
    expect(s.attach_lease_owner).toBe(token);

    await w.lifecycle.handlers.detach.handle({ session_id: id }, CMD);
    await waitFor(w, async () => {
      expect((await session(w.db, id)).state).toBe("handoff_writing");
    });
    await w.release(id);
  });

  // an earlier change review MEDIUM. A phase change that arrives while a human holds the terminal used to
  // be swallowed as a no-op, on the reasoning that a session outside running/idle is "already
  // handing off, already gone, or no longer holding its ticket". human_attached is none of those:
  // the session is alive, no degraded row is written, and detach runs it straight back to idle
  // still holding — so the swallow stranded the ticket exactly as it was before an earlier change.
  test("a phase change while a human holds the terminal conflicts: it is never swallowed as done", async () => {
    const w = await setup();
    const id = "s-attach-phase";
    await spawnOn(w, id);
    await waitState(w, id, "idle");
    expect(
      (await w.lifecycle.handlers.attach.handle({ session_id: id }, CMD)).ok,
    ).toBe(true);
    await waitState(w, id, "human_attached");

    expect(
      await w.lifecycle.handlers.handoff.handle(
        { session_id: id, reason: "phase_change", phase_to: "build" },
        CMD,
      ),
    ).toMatchObject({ ok: false, error: { class: "conflict" } });
    expect(await session(w.db, id)).toMatchObject({ state: "human_attached" });

    // The states that really are releasing still answer `done`, so a genuinely late command is
    // not turned into a failure; the two live ones are deliberately absent.
    expect(PHASE_RELEASED_STATES).toEqual([
      "handoff_writing",
      "handed_off",
      "stopping",
      "exited",
      "resumable",
    ]);
    for (const alive of ["human_attached", "awaiting_approval"] as const) {
      expect(PHASE_RELEASED_STATES, alive).not.toContain(alive);
    }

    await w.lifecycle.handlers.detach.handle({ session_id: id }, CMD);
    await waitFor(w, async () => {
      expect((await session(w.db, id)).state).toBe("handoff_writing");
    });
    await w.release(id);
  });

  test("attach is a no-op when the session is not running or idle", async () => {
    const w = await setup();
    const id = "s-attach-2";
    // No spawn: the session does not exist, so getSession fails and attachOp returns at once.
    const attached = await w.lifecycle.handlers.attach.handle(
      { session_id: id },
      CMD,
    );
    expect(attached.ok).toBe(false);
  });
});

test("an earlier change review: the automated process is stopped before the adapter is asked to prepare a resume", async () => {
  // interactiveResume may touch files in the session's home — an adapter can seed its runner's own
  // config there — and the automated process writes the same files while it lives. If the two
  // overlap, one update is lost, and if the loser is ours the operator lands back in whatever
  // first-run state the seed was meant to clear, with nothing saying why. So: no live process by
  // the time we are asked.
  let stopsWhenAsked: number | undefined;
  let stopsSoFar: () => number = () => 0;
  const w = await setup((a) => ({
    ...a,
    interactiveResume: (spec, rsid, ex) => {
      stopsWhenAsked = stopsSoFar();
      return a.interactiveResume(spec, rsid, ex);
    },
  }));
  stopsSoFar = () => w.stops().length;
  const id = "s-attach-order";
  await spawnOn(w, id);
  await waitState(w, id, "idle");
  const before = w.stops().length;
  expect(
    (await w.lifecycle.handlers.attach.handle({ session_id: id }, CMD)).ok,
  ).toBe(true);
  await waitState(w, id, "human_attached");

  // The quiesce landed first: by the time the adapter was asked, this session's process had been
  // stopped. Reordering attachOp back puts this at `before`.
  expect(stopsWhenAsked).toBe(before + 1);

  const s = await session(w.db, id);
  execFileSync("tmux", ["-S", s.tmux_target as string, "kill-server"], {
    stdio: "ignore",
  });
});

describe("boot-time attach incident recovery", () => {
  test("a still-alive, unexpired human_attached session survives a supervisor restart untouched", async () => {
    const w = await setup();
    const id = "s-attach-crash-alive";
    await spawnOn(w, id);
    await waitState(w, id, "idle");
    const attached = await w.lifecycle.handlers.attach.handle(
      { session_id: id },
      CMD,
    );
    expect(attached.ok).toBe(true);
    await waitState(w, id, "human_attached");
    const before = await session(w.db, id);
    expect(tmuxAlive(before.tmux_target as string)).toBe(true);

    // A crash, not a clean stop: shutdown() cancels this process's own timers/loops only — it never
    // touches the DB or kills the tmux session, exactly like a supervisor that died mid-attach. tmux
    // is an independent, detached process: it does not die with the supervisor that started it.
    await w.lifecycle.shutdown();

    const restarted = await startLifecycle({
      db: w.db,
      clock: w.clock,
      frmHome: w.frmHome,
      executor: w.executor,
      slots: w.slots,
      adapter: w.adapter,
    });
    cleanups.push(() => restarted.lifecycle.shutdown());
    await restarted.lifecycle.settled();

    // Still attached, tmux still alive, lease untouched: a healthy session must not be torn down
    // just because the supervisor happened to restart. It's left for the operator, or the ordinary
    // TTL sweep once the lease actually expires.
    const after = await session(w.db, id);
    expect(after.state).toBe("human_attached");
    expect(after.attach_lease_owner).toBe(before.attach_lease_owner);
    expect(after.tmux_target).toBe(before.tmux_target);
    expect(tmuxAlive(before.tmux_target as string)).toBe(true);

    // Kill it directly so it isn't left lingering for afterAll's own cleanup pass to trip over.
    execFileSync("tmux", ["-S", before.tmux_target as string, "kill-server"], {
      stdio: "ignore",
    });
  });

  test("a human_attached session whose tmux server has actually died is detached at boot, not left for the TTL", async () => {
    const w = await setup();
    const id = "s-attach-crash-dead";
    await spawnOn(w, id);
    await waitState(w, id, "idle");
    const attached = await w.lifecycle.handlers.attach.handle(
      { session_id: id },
      CMD,
    );
    expect(attached.ok).toBe(true);
    await waitState(w, id, "human_attached");
    const before = await session(w.db, id);
    expect(tmuxAlive(before.tmux_target as string)).toBe(true);

    // The tmux server itself dies for some reason unrelated to the supervisor (a host tmux crash, a
    // fat-fingered kill) while the DB row is still human_attached — distinct from the case above,
    // where tmux survives a supervisor restart just fine.
    execFileSync("tmux", ["-S", before.tmux_target as string, "kill-server"], {
      stdio: "ignore",
    });
    expect(tmuxAlive(before.tmux_target as string)).toBe(false);

    await w.lifecycle.shutdown();

    // A fresh supervisor over the same DB, FRM_HOME, executor and adapter: its boot pass has
    // adopted nothing yet, so any human_attached row it finds is unambiguously stale, and this one's
    // tmux session is genuinely gone.
    const restarted = await startLifecycle({
      db: w.db,
      clock: w.clock,
      frmHome: w.frmHome,
      executor: w.executor,
      slots: w.slots,
      adapter: w.adapter,
    });
    cleanups.push(() => restarted.lifecycle.shutdown());

    await vi.waitFor(async () => {
      await restarted.lifecycle.settled();
      const s = await session(w.db, id);
      expect(s.state === "idle" || s.state === "handoff_writing").toBe(true);
    }, WAIT);
    const after = await session(w.db, id);
    expect(after.attach_lease_owner).toBeNull();
    expect(after.attach_lease_expires_at).toBeNull();
    expect(after.tmux_target).toBeNull();
    expect(
      restarted.logs.some(
        (l) =>
          l.level === "error" &&
          l.msg.includes("human_attached session is dead or expired"),
      ),
    ).toBe(true);
  });

  test("a tmux server that dies mid-run is detached on the next ordinary pass, with no restart and long before the lease expires", async () => {
    const w = await setup();
    const id = "s-attach-died-midrun";
    await spawnOn(w, id);
    await waitState(w, id, "idle");
    expect(
      (await w.lifecycle.handlers.attach.handle({ session_id: id }, CMD)).ok,
    ).toBe(true);
    await waitState(w, id, "human_attached");
    const before = await session(w.db, id);
    expect(tmuxAlive(before.tmux_target as string)).toBe(true);

    // The interactive CLI is killed independently of the detach path — a crash, or a kill from
    // outside — while this same supervisor keeps running. Before an earlier change the liveness check ran
    // only at boot, so this row sat human_attached until the lease ran out or the host restarted.
    execFileSync("tmux", ["-S", before.tmux_target as string, "kill-server"], {
      stdio: "ignore",
    });
    expect(tmuxAlive(before.tmux_target as string)).toBe(false);

    // The lease is nowhere near expiry: the clock has not moved, so nothing the TTL sweep does can
    // account for this detach. Only the liveness check can.
    expect(before.attach_lease_expires_at).toBeGreaterThan(w.clock.now());

    await w.lifecycle.reconcile();

    await vi.waitFor(async () => {
      const s = await session(w.db, id);
      expect(s.state === "idle" || s.state === "handoff_writing").toBe(true);
    }, WAIT);
    const after = await session(w.db, id);
    expect(after.attach_lease_owner).toBeNull();
    expect(after.attach_lease_expires_at).toBeNull();
    expect(after.tmux_target).toBeNull();
  });

  test("an ordinary pass leaves a live attach alone, and says nothing about it", async () => {
    const w = await setup();
    const id = "s-attach-live-periodic";
    await spawnOn(w, id);
    await waitState(w, id, "idle");
    expect(
      (await w.lifecycle.handlers.attach.handle({ session_id: id }, CMD)).ok,
    ).toBe(true);
    await waitState(w, id, "human_attached");
    const before = await session(w.db, id);

    const logsBefore = w.logs.length;
    await w.lifecycle.reconcile();
    await w.lifecycle.reconcile();

    const after = await session(w.db, id);
    expect(after.state).toBe("human_attached");
    expect(after.tmux_target).toBe(before.tmux_target);
    expect(after.attach_lease_owner).toBe(before.attach_lease_owner);
    expect(tmuxAlive(before.tmux_target as string)).toBe(true);
    // A healthy attach must not produce a line a minute: the boot "leaving it be" note is for the
    // one pass where a restart could have ended it.
    expect(
      w.logs.slice(logsBefore).filter((l) => l.msg.includes("attach")),
    ).toEqual([]);

    execFileSync("tmux", ["-S", before.tmux_target as string, "kill-server"], {
      stdio: "ignore",
    });
  });

  test("an orphan tmux socket with no attached session is killed at boot", async () => {
    const w = await setup();
    // A raw tmux session with no session row at all: the leftover a fixed kill-server failure, or a
    // tmux binary killed some other way, would produce — reconcileOrphanedAttaches only clears
    // sockets a DB row still points at, so this is the case only reapOrphanTmuxSockets can see.
    const socket = join(w.frmHome, "s", "orphan12345");
    mkdirSync(join(w.frmHome, "s"), { recursive: true });
    execFileSync(
      "tmux",
      ["-S", socket, "new-session", "-d", "-s", "main", "--", "sleep", "60"],
      { stdio: "ignore" },
    );
    expect(tmuxAlive(socket)).toBe(true);
    await w.lifecycle.shutdown();

    const restarted = await startLifecycle({
      db: w.db,
      clock: w.clock,
      frmHome: w.frmHome,
      executor: w.executor,
      slots: w.slots,
      adapter: w.adapter,
    });
    cleanups.push(() => restarted.lifecycle.shutdown());

    await vi.waitFor(async () => {
      await restarted.lifecycle.settled();
      expect(tmuxAlive(socket)).toBe(false);
    }, WAIT);
    expect(
      restarted.logs.some(
        (l) =>
          l.level === "error" &&
          l.msg.includes("orphan tmux socket claims no session"),
      ),
    ).toBe(true);
  });
});
