import { err, ok, type Result } from "@bayon/core";
import {
  listAuditByActor,
  listSessionHumanRequests,
  listTicketEvents,
  listTickets,
  type TicketRow,
} from "@bayon/db";
import { seedConfig } from "@bayon/db/operator";
import type { EventItem, TicketView } from "@bayon/proto";
import { follow, hasKind, terminalOf } from "./follow.js";
import { refuse, verdict } from "./harness.js";
import {
  askProblems,
  auditProblems,
  followupProblems,
  mcpCallProblems,
  ticketEventProblems,
} from "./m1-assertions.js";
import { M1, M1_CALLS, m1Audit, m1Rows, m1SpawnRequest } from "./m1-config.js";
import { exportsTwice } from "./m1-exports.js";
import { saveMission } from "./missions.js";
import {
  commandDone,
  eventsUntil,
  sessionIn,
  spawnWith,
  type World,
} from "./phases.js";

// `frm smoke --m1` (plan "Verification (M1 close)"): an agent reads its ticket, updates it, files
// another and is refused a write to it, asks a human, all attributable (§6). Its session is a
// fixture run whose script makes those MCP calls against the API's /mcp.

/** Ticket A over REST, then the M1 agent: a profile scripted on A, and its mission over REST. */
async function seedM1(w: World): Promise<TicketView> {
  const a = await w.h.step("POST /tickets (ticket A, as the operator)", () =>
    w.api.createTicket(M1.ticketA),
  );
  await w.h.step(
    `${M1.agent}: a profile scripted on ${a.key}, the builder's MCP tools`,
    async () =>
      seedConfig(w.db, await m1Rows({ now: w.h.clock.now(), ticketId: a.id })),
  );
  await saveMission(w.h, w.api, w.db, M1.agent);
  return a;
}

/** human_ask's call has arrived, or a terminal (a step failed first). */
const askedOrEnded = (items: readonly EventItem[]): boolean =>
  items.some(
    (i) =>
      i.kind === "terminal" ||
      (i.kind === "mcp_call" && i.tool_name === "human_ask"),
  );

/** No terminal before the gate: the fixture ends its run `failed` on an unmet expectation. */
function noTerminal(items: readonly EventItem[]): Result<void> {
  const t = terminalOf(items);
  if (t === undefined) return ok(undefined);
  const why = t.payload.error?.message ?? "no error recorded";
  return err(
    refuse(`the run ended ${t.payload.outcome} before its gate: ${why}`),
  );
}

/** Contract 5: human_ask returned and the session's state did not change; its question is open. */
async function heldAtGate(
  w: World,
  id: string,
  ticketId: string,
): Promise<Result<void>> {
  const running = await sessionIn(w, id, "running");
  if (!running.ok) return running;
  const asks = await listSessionHumanRequests(w.db, id);
  return asks.ok ? verdict(askProblems(asks.value, ticketId)) : asks;
}

/** The session on A: its MCP calls through human_ask, held at the gate, checked, then stopped. */
async function m1Session(w: World, a: TicketView): Promise<string> {
  const id = await spawnWith(w, M1.agent, m1SpawnRequest(a.id));
  const events = follow(w.h.client(w.wsUrl, w.token), id);
  const upToAsk = await w.h.step("MCP calls up to human_ask", () =>
    eventsUntil(w, events, "human_ask's mcp_call", askedOrEnded),
  );
  await w.h.step("no terminal yet: every call met its expectation", async () =>
    noTerminal(upToAsk),
  );
  await w.h.step(
    "human_ask returned at once: the session is still running, its question open",
    () => heldAtGate(w, id, a.id),
  );
  const stop = await w.h.step(
    "POST /sessions/:id/stop (ends the held run)",
    () => w.api.stop(id, "graceful", `smoke:m1:stop:${id}`),
  );
  await w.h.step("stop command done", () => commandDone(w, stop.command_id));
  await w.h.step("the run's terminal", () =>
    eventsUntil(w, events, "a terminal event", hasKind("terminal")),
  );
  return id;
}

/** B: the one ticket the session filed (its origin_ref), checked. */
async function followup(w: World, id: string): Promise<Result<TicketRow>> {
  const page = await listTickets(w.db, { limit: 100 });
  if (!page.ok) return page;
  const filed = page.value.rows.filter((t) => t.origin_ref === id);
  const checked = verdict(followupProblems(filed, M1.followupTitle));
  if (!checked.ok) return checked;
  const b = filed[0];
  return b === undefined ? err(refuse("the session filed no ticket")) : ok(b);
}

/** What the session left: its calls in the events, A's attributed history, B, the audit trail. */
async function m1Evidence(
  w: World,
  a: TicketView,
  id: string,
): Promise<TicketRow> {
  const stored = await w.h.step("GET /sessions/:id/events", () =>
    w.api.events(id),
  );
  await w.h.step(
    "mcp_call events: five calls; the update of B refused cross_ticket_write",
    async () => verdict(mcpCallProblems(stored, M1_CALLS)),
  );
  await w.h.step(
    `${a.key}'s ticket_events carry actor_id = the session`,
    async () => {
      const page = await listTicketEvents(w.db, {
        ticket_id: a.id,
        since: 0,
        limit: 100,
      });
      return page.ok ? verdict(ticketEventProblems(page.value.rows, id)) : page;
    },
  );
  const b = await w.h.step(
    "B filed by the session: a followup, needs_human=1, not retitled",
    () => followup(w, id),
  );
  await w.h.step(
    "audit_log: each write the session landed, and the refused one",
    async () => {
      const rows = await listAuditByActor(w.db, `session:${id}`);
      return rows.ok
        ? verdict(auditProblems(rows.value, m1Audit(a.id, b.id)))
        : rows;
    },
  );
  return b;
}

/** A ticket's key: `tickets.key_prefix` + num (amendment 13), the prefix read off ticket A's. */
const keyOf = (a: TicketView, num: number): string =>
  `${a.key.slice(0, a.key.length - String(a.num).length)}${num}`;

/** The M1 acceptance test, after setUp: the session's work, then both tickets exported. */
export async function m1(w: World): Promise<void> {
  const a = await seedM1(w);
  const id = await m1Session(w, a);
  const b = await m1Evidence(w, a, id);
  await exportsTwice(w, [
    { id: a.id, key: a.key },
    { id: b.id, key: keyOf(a, b.num) },
  ]);
}
