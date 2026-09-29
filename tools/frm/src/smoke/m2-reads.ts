import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "@bayon/core";
import {
  ENDED_STATES,
  LIVE_PULSE_STATES,
  getRunSpend,
  getSession,
  getTicket,
  listLiveSessions,
  listPendingHandoffs,
  listPulses,
  listSessionWorktrees,
  listTicketHandoffs,
  type HandoffRow,
} from "@bayon/db";
import { GIT_ENV_FLOOR, safeGitArgs } from "@bayon/executors";
import { pollUntil } from "./deadline.js";
import { refuse, verdict } from "./harness.js";
import { holdingProblems, type PulseFacts } from "./m2-assertions.js";
import type { World } from "./phases.js";

// What the M2 smoke reads at its checkpoints: the database through @bayon/db's reads, and the
// one worktree the chain shares on disk.

const POLL_MS = 200;

/** Polls `probe` every 200 ms until it yields a value, or fails with `what` at `timeoutMs`. */
export const waitFor = <T>(
  w: World,
  what: string,
  timeoutMs: number,
  probe: () => Promise<Result<T | undefined>>,
): Promise<Result<T>> =>
  pollUntil({ clock: w.h.clock, timeoutMs, intervalMs: POLL_MS, what }, probe);

const ended = (state: string): boolean =>
  (ENDED_STATES as readonly string[]).includes(state);
export const isLivePulse = (state: string): boolean =>
  (LIVE_PULSE_STATES as readonly string[]).includes(state);

/** The builder session staffing started on the ticket, once it exists. */
export async function builderOn(
  w: World,
  ticketId: string,
): Promise<Result<string | undefined>> {
  const live = await listLiveSessions(w.db);
  if (!live.ok) return live;
  return ok(
    live.value.find((s) => s.ticket_id === ticketId && s.role === "builder")
      ?.id,
  );
}

export interface Worktree {
  readonly id: string;
  readonly path: string;
}

/** The worktree the session holds now, once its workspace step made (or inherited) one. */
export async function worktreeOf(
  w: World,
  sessionId: string,
): Promise<Result<Worktree | undefined>> {
  const rows = await listSessionWorktrees(w.db, sessionId);
  if (!rows.ok) return rows;
  const row = rows.value[0];
  return ok(row === undefined ? undefined : { id: row.id, path: row.path });
}

/**
 * The session's hand-off, once finalized (no longer `writing`), the session ended, and the packet
 * file in `dir` caught up: the row commits first and the file follows it.
 */
export async function handoffFrom(
  w: World,
  ticketId: string,
  sessionId: string,
  dir: string,
): Promise<Result<HandoffRow | undefined>> {
  const rows = await listTicketHandoffs(w.db, ticketId);
  if (!rows.ok) return rows;
  const row = rows.value.find((h) => h.from_session_id === sessionId);
  if (row === undefined || row.quality === "writing") return ok(undefined);
  const s = await getSession(w.db, sessionId);
  if (!s.ok) return s;
  if (!ended(s.value.state)) return ok(undefined);
  const file = fileIn(dir, row.packet_path);
  const hash =
    file === undefined
      ? undefined
      : createHash("sha256").update(file).digest("hex");
  return ok(hash === row.packet_hash ? row : undefined);
}

/** The session that accepted hand-off `id`, once one has. */
export async function acceptedBy(
  w: World,
  ticketId: string,
  id: string,
): Promise<Result<string | undefined>> {
  const rows = await listTicketHandoffs(w.db, ticketId);
  if (!rows.ok) return rows;
  const row = rows.value.find((h) => h.id === id);
  return ok(
    row?.accepted_at === null || row?.accepted_at === undefined
      ? undefined
      : (row.to_session_id ?? undefined),
  );
}

/** The ticket's status, once it is `status`. */
export async function ticketIs(
  w: World,
  ticketId: string,
  status: string,
): Promise<Result<string | undefined>> {
  const t = await getTicket(w.db, ticketId);
  if (!t.ok) return t;
  return ok(t.value.status === status ? status : undefined);
}

/** §13.1 now: exactly one of a live owner, a pending hand-off, a terminal or blocked status. */
export async function holdingNow(
  w: World,
  ticketId: string,
): Promise<Result<void>> {
  const ticket = await getTicket(w.db, ticketId);
  if (!ticket.ok) return ticket;
  const live = await listLiveSessions(w.db);
  if (!live.ok) return live;
  const pending = await listPendingHandoffs(w.db, ticketId);
  if (!pending.ok) return pending;
  return verdict(
    holdingProblems(
      ticket.value,
      live.value.filter((s) => s.ticket_id === ticketId),
      pending.value.map((h) => h.id),
    ),
  );
}

export type PulseSeen = PulseFacts & { readonly scheduled_at: number };

/** The agent's pulses, oldest first, each with the pulse_id on its run's spend row. */
export async function pulsesOf(
  w: World,
  agentId: string,
): Promise<Result<PulseSeen[]>> {
  const rows = await listPulses(w.db, { agent_id: agentId, limit: 200 });
  if (!rows.ok) return rows;
  const seen: PulseSeen[] = [];
  for (const p of rows.value.toReversed()) {
    const spend = p.run_id === null ? null : await getRunSpend(w.db, p.run_id);
    if (spend !== null && !spend.ok) return spend;
    seen.push({
      ...p,
      spend_pulse_id: spend === null ? undefined : spend.value?.pulse_id,
    });
  }
  return ok(seen);
}

/** A file in the worktree as text, or undefined when it is not there. */
export function fileIn(dir: string, rel: string): string | undefined {
  try {
    return readFileSync(join(dir, rel), "utf8");
  } catch {
    return undefined;
  }
}

/** `git status --porcelain=v1 -z` of a worktree, as git printed it (a leading space matters). */
export function gitStatus(dir: string): Result<string> {
  try {
    return ok(
      // An agent wrote this worktree, so the flags are safeGitArgs', never its config.
      execFileSync(
        "git",
        safeGitArgs([
          "-C",
          dir,
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ]),
        {
          encoding: "utf8",
          env: { ...process.env, ...GIT_ENV_FLOOR },
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    );
  } catch (cause) {
    return err({
      class: "internal",
      message: `git status in ${dir}: ${cause instanceof Error ? cause.message : String(cause)}`,
      retryable: false,
    });
  }
}

/** SIGKILLs the session's runner process group (a `local:<pid>:<start>` ref): a crash. */
export async function killRunner(
  w: World,
  sessionId: string,
): Promise<Result<number>> {
  const s = await getSession(w.db, sessionId);
  if (!s.ok) return s;
  const pid = /^local:(\d+):/.exec(s.value.executor_ref ?? "")?.[1];
  if (pid === undefined)
    return err(refuse(`session ${sessionId} has no local runner process`));
  try {
    process.kill(-Number(pid), "SIGKILL");
    return ok(Number(pid));
  } catch (cause) {
    return err(
      refuse(
        `kill -9 ${pid}: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
    );
  }
}
