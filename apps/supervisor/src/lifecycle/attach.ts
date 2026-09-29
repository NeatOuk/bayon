// session.attach and session.detach (§12.5): the operator's terminal takeover lease. Attach
// creates a tmux session (its own socket, under $FRM_HOME/s/<short>) running the runner's real
// interactive CLI, resumed on the same runner_session_id; detach kills it, adopts a fresh
// automated process the normal way, and asks for a hand-off note. The pty streaming itself
// (session:<id>:pty, xterm.js) is a separate ticket (B) — this module only owns the tmux session's
// lifecycle, never attaches a live pty to it.
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getSession, listSessionsInStates, type SessionRow } from "@bayon/db";
import { clearAttachIntent, recordAttachRelease } from "@bayon/db/supervisor";
import type { Argv, Executor } from "@bayon/executors";
import type { RunnerAdapter } from "@bayon/runners";
import { runAfterExit } from "./after-exit.js";
import { adoptable, startAdopted, type PassPhase } from "./reconciler.js";
import {
  isIn,
  move,
  patchEntry,
  schedule,
  type Ctx,
  type Entry,
} from "./context.js";
import { requestHandoff } from "./handoff.js";
import { ptyLogPath, tmuxSocketPath } from "../paths.js";
import { registerPtyChannel, unregisterPtyChannel } from "./pty-relay.js";
import { stopProcess } from "./process.js";
import { cancelTimer } from "./run.js";
import { TMUX_SESSION_NAME, tmuxArgv } from "./tmux.js";

const ATTACHABLE = ["running", "idle"] as const;

/** Runs a short-lived executor command to completion; true if it exited 0. Stdout/stderr drained,
 * never inspected — tmux's own commands are terse and this call site only needs pass/fail. A
 * program that cannot even start (tmux missing from PATH) is `spawn_failed`, not a thrown error a
 * caller here would want to propagate — it means the same thing as a non-zero exit: false. */
async function runToCompletion(
  ex: Executor,
  argv: Argv,
  cwd: string,
  env: Readonly<Record<string, string>>,
): Promise<boolean> {
  let proc;
  try {
    proc = await ex.exec(argv, { cwd, env, stdin: "ignore" });
  } catch {
    return false;
  }
  const drain = async (s: AsyncIterable<Uint8Array>): Promise<void> => {
    // tmux's own output is never inspected here — only drained so the pipe never blocks it.
    for await (const chunk of s) void chunk;
  };
  const [status] = await Promise.all([
    proc.exited,
    drain(proc.stdout),
    drain(proc.stderr),
  ]);
  return status.code === 0;
}

/**
 * Stops whatever automated process this entry currently holds and clears it, so no second process
 * (the interactive resume, or a later re-adopt) ever starts while the first is still live on the
 * same runner_session_id (Invariant 12: never two processes on one runner_session_id).
 */
async function quiesceExisting(
  ctx: Ctx,
  id: string,
  entry: Entry,
): Promise<void> {
  const proc = entry.proc;
  if (proc === undefined) return;
  patchEntry(ctx, id, { intent: "graceful" });
  cancelTimer(ctx, id);
  await stopProcess(ctx, proc, "graceful");
  await proc.closed;
  await runAfterExit(ctx, id, proc);
  patchEntry(ctx, id, { proc: undefined, intent: undefined });
}

/**
 * session.attach's path when it takes the session `now`, on the session's queue: the agent is
 * stopped where it is, mid-turn if it is in one. `when: "turn_end"` goes through
 * attach-intent.ts instead, which ends here once the open run has ended. A no-op (logged) unless
 * the session is running or idle, live under this supervisor, and its runner supports interactive
 * resume. `clientToken`, when the caller supplied one, becomes `attach_lease_owner` verbatim;
 * absent, one is minted here.
 */
export function requestAttach(
  ctx: Ctx,
  id: string,
  clientToken?: string,
): Promise<void> {
  return ctx.queue.run(id, async () => {
    await attachNow(ctx, id, clientToken);
  });
}

/** What a takeover of a session needs, and has: its runner, its executor, the id to resume. */
export interface TakeoverParts {
  readonly adapter: RunnerAdapter;
  readonly ex: Executor;
  readonly rsid: string;
}

/**
 * What a takeover of `s` needs, or why it can never have it: the checks that do not change while
 * the session runs, so a turn_end ask is refused up front rather than left pending for a run end
 * that could never honour it.
 */
