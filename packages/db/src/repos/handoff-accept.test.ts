import { FakeClock } from "@bayon/core";
import { afterAll, describe, expect, test } from "vitest";
import type { Db } from "../connection.js";
import {
  listAudit,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "../testing.js";
import { acceptHandoff } from "./handoff-accept.js";
import {
  HANDOFF_ACCEPT_COLUMNS,
  getHandoff,
  listHandoffs,
  type HandoffQuery,
} from "./handoffs.js";
import { listTicketEvents } from "./ticket-events.js";
import { getTicket } from "./tickets.js";

// handoff_accept's writer: the accept columns and the ticket's owner in one transaction,
// idempotent per session, never on a row being written or taken; the claim-if-unowned case.
const T0 = 1_700_000_000_000;
const clock = new FakeClock(T0);
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.forEach((cleanup) => cleanup()));
const HASH = "0".repeat(64);

interface SessionSeed {
  readonly state?: "running" | "handed_off";
  readonly ticket?: string | null;
  readonly role?: string;
  readonly handoff_in_id?: string;
}
const session = (id: string, o: SessionSeed = {}) => ({
  ...newSessionInput(),
  id,
  role: o.role ?? "builder",
  state: o.state ?? "running",
  ticket_id: o.ticket === undefined ? "ticket-1" : o.ticket,
  handoff_in_id: o.handoff_in_id ?? null,
  created_at: 0,
});

const handoff = (
  id: string,
  o: {
    readonly ticket?: string;
    readonly from?: string;
    readonly quality?: string;
    readonly created_at?: number;
    /** The ticket's hand-off number: the packet label `handoff-<n>`. */
    readonly n?: number;
  } = {},
) => ({
  id,
  ticket_id: o.ticket ?? "ticket-1",
  from_session_id: o.from ?? "S1",
  reason: "turn_ceiling",
  facts_json: "{}",
  packet_path: `.foreman/handoff-${o.n ?? 1}.md`,
  packet_hash: HASH,
  quality: o.quality ?? "full",
  created_at: o.created_at ?? 1,
});

/**
 * ticket-1: S1 handed off (H1, full) to its successor S2; S3 also works it and has a writing row
 * H2. ticket-2: S4 and its degraded H9. ticket-3: staffed, S5 its first session, R1 a reviewer.
 */
async function world(): Promise<Db> {
  const t = unwrap(await tempDb(clock));
  cleanups.push(t.cleanup);
  unwrap(await seedSpine(t.db, 5));
  unwrap(
    await seedRows(t.db, {
      tickets: [
        ticketRow(1, { status: "building" }),
        ticketRow(2, { status: "building" }),
        ticketRow(3, { status: "staffed" }),
      ],
      sessions: [
        session("S1", { state: "handed_off" }),
        session("S2", { handoff_in_id: "H1" }),
        session("S3"),
        session("S4", { ticket: "ticket-2" }),
        session("S5", { ticket: "ticket-3" }),
        session("R1", { ticket: "ticket-3", role: "reviewer" }),
      ],
      handoffs: [
        handoff("H1"),
        handoff("H2", { from: "S3", quality: "writing", created_at: 2, n: 2 }),
        handoff("H9", {
          ticket: "ticket-2",
          from: "S4",
          quality: "degraded",
          created_at: 3,
        }),
      ],
    }),
  );
  return t.db;
}

const accept = (db: Db, session_id: string, handoff_id?: string) =>
  acceptHandoff(db, {
    session_id,
    ...(handoff_id === undefined ? {} : { handoff_id }),
  });

const events = async (db: Db, ticket = "ticket-1") =>
  unwrap(
    await listTicketEvents(db, { ticket_id: ticket, since: 0, limit: 100 }),
  )
    .rows.filter((e) => e.kind === "handoff")
    .map((e) => ({
      actor: `${e.actor_kind}:${e.actor_id ?? ""}`,
      payload: JSON.parse(e.payload_json ?? "{}") as unknown,
    }));

