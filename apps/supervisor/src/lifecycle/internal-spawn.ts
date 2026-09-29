// Lifecycle.spawnInternal: the supervisor's own spawns, never
// reachable from a command (Invariant 5 governs who inserts commands, not what the supervisor calls
// on itself). One type serves the pulse's orchestrator (no worktree), M2-c's successor (an
// inherited worktree: `payload.handoff_id`, its packet put into run 1) and M3-h's review spawn.
import { err, ok, type Result } from "@bayon/core";
import { getSession } from "@bayon/db";
import { admitBeforeRow } from "./admission.js";
import type { AfterExit } from "./after-exit.js";
import type { Ctx } from "./context.js";
import { endSession } from "./end.js";
import { frmError } from "./errors.js";
import type { SessionSpawnPayload } from "./payloads.js";
import { compileRun, type RunRequest } from "./prompt.js";
import {
  createSessionRow,
  resolveSpawn,
  type InternalWorkspace,
} from "./resolve.js";
import { withPacket } from "./successor.js";

export type { InternalWorkspace } from "./resolve.js";

export interface InternalSpawn {
  readonly payload: Omit<SessionSpawnPayload, "prompt">;
  /** Run 1, pre-flighted before the session row exists: an over-budget prompt spawns nothing. */
  readonly run: RunRequest;
  readonly workspace: InternalWorkspace;
  /** MCP tools the session must mount, else `validation` before any spend. */
  readonly requireTools?: readonly string[];
  /**
   * Epoch ms. Past it a spawn still in progress (the slot wait and git included) is aborted with
   * `timeout`, and run 1's wall clock is capped to end by it.
   */
  readonly deadline?: number;
  /** Awaited after the session row commits, before the pipeline is queued; a failure aborts it. */
  readonly onCreated?: (sessionId: string) => Promise<Result<void>>;
  /** A gate's reviewer (M3-h): `sessions.gate_id`, and the bound runner a fallback replaced. */
  readonly gate?: { readonly id: string; readonly fallbackFrom: string | null };
  /** A profile for the payload's runner instead of the agent's (a role binding's). */
  readonly profileId?: string;
  /**
   * The role binding whose `model_tier` decides the model, when it is not the payload's role
   *: a gate's reviewer runs as `reviewer` but on the code_reviewer or plan_reviewer
   * binding the pick chose it by, so it spawns the very model the pick checked certification on.
   */
  readonly bindingRole?: string;
  /**
   * Environment this one spawn adds on top of its profile's (H1): what the session works
   * on, which a profile row cannot know. Never a secret (§14: those come from the secret store).
   *
   * Validated and hashed: `resolveSpawn` holds each name to `ENV_NAME`, refuses
   * `RESERVED_ENV` and refuses a name the profile's secrets already claim — each of which
   * `buildEnv` would otherwise have silently overwritten — and folds the whole map into
   * `config_hash`, so two sessions of one profile that work on different things do not hash alike
   * (§8.1) and an adopt, which rebuilds the env from the profile alone, cannot pass the hash check.
   */
  readonly env?: Readonly<Record<string, string>>;
  /** Told once its process closes, before the session ends. */
  readonly afterExit?: AfterExit;
}

/** Resolves, pre-flights, creates the session and queues its pipeline; resolves to its id. */
export async function spawnInternal(
  ctx: Ctx,
  spec: InternalSpawn,
): Promise<Result<string>> {
  const id = spec.payload.session_id;
  if (spec.deadline !== undefined && spec.deadline <= ctx.clock.now()) {
    return err(frmError("timeout", "the deadline passed before the spawn"));
  }
  // A session of this id exists already: before anything is resolved or gated (MEDIUM-3).
  const existing = await getSession(ctx.db, id);
  if (existing.ok)
    return err(frmError("conflict", `session ${id} already exists`));
  if (existing.error.class !== "not_found") return existing;
  const r = await resolveSpawn(ctx, spec.payload, {
    workspace: spec.workspace,
    ...(spec.gate === undefined ? {} : { gate: spec.gate }),
    ...(spec.profileId === undefined ? {} : { profileId: spec.profileId }),
    ...(spec.bindingRole === undefined
      ? {}
      : { bindingRole: spec.bindingRole }),
    ...(spec.env === undefined ? {} : { env: spec.env }),
  });
  if (!r.ok) return r;
  const missing = (spec.requireTools ?? []).filter(
    (tool) => !r.value.toolset.tools.includes(tool),
  );
  if (missing.length > 0) {
    return err(
      frmError(
        "validation",
        `session ${id} would not mount ${missing.join(", ")}: check the profile's allowlist`,
      ),
    );
  }
  const run =
    r.value.successor === null
      ? ok(spec.run)
      : withPacket(spec.run, r.value.successor);
  if (!run.ok) return run;
  const checked = await compileRun(
    ctx,
    r.value.adapter,
    r.value.runClass,
    run.value,
  );
  if (!checked.ok) return checked;
  // Gates 1–5 before the row: the caller hears a refusal and its gate now.
  const admitted = await admitBeforeRow(ctx, r.value);
  if (!admitted.ok) return admitted;
  const created = await createSessionRow(ctx, admitted.value);
  if (!created.ok) return created;
  if (!created.value.created) {
    return err(frmError("conflict", `session ${id} already exists`));
  }
  ctx.live.set(id, { abort: new AbortController(), dead: false });
  ctx.owned.add(id); // this process spawns it
  if (spec.afterExit !== undefined) ctx.afterExit.set(id, spec.afterExit);
  const linked =
    spec.onCreated === undefined ? ok(undefined) : await spec.onCreated(id);
  if (!linked.ok) {
    await endSession(ctx, id, "abort", {
      exit_reason: "error",
      error_class: linked.error.class,
      error_message: linked.error.message,
    });
    return linked;
  }
  if (spec.deadline !== undefined) armSpawnDeadline(ctx, id, spec.deadline);
  const first = {
    run: run.value,
    internal: true,
    ...(spec.deadline === undefined ? {} : { deadline: spec.deadline }),
  };
  ctx.admission.enqueue({ sessionId: id, admitted: admitted.value, first });
  return ok(id);
}

/**
 * At the deadline, a session with no process yet is aborted with `timeout`: a queued one names
 * the gate that held it; one with a process is run 1's wall clock's to end
 * (capped at the same deadline).
 */
function armSpawnDeadline(ctx: Ctx, id: string, deadline: number): void {
  const entry = ctx.live.get(id);
  if (entry === undefined) return;
  ctx.clock.after(deadline - ctx.clock.now(), entry.abort.signal).then(
    () => {
      const current = ctx.live.get(id);
      if (current === undefined || current.proc !== undefined) return;
      const queued = ctx.admission.reasonOf(id);
      const late = "the spawn did not finish by its deadline";
      current.abort.abort(
        queued === null
          ? frmError("timeout", late)
          : frmError("timeout", `${late} (queued: ${queued})`, {
              queued_reason: queued,
            }),
      );
    },
    () => undefined, // aborted already: a stop, or the pipeline's own unwind
  );
}