export function takeoverParts(
  ctx: Ctx,
  s: SessionRow,
): TakeoverParts | { readonly refused: string } {
  const adapter = ctx.adapters.get(s.runner_id);
  const ex = ctx.executors.get(s.executor_id)?.executor;
  if (adapter === undefined || ex === undefined) {
    return { refused: "runner or executor unknown" };
  }
  // reapOrphanTmuxSockets only ever looks at $FRM_HOME/s/ on the local filesystem — a container
  // executor's tmux socket would live inside its container, unreachable to that reaper. Takeover
  // stays local-only (§12.5 v1 scope) until a container-side orphan reaper exists too.
  if (ex.kind !== "local") {
    return { refused: "takeover runs on the local executor only, for now" };
  }
  if (!adapter.caps().pty) {
    return { refused: "this runner has no interactive mode" };
  }
  if (s.runner_session_id === null) {
    return { refused: "no runner_session_id to resume" };
  }
  return { adapter, ex, rsid: s.runner_session_id };
}

/**
 * Takes the session now, on its queue; true once it is `human_attached`. Every attempt spends any
 * pending "take over after this step": its entry field is cleared first, and its
 * columns by the attach edge's own patch — or here, when the attempt does not get that far — so a
 * failed attempt never leaves an ask the sweep would retry every pass.
 */
export async function attachNow(
  ctx: Ctx,
  id: string,
  clientToken?: string,
): Promise<boolean> {
  patchEntry(ctx, id, { attachIntent: undefined });
  const attached = await attachSteps(ctx, id, clientToken);
  if (!attached) {
    const cleared = await clearAttachIntent(ctx.db, id);
    if (cleared.ok && cleared.value) {
      ctx.log.warn({ sessionId: id }, "attach: its pending takeover is spent");
    }
  }
  return attached;
}

async function attachSteps(
  ctx: Ctx,
  id: string,
  clientToken?: string,
): Promise<boolean> {
  const found = await getSession(ctx.db, id);
  if (!found.ok) return false;
  const s = found.value;
  const entry = ctx.live.get(id);
  if (!isIn(ATTACHABLE, s.state) || entry === undefined || entry.dead) {
    ctx.log.info({ sessionId: id, state: s.state }, "no attach now");
    return false;
  }
  const parts = takeoverParts(ctx, s);
  if ("refused" in parts) {
    ctx.log.warn(
      { sessionId: id, runnerId: s.runner_id, executorId: s.executor_id },
      `no attach: ${parts.refused}`,
    );
    return false;
  }
  const { adapter, ex, rsid } = parts;
  // The same spec-building the automated adopt path uses (agent/profile/runner config, env with
  // secrets resolved) — an interactive resume needs the identical environment, not a rebuild of it.
  const adoption = await adoptable(ctx, s, adapter);
  if (!adoption.ok) {
    ctx.log.warn(
      { sessionId: id, error: adoption.error },
      "no attach: cannot build its spec",
    );
    return false;
  }
  // The pty log redacts the automated process's secrets as well as the resume's own (FRM-123). The
  // adoption mints a fresh MCP token that /mcp never learns, so the live one stays the process's,
  // and the resumed CLI can print it back from its own history. Read before the quiesce clears it.
  const redact = [
    ...new Set([...(entry.proc?.redact ?? []), ...adoption.value.redact]),
  ];
  // The automated process is still live (attach requires it, above) — it must be fully stopped
  // before the interactive resume starts, so the two never coexist on this runner_session_id. At a
  // run's end it is idle: this stops a process with nothing in flight.
  await quiesceExisting(ctx, id, entry);
  // Strictly after the quiesce, and that ordering is load-bearing: preparing a
  // resume may touch files in the session's home that the automated process also writes while it
  // lives. Whatever this adapter needs to prepare, it prepares against a home nothing else holds.
  // The cost is that a failure here leaves the session with no process — the same window mkdir and
  // tmux failures below already have, and the reconciler adopts it back on its next pass.
  const resume = await adapter.interactiveResume(adoption.value.spec, rsid, ex);
  if (!resume.ok) {
    ctx.log.warn(
      { sessionId: id, error: resume.error },
      "no attach: no interactive resume",
    );
    return false;
  }
  const socket = tmuxSocketPath(ctx.frmHome, id);
  const mkdirOk = await runToCompletion(
    ex,
    ["mkdir", "-p", dirname(socket)],
    adoption.value.spec.cwd,
    resume.value.env,
  );
  if (!mkdirOk) {
    ctx.log.error({ sessionId: id, socket }, "no attach: cannot make its dir");
    return false;
  }
  const started = await runToCompletion(
    ex,
    tmuxArgv(
      socket,
      "new-session",
      "-d",
      "-s",
      TMUX_SESSION_NAME,
      "-c",
      adoption.value.spec.cwd,
      "--",
      ...resume.value.argv,
    ),
    adoption.value.spec.cwd,
    resume.value.env,
  );
  if (!started) {
    ctx.log.error({ sessionId: id, socket }, "no attach: tmux did not start");
    return false;
  }
  const owner = clientToken ?? crypto.randomUUID();
  const leaseMs = ctx.settings["lifecycle.attach_lease_ms"];
  const moved = await move(ctx, id, "attach", {
    attach_lease_owner: owner,
    attach_lease_expires_at: ctx.clock.now() + leaseMs,
    tmux_target: socket,
    pty_log_path: ptyLogPath(ctx.frmHome, id),
    // In the edge that makes it human_attached, never before: the GUI tab that asked keeps its
    // lease token for as long as either says a takeover is coming.
    attach_intent_owner: null,
    attach_intent_at: null,
  });
  if (!moved.ok) {
    // Lost the race (e.g. a stop landed first): tear the tmux session back down. The same cwd it
    // was started with — a container executor routes by cwd, and "/" matches nothing there.
    const killedOk = await runToCompletion(
      ex,
      tmuxArgv(socket, "kill-server"),
      adoption.value.spec.cwd,
      { PATH: ctx.path },
    );
    if (!killedOk) {
      ctx.log.error(
        { sessionId: id, socket },
        "attach: lost the race and could not tear its tmux session back down",
      );
    }
    ctx.log.warn({ sessionId: id, error: moved.error }, "attach: no edge");
    return false;
  }
  ctx.log.info({ sessionId: id, socket, owner }, "attached");
  // Best-effort: a session that's human_attached but not yet streamed is still reachable by
  // whoever can reach this host directly (tmux -S <socket> attach), so a registration failure
  // here doesn't roll back the attach itself — only the browser-facing view of it.
  if (ctx.relay !== undefined) {
    const registered = await registerPtyChannel(ctx, moved.value, ex, redact);
    if (!registered.ok) {
      ctx.log.error(
        { sessionId: id, error: registered.error },
        "attach: could not register its pty channel",
      );
    }
  }
  return true;
}

