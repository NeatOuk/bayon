// The degraded path (§7.4): a holding session that ends without a finished
// hand-off still leaves a row, its facts from git and events. Also the reconciler's sweep of rows
// sealed but never finalized.
import { holdsTicket, ok, type Result } from "@bayon/core";
import {
  getSession,
  getTicket,
  listStrandedHandoffs,
  type HandoffRow,
  type SessionRow,
} from "@bayon/db";
import {
  finalizeHandoffPacket,
  insertHandoffFacts,
} from "@bayon/db/supervisor";
import { announceHandoffPending, type Ctx } from "./context.js";
import { gatherFacts, type PacketPlace } from "./facts.js";
import { writePacketFile } from "./packet-file.js";
import { judgementOf, packetNumber, renderRow } from "./packet-render.js";

/** Whether the session holds its ticket (core holdsTicket; review HIGH 3). */
export async function holds(ctx: Ctx, s: SessionRow): Promise<Result<boolean>> {
  if (s.ticket_id === null) return ok(false);
  const ticket = await getTicket(ctx.db, s.ticket_id);
  if (!ticket.ok) return ticket;
  return ok(holdsTicket(s, ticket.value));
}

/**
 * A degraded row, final at once, for a holding session with none (§7.4). Idempotent per session;
 * its packet file is written after the commit. Resolves to the row this call created, else null.
 * It is not announced here: it is inserted before the end edge, and only takeable once the edge
 * has ended its session, so endSession announces it then.
 */
export async function insertDegraded(
  ctx: Ctx,
  s: SessionRow,
  reason: string,
  why: string,
): Promise<Result<HandoffRow | null>> {
  if (s.ticket_id === null) return ok(null);
  const gathered = await gatherFacts(ctx, s);
  if (!gathered.ok) return gathered;
  const { place } = gathered.value;
  const facts = { ...gathered.value.facts, why }; // re-renderable from the row (M2-c)
  let text = "";
  const inserted = await insertHandoffFacts(ctx.db, {
    ticket_id: s.ticket_id,
    from_session_id: s.id,
    reason,
    phase_from: s.run_class,
    phase_to: s.run_class,
    facts_json: JSON.stringify(facts),
    quality: "degraded",
    render: (n, handoffId) => {
      const r = renderRow(ctx, {
        id: handoffId,
        n,
        reason,
        phase: s.run_class,
        quality: "degraded",
        facts,
        judgement: null,
        verified: false,
        why,
      });
      text = r.text;
      return r;
    },
  });
  if (!inserted.ok) return inserted;
  if (inserted.value.created) {
    ctx.log.warn(
      { sessionId: s.id, handoffId: inserted.value.row.id, reason, why },
      "degraded hand-off written",
    );
    await writeLogged(ctx, s.id, place, inserted.value.row.packet_path, text);
  }
  return ok(inserted.value.created ? inserted.value.row : null);
}

/**
 * Finalizes a sealed `writing` row with fresh facts: `full`, or `degraded` with any judgement
 * rendered as unverified (review decision 1). The packet file follows the commit.
 */
export async function finalizeRow(
  ctx: Ctx,
  s: SessionRow,
  handoffId: string,
  quality: "full" | "degraded",
  why: string,
): Promise<Result<void>> {
  const gathered = await gatherFacts(ctx, s);
  if (!gathered.ok) return gathered;
  const { place } = gathered.value;
  const facts = { ...gathered.value.facts, why }; // re-renderable from the row (M2-c)
  let text = "";
  const final = await finalizeHandoffPacket(ctx.db, {
    id: handoffId,
    facts_json: JSON.stringify(facts),
    quality,
    render: (row) => {
      const r = renderRow(ctx, {
        id: row.id,
        n: packetNumber(row),
        reason: row.reason,
        phase: row.phase_from,
        // The row's own phases: a phase-change hand-off keeps its `spike → build` header when the
        // packet is re-rendered; every other row has the two equal.
        phaseTo: row.phase_to,
        quality,
        facts,
        judgement: judgementOf(row),
        verified: quality === "full",
        why,
      });
      text = r.text;
      return r;
    },
  });
  if (!final.ok) return final;
  ctx.log.info(
    { sessionId: s.id, handoffId, quality, tokens: final.value.tokens_est },
    "hand-off packet finalized",
  );
  await writeLogged(ctx, s.id, place, final.value.packet_path, text);
  announceHandoffPending(ctx, final.value, s);
  return ok(undefined);
}

/** A failed file write is logged: the row is authoritative and M2-c re-writes the file from it. */
async function writeLogged(
  ctx: Ctx,
  sessionId: string,
  place: PacketPlace | undefined,
  rel: string,
  text: string,
): Promise<void> {
  if (place === undefined) {
    ctx.log.warn(
      { sessionId, rel },
      "no worktree: the packet is in the row only",
    );
    return;
  }
  const written = await writePacketFile(
    ctx,
    place.executor,
    place.dir,
    rel,
    text,
  );
  if (!written.ok) {
    ctx.log.error(
      { sessionId, rel, error: written.error },
      "cannot write the packet file; the row keeps the packet",
    );
  }
}

/**
 * Rows still `writing` whose session has ended: a crash came between the seal and the finalize
 *. `full` when the session handed off, else `degraded`.
 */
export async function sweepStranded(ctx: Ctx): Promise<void> {
  const stranded = await listStrandedHandoffs(ctx.db);
  if (!stranded.ok) {
    ctx.log.error({ error: stranded.error }, "cannot list stranded hand-offs");
    return;
  }
  for (const row of stranded.value) {
    if (row.from_session_id === null) continue;
    const s = await getSession(ctx.db, row.from_session_id);
    if (!s.ok) continue;
    const handedOff = row.session_state === "handed_off";
    const done = await finalizeRow(
      ctx,
      s.value,
      row.id,
      handedOff ? "full" : "degraded",
      "the supervisor restarted",
    );
    if (!done.ok) {
      ctx.log.error(
        { handoffId: row.id, error: done.error },
        "cannot finalize a stranded hand-off",
      );
    }
  }
}
