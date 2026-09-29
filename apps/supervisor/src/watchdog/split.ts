// The "split?" question: a ticket on the split_candidate arm (its hand-offs at
// or past autosplit.handoff_threshold) gets one human_request per threshold value. It never splits
// and never moves a status: auto-split is deferred past M4.
import { listSplitAsks } from "@bayon/db";
import { insertSystemHumanRequest } from "@bayon/db/supervisor";
import type { WatchdogDeps } from "./ports.js";
import { SPLIT_OPTIONS, splitContext, splitQuestion } from "./texts.js";

export async function splitRule(
  d: WatchdogDeps,
  threshold: number,
  ticketId?: string,
): Promise<void> {
  const asks = await listSplitAsks(d.db);
  if (!asks.ok) {
    d.log.error({ error: asks.error }, "split: cannot list candidates");
    return;
  }
  for (const a of asks.value) {
    if (ticketId !== undefined && a.ticketId !== ticketId) continue;
    const filed = await insertSystemHumanRequest(d.db, {
      rule: "split",
      subject: a.ticketId,
      window: String(threshold),
      ticket_id: a.ticketId,
      question: splitQuestion({ num: a.num, handoffs: a.handoffs, threshold }),
      context_md: splitContext(a),
      options: [...SPLIT_OPTIONS],
    });
    if (!filed.ok) {
      d.log.error({ ticketId: a.ticketId, error: filed.error }, "split");
    } else if (filed.value.created) {
      d.log.info(
        {
          ticketId: a.ticketId,
          handoffs: a.handoffs,
          request: filed.value.row.id,
        },
        "split: asked a human",
      );
    }
  }
}