/**
 * session.detach's path (explicit, or the periodic sweep's TTL expiry): kill the tmux session,
 * adopt a fresh automated process the normal way, then ask for a hand-off note recording the human
 * intervention. Every step best-effort past the tmux kill — a fresh process failing to adopt still
 * leaves the lease released and the session back on the reconciler's radar as `idle`, not stuck.
 */
export function requestDetach(ctx: Ctx, id: string): Promise<void> {
  return ctx.queue.run(id, () => detachOp(ctx, id));
}

async function detachOp(ctx: Ctx, id: string): Promise<void> {
  const found = await getSession(ctx.db, id);
  if (!found.ok) return;
  const s = found.value;
  if (s.state !== "human_attached") {
    // Before the attach has happened, a detach is the operator changing their mind:
    // the pending takeover goes and the session carries on automated. No hand-off: no human held it.
    if (!(await cancelAttachIntent(ctx, s))) {
      ctx.log.info({ sessionId: id, state: s.state }, "no detach now");
    }
    return;
  }
  unregisterPtyChannel(ctx, id);
  const ex = ctx.executors.get(s.executor_id)?.executor;
  if (s.tmux_target !== null && ex !== undefined) {
    // s.session_root, not "/": a container executor routes exec by cwd, and "/" matches none of
    // its routes (invalid("cwd /: ...")) — the kill-server would throw, be swallowed by
    // runToCompletion's catch, and silently never run, orphaning the interactive process.
    const killedOk = await runToCompletion(
      ex,
      tmuxArgv(s.tmux_target, "kill-server"),
      s.session_root,
      { PATH: ctx.path },
    );
    if (!killedOk) {
      ctx.log.error(
        { sessionId: id, tmuxTarget: s.tmux_target },
        "detach: could not kill its tmux session; it may still be running",
      );
    }
  }
  const released = await move(ctx, id, "release", {
    attach_lease_owner: null,
    attach_lease_expires_at: null,
    tmux_target: null,
  });
  if (!released.ok) {
    ctx.log.warn({ sessionId: id, error: released.error }, "detach: no edge");
    return;
  }
  const s2 = released.value;
  if (s2.ticket_id !== null) {
    const recorded = recordAttachRelease(ctx.db, {
      ticketId: s2.ticket_id,
      sessionId: s2.id,
      actorId: s.attach_lease_owner,
      at: ctx.clock.now(),
    });
    if (!(await recorded).ok) {
      ctx.log.warn({ sessionId: id }, "detach: no ticket_event recorded");
    }
  }
  await reAdoptAfterDetach(ctx, s2);
  schedule(ctx, id, "post-attach hand-off", () =>
    requestHandoff(ctx, id, "human_release"),
  );
}

