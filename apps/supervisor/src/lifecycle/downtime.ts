// A run that outlived its wall clock while the supervisor was down: judged by
// the wall clock the run pinned (runs.wall_clock_ms, 013), never today's run class; a run from
// before 013 falls back to its session's run class.
import { getOpenRun, type SessionRow } from "@bayon/db";
import type { Ctx } from "./context.js";
import { findRunClass } from "./resolve.js";

/** The open run's wall clock, in ms, when it has already passed; null when in budget or none. */
export async function pastWallClock(
  ctx: Ctx,
  s: SessionRow,
): Promise<number | null> {
  const open = await getOpenRun(ctx.db, s.id);
  if (!open.ok) {
    ctx.log.error(
      { sessionId: s.id, error: open.error },
      "cannot read the open run",
    );
    return null;
  }
  if (open.value === null) return null;
  const pinned =
    open.value.wall_clock_ms ?? (await runClassWallClock(ctx, s.run_class));
  if (pinned === null) return null;
  return open.value.started_at + pinned <= ctx.clock.now() ? pinned : null;
}

async function runClassWallClock(
  ctx: Ctx,
  name: string,
): Promise<number | null> {
  const found = await findRunClass(ctx, name);
  return found.ok ? found.value.wall_clock_ms : null;
}
