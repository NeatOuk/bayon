// pinFate on a real temp database: which pin refs in an executor's mirror may
// go. A gate's goes once the gate is decided and every session of it has ended; a session's once it
// has exited for good; anything with no row here is kept (another supervisor may share the host).
import { FakeClock } from "@bayon/core";
import type { GateRow, SessionRow } from "@bayon/db";
import {
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Ctx } from "./context.js";
import { pinFate } from "./mirror-pins.js";

const T0 = Date.UTC(2026, 8, 14, 12);
let t: TempDb;

const gate = (id: string, kind: GateRow["kind"], state: GateRow["state"]) => ({
  id,
  ticket_id: "ticket-1",
  kind,
  state,
  attempt: 1,
  subject_kind: "diff",
  subject_ref: "x",
  started_at: T0,
});
const session = (
  id: string,
  state: SessionRow["state"],
  gate_id: string | null = null,
) => ({
  ...newSessionInput(),
  id,
  state,
  gate_id,
  created_at: T0,
});

beforeAll(async () => {
  t = unwrap(await tempDb(new FakeClock(T0)));
  unwrap(await seedSpine(t.db, 1));
  // Gates before the sessions that name them (sessions.gate_id): two seeds, parents first.
  unwrap(
    await seedRows(t.db, {
      tickets: [ticketRow(1)],
      gates: [
        gate("g-done", "code_review", "passed"),
        gate("g-busy", "plan_review", "failed"),
        gate("g-live", "ce_review", "waived"),
        gate("g-running", "qa_harness", "running"),
        gate("g-paused", "parity_check", "passed"),
      ],
    }),
  );
  unwrap(
    await seedRows(t.db, {
      sessions: [
        session("R-done", "exited", "g-done"),
        session("R-busy", "running", "g-busy"),
        session("R-live", "exited", "g-live"),
        session("R-paused", "awaiting_approval", "g-paused"),
        session("P-exited", "exited"),
        session("P-resumable", "resumable"),
        session("P-idle", "idle"),
      ],
    }),
  );
});
afterAll(() => t.cleanup());

/** pinFate reads the database and the live map only. */
const ctx = (live: readonly string[] = []): Ctx =>
  ({
    db: t.db,
    live: new Map(live.map((id) => [id, {}])),
  }) as unknown as Ctx;

describe("pinFate", () => {
  test.each([
    ["refs/frm/gate/g-done", "drop", "decided, its reviewer exited"],
    ["refs/frm/gate/g-busy", "keep", "decided, its reviewer still running"],
    ["refs/frm/gate/g-running", "keep", "still running"],
    [
      "refs/frm/gate/g-paused",
      "keep",
      "decided, its session paused for a human",
    ],
    ["refs/frm/gate/g-nobody", "keep", "no row here: another supervisor's"],
    ["refs/frm/pin/P-exited", "drop", "its session exited for good"],
    ["refs/frm/pin/P-resumable", "keep", "resumable: its clone may need it"],
    ["refs/frm/pin/P-idle", "keep", "a session with a process"],
    ["refs/frm/pin/P-nobody", "keep", "no row here"],
    ["refs/heads/main", "keep", "not a pin ref"],
    ["refs/frm/gate/../heads/main", "keep", "not a pin ref"],
    ["refs/frm/other/g-done", "keep", "not a pin ref"],
  ] as const)("%s: %s (%s)", async (ref, fate, why) => {
    expect(await pinFate(ctx(), ref), why).toBe(fate);
  });

  test("a live session keeps its gate's ref and its own, whatever its row says", async () => {
    expect(await pinFate(ctx(), "refs/frm/gate/g-live")).toBe("drop");
    expect(await pinFate(ctx(["R-live"]), "refs/frm/gate/g-live")).toBe("keep");
    expect(await pinFate(ctx(["P-exited"]), "refs/frm/pin/P-exited")).toBe(
      "keep",
    );
  });
});