/**
 * Cancels `s`'s pending "take over after this step", entry and row; true when there
 * was one. The open run is never touched: it goes on, and ends as it would have.
 */
async function cancelAttachIntent(ctx: Ctx, s: SessionRow): Promise<boolean> {
  const armed = ctx.live.get(s.id)?.attachIntent !== undefined;
  patchEntry(ctx, s.id, { attachIntent: undefined });
  const cleared = await clearAttachIntent(ctx.db, s.id);
  if (!cleared.ok) {
    ctx.log.error(
      { sessionId: s.id, error: cleared.error },
      "detach: cannot clear its pending takeover",
    );
    return armed;
  }
  if (!armed && !cleared.value) return false;
  ctx.log.info(
    { sessionId: s.id, state: s.state },
    "takeover cancelled before the open run ended",
  );
  return true;
}

/**
 * Brings up a fresh automated process the same way the reconciler's own dead-session adopt does,
 * so `requestHandoff` (which needs a live `LiveProcess`) has one to act on. Unlike a dead-entry
 * adopt, this session's slot is already held — never restored, never marked dead first.
 */
async function reAdoptAfterDetach(ctx: Ctx, s: SessionRow): Promise<void> {
  const adapter = ctx.adapters.get(s.runner_id);
  const executor = ctx.executors.get(s.executor_id)?.executor;
  if (adapter === undefined || executor === undefined) {
    ctx.log.error(
      { sessionId: s.id },
      "detach: cannot re-adopt, runner or executor unknown",
    );
    return;
  }
  // Belt and suspenders (Invariant 12): quiesceExisting already clears entry.proc at attach time,
  // so this should always be undefined here — but startAdopted's patchEntry would otherwise
  // silently discard a still-live reference rather than stopping it, so never trust that it is.
  const stale = ctx.live.get(s.id);
  if (stale?.proc !== undefined) {
    ctx.log.error(
      { sessionId: s.id },
      "detach: a process was still live before re-adopt; stopping it first",
    );
    await quiesceExisting(ctx, s.id, stale);
  }
  const adoption = await adoptable(ctx, s, adapter);
  if (!adoption.ok) {
    ctx.log.error(
      { sessionId: s.id, error: adoption.error },
      "detach: cannot re-adopt",
    );
    return;
  }
  const started = await startAdopted(ctx, s, adapter, executor, adoption.value);
  if (!started.ok) {
    ctx.log.error(
      { sessionId: s.id, error: started.error },
      "detach: re-adopt failed",
    );
  }
}

/** Sessions past their attach lease, for the periodic pass (extends releaseExpiredLeases: that
 * blind column clear still runs too, harmlessly, once this has already cleared them). */
export function expiredAttachLeases(
  sessions: readonly SessionRow[],
  now: number,
): readonly SessionRow[] {
  return sessions.filter(
    (s) =>
      s.state === "human_attached" &&
      s.attach_lease_expires_at !== null &&
      s.attach_lease_expires_at < now,
  );
}

/** The periodic pass's attach-lease step: detach every session whose lease has expired. */
export async function expireAttachLeases(ctx: Ctx): Promise<void> {
  const attached = await listSessionsInStates(ctx.db, ["human_attached"]);
  if (!attached.ok) {
    ctx.log.error({ error: attached.error }, "cannot list attached sessions");
    return;
  }
  for (const s of expiredAttachLeases(attached.value, ctx.clock.now())) {
    ctx.log.warn({ sessionId: s.id }, "attach lease expired");
    requestDetach(ctx, s.id).catch((e: unknown) => {
      ctx.log.error(
        { sessionId: s.id, err: String(e) },
        "cannot detach an expired attach lease",
      );
    });
  }
}

/** True if `s.tmux_target`'s tmux server still answers for `TMUX_SESSION_NAME` — a `human_attached`
 * row found at boot predates this supervisor by definition, but tmux sessions are independent,
 * detached processes that outlive the supervisor that started them: a restart alone doesn't mean
 * this one died too. */
async function tmuxAlive(
  ctx: Ctx,
  ex: Executor,
  s: SessionRow,
): Promise<boolean> {
  if (s.tmux_target === null) return false;
  return runToCompletion(
    ex,
    tmuxArgv(s.tmux_target, "has-session", "-t", TMUX_SESSION_NAME),
    s.session_root,
    { PATH: ctx.path },
  );
}

