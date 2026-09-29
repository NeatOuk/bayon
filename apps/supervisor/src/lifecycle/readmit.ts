// Re-admission of pending sessions after a restart (design, M4 amendment "sessions
// across a restart"). A pending row with no entry here and a stored spawn request is resolved again
// from that request (its first run with it), re-pinned where its inputs changed (§6.3, HIGH-1b),
// given a fresh MCP token, and handed back to admission as a waiter, in (created_at, id) order once
// the pass's step 1 has settled (MEDIUM-1). What cannot be re-admitted is abandoned: a pulse's or a
// reviewer's (their owners retry), a row with no request (internal spawns, rows before 013), a
// changed identity, or an early gate that now refuses.
import { PULSE_RUN_CLASS, type ErrorClass, type Result } from "@bayon/core";
import type { SessionRow } from "@bayon/db";
import {
  repinPendingSession,
  setSessionTokenHash,
  type PendingPins,
} from "@bayon/db/supervisor";
import { admitBeforeRow, type Admitted, type Waiter } from "./admission.js";
import { pinnedRuleset } from "./compression.js";
import type { Ctx } from "./context.js";
import { SessionSpawnPayload } from "./payloads.js";
import { resolveSpawn } from "./resolve.js";
import { firstRun } from "./ticket-run.js";

export type Readmission =
  | {
      readonly kind: "readmit";
      readonly createdAt: number;
      readonly waiter: Omit<Waiter, "reason">;
    }
  | {
      readonly kind: "abandon";
      readonly errorClass: ErrorClass;
      /** Null: no request to re-admit from, so the restart's own message (a queued reason kept). */
      readonly why: string | null;
    };

/** A waiter prepared on its session's queue, for step 1b. */
export type ReadyReadmission = Extract<Readmission, { kind: "readmit" }>;

const abandon = (
  why: string | null,
  errorClass: ErrorClass = "interrupted",
): Readmission => ({ kind: "abandon", errorClass, why });

/** The stored request, zod-parsed again on the way out (LOW-7); null when absent or bad. */
function storedRequest(s: SessionRow): SessionSpawnPayload | null {
  if (s.spawn_request_json === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(s.spawn_request_json);
  } catch {
    return null;
  }
  const parsed = SessionSpawnPayload.safeParse(raw);
  return parsed.success && parsed.data.session_id === s.id ? parsed.data : null;
}

/** An identity column the re-resolve disagrees on: never re-pinned (§6.3). */
function identityChange(s: SessionRow, a: Admitted): string | null {
  if (a.runner.id !== s.runner_id) return "runner_id";
  if (a.executorId !== s.executor_id) return "executor_id";
  if (a.workspaceId !== s.workspace_id) return "workspace_id";
  return null;
}

function pinsOf(a: Admitted): PendingPins {
  return {
    config_hash: a.configHash,
    toolset_hash: a.toolset.hash,
    model: a.model.model,
    model_tier: a.model.tier,
    effort: a.model.effort,
    mission_hash: a.missionHash,
    context_ruleset: pinnedRuleset(a.compression),
  };
}

const samePins = (s: SessionRow, p: PendingPins): boolean =>
  s.config_hash === p.config_hash &&
  s.toolset_hash === p.toolset_hash &&
  s.model === p.model &&
  s.model_tier === p.model_tier &&
  s.effort === p.effort &&
  s.mission_hash === p.mission_hash &&
  s.context_ruleset === p.context_ruleset;

/** Prepares the session's waiter, or says why it is abandoned. Runs on the session's queue. */
export async function prepareReadmit(
  ctx: Ctx,
  s: SessionRow,
): Promise<Readmission> {
  if (s.run_class === PULSE_RUN_CLASS) {
    return abandon("a pulse session is never re-admitted: its pulse settles");
  }
  if (s.gate_id !== null) {
    return abandon("a reviewer session is never re-admitted: its gate retries");
  }
  const request = storedRequest(s);
  if (request === null) {
    return abandon(null);
  }
  const resolved = await resolveSpawn(ctx, request);
  if (!resolved.ok) {
    return abandon(
      `it cannot be resolved again after the restart: ${resolved.error.message}`,
    );
  }
  const admitted = await admitBeforeRow(ctx, resolved.value);
  if (!admitted.ok)
    return abandon(admitted.error.message, admitted.error.class);
  const moved = identityChange(s, admitted.value);
  if (moved !== null) return abandon(`changed while queued: ${moved}`);
  const first = await firstRun(ctx, admitted.value);
  if (!first.ok) {
    return abandon(
      `its run 1 cannot be compiled again after the restart: ${first.error.message}`,
    );
  }
  const repinned = await repin(ctx, s, pinsOf(admitted.value));
  if (!repinned.ok) return abandon(repinned.error.message);
  // The old plaintext died with the old process: the new token's hash, before any process exists.
  const minted = await setSessionTokenHash(
    ctx.db,
    s.id,
    admitted.value.mcpToken.hash,
  );
  if (!minted.ok) return abandon(minted.error.message);
  return {
    kind: "readmit",
    createdAt: s.created_at,
    waiter: {
      sessionId: s.id,
      admitted: admitted.value,
      first: first.value === undefined ? undefined : { run: first.value },
    },
  };
}

async function repin(
  ctx: Ctx,
  s: SessionRow,
  pins: PendingPins,
): Promise<Result<void>> {
  if (samePins(s, pins)) return { ok: true, value: undefined };
  const done = await repinPendingSession(ctx.db, s.id, pins);
  if (!done.ok) return done;
  ctx.log.info(
    { sessionId: s.id },
    "re-admission re-pinned inputs that changed while the supervisor was down",
  );
  return { ok: true, value: undefined };
}

/**
 * Step 1b (MEDIUM-1): the prepared waiters, in (created_at, id) order, each with its entry, handed
 * to admission once every session's step-1 op has settled, so adopted sessions hold their slots
 * first. A session something else took meanwhile keeps its own path.
 */
export function enqueueReadmissions(
  ctx: Ctx,
  prepared: readonly ReadyReadmission[],
): void {
  const ordered = [...prepared].sort(
    (a, b) =>
      a.createdAt - b.createdAt ||
      a.waiter.sessionId.localeCompare(b.waiter.sessionId),
  );
  for (const r of ordered) {
    const id = r.waiter.sessionId;
    if (ctx.live.has(id)) continue;
    ctx.live.set(id, { abort: new AbortController(), dead: false });
    ctx.owned.add(id); // this process re-admits it: its spawn is ours now
    ctx.admission.enqueue(r.waiter);
    ctx.log.info({ sessionId: id }, "re-admitted after a restart");
  }
}
