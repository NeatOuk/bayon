import { ok, type Result } from "@bayon/core";
import {
  getHandoff,
  getTicket,
  getTicketByNum,
  listHandoffs,
  type Db,
  type HandoffRow,
} from "@bayon/db";
import { HandoffDetail, HandoffSummary } from "@bayon/proto";
import { jsonColumn, parseAs } from "./dto.js";
import type { ApiStore } from "./store.js";

// The hand-off half of the ApiStore (M2): hand-offs as DTOs, read only here. The
// supervisor writes their facts; the API writes their judgement and accept through /mcp.

export type HandoffStore = Pick<ApiStore, "handoffs" | "handoff">;

const toSummary = (row: HandoffRow): Result<HandoffSummary> =>
  parseAs(HandoffSummary, row, `handoff ${row.id}`);

function toDetail(row: HandoffRow): Result<HandoffDetail> {
  const what = `handoff ${row.id}`;
  const facts = jsonColumn(row.facts_json, `${what} facts`);
  if (!facts.ok) return facts;
  const pointers = jsonColumn(row.pointers_json, `${what} pointers`);
  if (!pointers.ok) return pointers;
  return parseAs(
    HandoffDetail,
    { ...row, facts: facts.value, pointers: pointers.value ?? [] },
    what,
  );
}

/** A ticket's id from its id or number; not_found when neither names one. */
async function ticketIdOf(db: Db, ref: string): Promise<Result<string>> {
  const row = /^\d+$/.test(ref)
    ? await getTicketByNum(db, Number(ref))
    : await getTicket(db, ref);
  return row.ok ? ok(row.value.id) : row;
}

export function handoffStore(db: Db): HandoffStore {
  return {
    async handoffs({ ticket, pending, limit }) {
      const ticketId =
        ticket === undefined ? undefined : await ticketIdOf(db, ticket);
      if (ticketId !== undefined && !ticketId.ok) return ticketId;
      const page = await listHandoffs(db, {
        ...(ticketId === undefined ? {} : { ticketId: ticketId.value }),
        pending,
        limit,
      });
      if (!page.ok) return page;
      const items: HandoffSummary[] = [];
      for (const row of page.value.rows) {
        const item = toSummary(row);
        if (!item.ok) return item;
        items.push(item.value);
      }
      return ok({ items, has_more: page.value.hasMore });
    },
    async handoff(id) {
      const row = await getHandoff(db, id);
      return row.ok ? toDetail(row.value) : row;
    },
  };
}