const owner = async (db: Db, id = "ticket-1") =>
  unwrap(await getTicket(db, id)).owner_session_id;

describe("accept", () => {
  test("the successor takes its pending row: the accept columns and the owner move together, the status never", async () => {
    const db = await world();
    const before = unwrap(await getTicket(db, "ticket-1"));
    const row = unwrap(await getHandoff(db, "H1"));
    expect(unwrap(await accept(db, "S2"))).toMatchObject({
      kind: "accepted",
      ticket_id: "ticket-1",
      created: true,
      handoff: { id: "H1", to_session_id: "S2", accepted_at: T0 },
    });
    expect(unwrap(await getTicket(db, "ticket-1"))).toMatchObject({
      owner_session_id: "S2",
      status: before.status,
      version: before.version,
    });
    const taken = unwrap(await getHandoff(db, "H1"));
    const changed = (Object.keys(taken) as (keyof typeof taken)[]).filter(
      (k) => taken[k] !== row[k],
    );
    expect(changed.toSorted()).toEqual([...HANDOFF_ACCEPT_COLUMNS].toSorted());
    expect(await events(db)).toEqual([
      {
        actor: "session:S2",
        payload: { handoff_id: "H1", step: "accept", from_session_id: "S1" },
      },
    ]);
  });

  test("accepting again is idempotent: the same result, nothing written, no second event", async () => {
    const db = await world();
    const first = unwrap(await accept(db, "S2"));
    expect(unwrap(await accept(db, "S2", "H1"))).toEqual({
      ...first,
      created: false,
    });
    expect(await events(db)).toHaveLength(1);
  });

  test("refused, nothing written: another session's accept, a row being written, another ticket's row, an unknown id", async () => {
    const db = await world();
    unwrap(await accept(db, "S2"));
    expect(unwrap(await accept(db, "S3", "H1"))).toMatchObject({
      kind: "refused",
      reason: "not_pending",
      detail: "hand-off H1 was accepted by session S2",
    });
    expect(unwrap(await accept(db, "S3", "H2"))).toMatchObject({
      kind: "refused",
      reason: "not_pending",
      detail: "hand-off H2 is still being written",
    });
    expect(unwrap(await accept(db, "S4", "H1"))).toMatchObject({
      kind: "refused",
      reason: "cross_ticket_write",
    });
    expect(unwrap(await accept(db, "S3", "nope"))).toMatchObject({
      kind: "refused",
      reason: "not_found",
    });
    expect(unwrap(await getHandoff(db, "H2"))).toMatchObject({
      accepted_at: null,
      to_session_id: null,
    });
    expect(await owner(db)).toBe("S2");
    expect(await events(db)).toHaveLength(1);
  });

  test("a packet label (handoff-<n>) names a row on the caller's own ticket only", async () => {
    const db = await world();
    // ticket-2's only hand-off is its handoff-1 (H9); handoff-2 is ticket-1's H2, never S4's.
    expect(unwrap(await accept(db, "S4", "handoff-2"))).toMatchObject({
      kind: "refused",
      reason: "not_found",
      detail: expect.stringContaining("no hand-off handoff-2 on your ticket"),
    });
    // On ticket-1 the label finds H2, which is still being written.
    expect(unwrap(await accept(db, "S3", "handoff-2"))).toMatchObject({
      kind: "refused",
      reason: "not_pending",
      detail: "hand-off H2 is still being written",
    });
    const taken = unwrap(await accept(db, "S2", "handoff-1"));
    expect(taken).toMatchObject({
      kind: "accepted",
      ticket_id: "ticket-1",
      handoff: { id: "H1", to_session_id: "S2" },
      created: true,
    });
    // The label, the id and no id are one hand-off: each repeat writes nothing.
    for (const ref of ["handoff-1", "H1", undefined]) {
      expect(unwrap(await accept(db, "S2", ref))).toEqual({
        ...taken,
        created: false,
      });
    }
    expect(await owner(db)).toBe("S2");
    expect(await events(db)).toHaveLength(1);
    expect(await events(db, "ticket-2")).toHaveLength(0);
  });

  test("an unknown session is an error, not a refusal", async () => {
    const db = await world();
    expect(await accept(db, "nobody")).toMatchObject({
      ok: false,
      error: { class: "not_found" },
    });
  });

  test("the caller's audit entry commits with an accept, never with a refusal", async () => {
    const db = await world();
    const audit = {
      actor: "session:S2",
      action: "mcp.handoff_accept",
      target_kind: "ticket",
      target_id: "ticket-1",
      payload: { outcome: "ok" },
    };
    unwrap(
      await acceptHandoff(db, { session_id: "S4", handoff_id: "H1" }, audit),
    );
    unwrap(await acceptHandoff(db, { session_id: "S2" }, audit));
    expect(unwrap(await listAudit(db)).map((a) => a.action)).toEqual([
      "mcp.handoff_accept",
    ]);
  });
});