/**
 * Every pass (Invariant 12): a `human_attached` row whose tmux session is gone is an
 * attach that can never end on its own — the row says a human holds the session, and nothing is
 * there. Detached here rather than left to the TTL, because `lifecycle.attach_lease_ms` is a
 * ceiling on an *idle* attach, not a detector for a dead one: a CLI that crashes a minute into a
 * fifteen-minute lease would otherwise hold its session for the other fourteen.
 *
 * A live tmux session is always left alone. It is an independent, detached process that outlives
 * the supervisor that started it, so "alive" means alive, restart or no restart.
 *
 * `phase` changes one thing. At **boot** an already-expired lease is detached here too, because
 * such a row predates this supervisor and should not survive it. On a **periodic** pass expiry
 * belongs to `expireAttachLeases`, which runs later in the same pass and logs it as the routine
 * event it is — reporting a normal TTL expiry as an "attach incident" every 60 s would bury the
 * one line that means something.
 */
export async function reconcileOrphanedAttaches(
  ctx: Ctx,
  phase: PassPhase = "periodic",
): Promise<void> {
  const attached = await listSessionsInStates(ctx.db, ["human_attached"]);
  if (!attached.ok) {
    ctx.log.error({ error: attached.error }, "cannot list attached sessions");
    return;
  }
  const detaches: Promise<void>[] = [];
  for (const s of attached.value) {
    const ex = ctx.executors.get(s.executor_id)?.executor;
    const leaseExpired =
      phase === "boot" &&
      (s.attach_lease_expires_at === null ||
        s.attach_lease_expires_at < ctx.clock.now());
    const alive = ex !== undefined && (await tmuxAlive(ctx, ex, s));
    if (alive && !leaseExpired) {
      // Worth a line once, when a restart could have ended it; not every minute for ever.
      if (phase === "boot") {
        ctx.log.info(
          { sessionId: s.id, tmuxTarget: s.tmux_target },
          "attach: still live and unexpired across a restart; leaving it be",
        );
      }
      continue;
    }
    ctx.log.error(
      {
        sessionId: s.id,
        tmuxTarget: s.tmux_target,
        alive,
        leaseExpired,
        phase,
      },
      "attach incident: a human_attached session is dead or expired; detaching it now",
    );
    detaches.push(
      requestDetach(ctx, s.id).catch((e: unknown) => {
        ctx.log.error(
          { sessionId: s.id, err: String(e) },
          "cannot detach an orphaned attach",
        );
      }),
    );
  }
  // reapOrphanTmuxSockets, called right after this in the same boot pass, only skips sockets a DB
  // row still points at — it must see the detaches above already reflected in that DB state.
  await Promise.all(detaches);
}

const localExecutor = (ctx: Ctx): Executor | undefined =>
  [...ctx.executors.values()].find((e) => e.executor.kind === "local")
    ?.executor;

/**
 * Boot only: a tmux socket under $FRM_HOME/s/ with no `human_attached` session claiming it is a
 * leftover from a kill-server that never ran (e.g. a supervisor crash before this boot could even
 * see the DB row, or a host tmux binary that leaves its socket file behind after being killed
 * some other way) — reconcileOrphanedAttaches above only clears sockets a DB row still points at,
 * so this catches what that one cannot. Killed and logged, never silently left: an unowned live pty
 * with no session record is exactly the incident §12.5's hard invariant calls out.
 *
 * Local filesystem only: attach itself is restricted to the local executor (see attachOp), so
 * every tmux socket that could ever exist lives under this same $FRM_HOME/s/ — there is no
 * container-executor counterpart to reap yet.
 */
export async function reapOrphanTmuxSockets(ctx: Ctx): Promise<void> {
  const dir = join(ctx.frmHome, "s");
  let entries: readonly string[];
  try {
    entries = await readdir(dir);
  } catch {
    return; // no attach has ever run here: nothing to reap
  }
  const attached = await listSessionsInStates(ctx.db, ["human_attached"]);
  const claimed = new Set(
    attached.ok
      ? attached.value.map((s) => tmuxSocketPath(ctx.frmHome, s.id))
      : [],
  );
  const ex = localExecutor(ctx);
  if (ex === undefined) return;
  for (const name of entries) {
    const socket = join(dir, name);
    if (claimed.has(socket)) continue;
    ctx.log.error(
      { socket },
      "attach incident: an orphan tmux socket claims no session; killing it",
    );
    const killedOk = await runToCompletion(
      ex,
      tmuxArgv(socket, "kill-server"),
      ctx.frmHome,
      { PATH: ctx.path },
    );
    if (!killedOk) {
      ctx.log.error(
        { socket },
        "cannot kill an orphan tmux socket: the next boot retries",
      );
    }
  }
}
