// Pin refs in an executor's mirrors. A review on a container pins its head as
// refs/frm/gate/<gate id>, a pinned session as refs/frm/pin/<session id>, in the executor's shared
// mirror, where nothing else ever deletes them (the push refuses deletions by design). They go
// through the executor's dedicated, validated drop: at a session's end for its own refs, and each
// reconciler pass for every ref whose gate or session is finished. A ref with no row here is kept:
// it may be another supervisor's, sharing the executor (as the reaper assumes for containers).
import {
  getGate,
  getSession,
  listGateSessions,
  listSessionWorktrees,
  type SessionRow,
} from "@bayon/db";
import {
  MAX_PIN_REFS,
  PIN_REF,
  type Executor,
  type ExecutorMirrors,
} from "@bayon/executors";
import { isIn, PROCESS_STATES, SPAWN_STATES, type Ctx } from "./context.js";

/** No spawn step and no process left: what the reaper releases. */
export const ended = (s: SessionRow): boolean =>
  !isIn(SPAWN_STATES, s.state) && !isIn(PROCESS_STATES, s.state);

export type PinFate = "drop" | "keep";

/**
 * The states in which a gate's session is done with its pinned head: no process, and none coming
 * back (a reviewer is never adopted, an earlier change H3). Named, not the complement of the live states, so
 * a state wired in later (a pause for a human) keeps the ref.
 */
const DONE_WITH_GATE: readonly SessionRow["state"][] = [
  "exited",
  "handed_off",
  "resumable",
];

/**
 * Whether a pin ref may go:
 * - a gate's, once the gate is decided (not running) and every session of it is done with it;
 * - a session's, once it has exited for good (a resumable one may come back to its clone, whose
 *   objects the pin keeps from gc).
 * Anything else, a live session, or a row that is not here, keeps it.
 */
export async function pinFate(ctx: Ctx, ref: string): Promise<PinFate> {
  const m = PIN_REF.exec(ref);
  const kind = m?.[1];
  const id = m?.[2];
  if (kind === undefined || id === undefined) return "keep";
  if (kind === "pin") {
    const s = await getSession(ctx.db, id);
    return s.ok && s.value.state === "exited" && !ctx.live.has(id)
      ? "drop"
      : "keep";
  }
  const gate = await getGate(ctx.db, id);
  if (!gate.ok || gate.value.state === "running") return "keep";
  const sessions = await listGateSessions(ctx.db, [id]);
  if (!sessions.ok) return "keep";
  for (const { session_id } of sessions.value) {
    const s = await getSession(ctx.db, session_id);
    if (
      !s.ok ||
      !DONE_WITH_GATE.includes(s.value.state) ||
      ctx.live.has(session_id)
    ) {
      return "keep";
    }
  }
  return "drop";
}

/** `refs` in chunks the executor takes in one call. */
function chunks(refs: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < refs.length; i += MAX_PIN_REFS) {
    out.push(refs.slice(i, i + MAX_PIN_REFS));
  }
  return out;
}

async function drop(
  ctx: Ctx,
  executor: Executor,
  mirrors: ExecutorMirrors,
  name: string,
  refs: readonly string[],
): Promise<void> {
  for (const part of chunks(refs)) {
    try {
      await mirrors.dropPins(name, part);
      ctx.log.info(
        { executor: executor.id, mirror: name, refs: part },
        "dropped finished pin refs from the executor's mirror",
      );
    } catch (e) {
      ctx.log.error(
        { executor: executor.id, mirror: name, err: String(e) },
        "cannot drop pin refs from the executor's mirror: the next pass retries",
      );
    }
  }
}

/**
 * At a session's end, once its container is released (so after afterExit collected a reviewer's
 * evidence and decided its gate): its own pin refs, in the mirrors of its worktrees, as far as
 * pinFate lets them go. What cannot go yet is the sweep's.
 */
export async function dropSessionPins(
  ctx: Ctx,
  executor: Executor,
  s: SessionRow,
): Promise<void> {
  const { mirrors } = executor;
  if (mirrors === undefined) return;
  const worktrees = await listSessionWorktrees(ctx.db, s.id);
  if (!worktrees.ok) {
    ctx.log.error(
      { sessionId: s.id, error: worktrees.error },
      "cannot list the session's worktrees: its pin refs are left to the sweep",
    );
    return;
  }
  const names = [...new Set(worktrees.value.map((w) => w.repo_id))];
  if (names.length === 0) return;
  const candidates = [
    `refs/frm/pin/${s.id}`,
    ...(s.gate_id === null ? [] : [`refs/frm/gate/${s.gate_id}`]),
  ].filter((ref) => PIN_REF.test(ref));
  const refs: string[] = [];
  for (const ref of candidates) {
    if ((await pinFate(ctx, ref)) === "drop") refs.push(ref);
  }
  if (refs.length === 0) return;
  for (const name of names) await drop(ctx, executor, mirrors, name, refs);
}

/** Each reconciler pass: every pin ref an executor's mirrors hold whose gate or session is done. */
export async function sweepMirrorPins(ctx: Ctx): Promise<void> {
  for (const { executor } of ctx.executors.values()) {
    const { mirrors } = executor;
    if (mirrors === undefined) continue;
    let pins: Awaited<ReturnType<ExecutorMirrors["listPins"]>>;
    try {
      pins = await mirrors.listPins();
    } catch (e) {
      ctx.log.error(
        { executor: executor.id, err: String(e) },
        "cannot list the pin refs of the executor's mirrors",
      );
      continue;
    }
    const fates = new Map<string, PinFate>();
    const byMirror = new Map<string, readonly string[]>();
    for (const { name, ref } of pins) {
      const fate = fates.get(ref) ?? (await pinFate(ctx, ref));
      fates.set(ref, fate);
      if (fate === "drop")
        byMirror.set(name, [...(byMirror.get(name) ?? []), ref]);
    }
    for (const [name, refs] of byMirror) {
      await drop(ctx, executor, mirrors, name, refs);
    }
  }
}