describe("claim-if-unowned (no id, no handoff_in_id)", () => {
  test("a first session owns its unowned staffed ticket; again is a repeat; nothing else of the ticket moves", async () => {
    const db = await world();
    const before = unwrap(await getTicket(db, "ticket-3"));
    const claimed = {
      kind: "accepted",
      ticket_id: "ticket-3",
      handoff: null,
      created: true,
    };
    expect(unwrap(await accept(db, "S5"))).toEqual(claimed);
    expect(unwrap(await getTicket(db, "ticket-3"))).toMatchObject({
      owner_session_id: "S5",
      status: "staffed",
      version: before.version,
    });
    expect(unwrap(await accept(db, "S5"))).toEqual({
      ...claimed,
      created: false,
    });
    expect(await events(db, "ticket-3")).toEqual([
      { actor: "session:S5", payload: { handoff_id: null, step: "claim" } },
    ]);
  });

  test("refused: a reviewer, a ticket with a pending hand-off, a ticket another session owns", async () => {
    const db = await world();
    expect(unwrap(await accept(db, "R1"))).toMatchObject({
      kind: "refused",
      reason: "actor_not_allowed",
    });
    // ticket-1 has H1 pending: S3 must accept it, not claim past it.
    expect(unwrap(await accept(db, "S3"))).toMatchObject({
      kind: "refused",
      reason: "not_claimable",
      detail: "ticket ticket-1 has a pending hand-off: accept H1",
    });
    unwrap(await accept(db, "S2"));
    expect(unwrap(await accept(db, "S3"))).toMatchObject({
      kind: "refused",
      reason: "not_claimable",
      detail: "ticket ticket-1 is owned by session S2",
    });
    expect(await owner(db, "ticket-3")).toBeNull();
  });
});

describe("listHandoffs", () => {
  test("oldest first: a ticket's chain, the pending queue (never a writing or accepted row), a limit", async () => {
    const db = await world();
    const ids = async (q: HandoffQuery) =>
      unwrap(await listHandoffs(db, q)).rows.map((r) => r.id);
    expect(await ids({ limit: 10 })).toEqual(["H1", "H2", "H9"]);
    expect(await ids({ ticketId: "ticket-1", limit: 10 })).toEqual([
      "H1",
      "H2",
    ]);
    expect(await ids({ pending: true, limit: 10 })).toEqual(["H1", "H9"]);
    unwrap(await accept(db, "S2"));
    expect(
      await ids({ ticketId: "ticket-1", pending: true, limit: 10 }),
    ).toEqual([]);
    expect(unwrap(await listHandoffs(db, { limit: 2 }))).toMatchObject({
      hasMore: true,
    });
    expect(unwrap(await listHandoffs(db, { limit: 3 }))).toMatchObject({
      hasMore: false,
    });
  });
});
