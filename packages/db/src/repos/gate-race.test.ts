import { systemClock, type ReviewFinding, type Result } from "@bayon/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openDb, type Db } from "../connection.js";
import {
  OPERATOR,
  gateDb,
  seedRows,
  setBusyTimeoutForTest,
  unwrap,
} from "../testing.js";
import { EVIDENCE, allow, gateRow, planFor, rows } from "./fixtures.js";
import { decideGate } from "./gate-decide.js";
import type { WriterHooks } from "./gate-common.js";
import type { PlanGates } from "./gate-writes.js";
import { waiveGate } from "./gate-writes.js";
import { transitionTicket } from "./ticket-transition.js";

// Two connections, genuinely interleaved (PR #45 review): the first writer is held inside its
// BEGIN IMMEDIATE right after it has read the gate's state (its afterRead hook), and the rival writer
// is started from there on a second connection. better-sqlite3 runs the rival's first attempt at
// once, so it meets the held write lock (SQLITE_BUSY: busy_timeout 0 on that connection), backs off,
// and runs only after the first commits, reading the committed state. Exactly one wins; a passed
// gate never lands over a waived or superseded one.

let t: Awaited<ReturnType<typeof gateDb>>;
let rival: Db;

beforeEach(async () => {
  t = await gateDb(["code_review"]);
  rival = unwrap(await openDb({ path: t.path, clock: systemClock }));
  unwrap(await setBusyTimeoutForTest(rival, 0));
  unwrap(
    await seedRows(t.db, { gates: [gateRow("g", { ticket_id: "ticket-1" })] }),
  );
});
afterEach(async () => {
  unwrap(await rival.close());
  t.cleanup();
});

const MAJOR: ReviewFinding = {
  severity: "major",
  summary: "the null check is gone",
  file: "src/a.ts",
  line: 3,
  category: null,
  detail_md: null,
};

const decide = (db: Db, hooks?: WriterHooks) =>
  decideGate(
    db,
    { gate_id: "g", session_id: null, evidence: EVIDENCE, findings: [] },
    hooks,
  );
const waive = (db: Db, hooks?: WriterHooks) =>
  waiveGate(
    db,
    { gate_id: "g", reason: "ship it", by: OPERATOR },
    undefined,
    hooks,
  );
/** The operator's request_fix, with a hook inside its transaction once it has read the gates. */
const requestFix = (db: Db, afterRead?: () => void) => {
  const plan = planFor("code_review", "review_fix");
  const held: PlanGates = (facts) => {
    const planned = plan(facts);
    afterRead?.();
    return planned;
  };
  return transitionTicket(
    db,
    { id: "ticket-1", version: 1, to: "review_fix", by: OPERATOR },
    allow,
    undefined,
    held,
  );
};

const stored = () =>
  (
    rows(
      t.db,
      "SELECT state, evidence_json, waive_reason FROM gates WHERE id = 'g'",
    ) as {
      state: string;
      evidence_json: string | null;
      waive_reason: string | null;
    }[]
  )[0];

/**
 * Starts `second` on the rival connection from inside `first`'s transaction, after `first` has read
 * the gate, and returns both results. The rival's busy count proves it waited on that lock.
 */
async function interleave<A, B>(
  first: (afterRead: () => void) => Promise<Result<A>>,
  second: () => Promise<Result<B>>,
): Promise<{ readonly first: Result<A>; readonly second: Result<B> }> {
  const box: { second?: Promise<Result<B>> } = {};
  const busy = rival.stats.busy;
  const firstResult = await first(() => {
    box.second = second();
  });
  if (box.second === undefined) {
    throw new Error("the first writer never reached its hook");
  }
  const secondResult = await box.second;
  expect(rival.stats.busy).toBeGreaterThan(busy);
  return { first: firstResult, second: secondResult };
}

describe("waive and decide on two connections", () => {
  test("a decision held after reading 'running' blocks a waive, which then sees 'passed' and conflicts", async () => {
    const r = await interleave(
      (afterRead) => decide(t.db, { afterRead }),
      () => waive(rival),
    );
    expect(r.first).toMatchObject({
      ok: true,
      value: { gate: { state: "passed" } },
    });
    expect(r.second).toMatchObject({
      ok: false,
      error: { class: "conflict", cause: { state: "passed" } },
    });
    expect(stored()).toMatchObject({ state: "passed", waive_reason: null });
  });

  test("a waive held after its compare-and-set blocks a decision, which then sees 'waived': no pass over a waive", async () => {
    const r = await interleave(
      (afterRead) => waive(t.db, { afterRead }),
      () =>
        decideGate(rival, {
          gate_id: "g",
          session_id: null,
          evidence: EVIDENCE,
          findings: [MAJOR],
        }),
    );
    expect(r.first).toMatchObject({ ok: true, value: { state: "waived" } });
    expect(r.second).toMatchObject({
      ok: false,
      error: { class: "conflict", cause: { state: "waived" } },
    });
    expect(stored()).toEqual({
      state: "waived",
      evidence_json: null,
      waive_reason: "ship it",
    });
    expect(rows(t.db, "SELECT id FROM findings")).toEqual([]);
  });
});

describe("supersede and decide on two connections", () => {
  test("the operator's request_fix, held after reading the gates, blocks a decision, which then sees 'failed'", async () => {
    const r = await interleave(
      (afterRead) => requestFix(t.db, afterRead),
      () => decide(rival),
    );
    expect(r.first).toMatchObject({
      ok: true,
      value: { status: "review_fix" },
    });
    expect(r.second).toMatchObject({
      ok: false,
      error: { class: "conflict", cause: { state: "failed" } },
    });
    expect(stored()).toMatchObject({
      state: "failed",
      evidence_json: '{"reason":"superseded"}',
    });
  });

  // the passing decision takes pass_review in its own transaction, so the operator's
  // request_fix, at the version it read before, meets the compare-and-set and gets the 409.
  test("a decision held after reading 'running' blocks the operator's request_fix: the round passed and moved first, so the operator's move is a version conflict", async () => {
    const r = await interleave(
      (afterRead) => decide(t.db, { afterRead }),
      () => requestFix(rival),
    );
    expect(r.first).toMatchObject({
      ok: true,
      value: {
        gate: { state: "passed" },
        advance: { advanced: true, rule: "pass_review", to: "qa_harness" },
      },
    });
    expect(r.second).toMatchObject({
      ok: false,
      error: { class: "conflict", cause: { current_version: 2 } },
    });
    expect(stored()).toMatchObject({ state: "passed" });
    expect(
      rows(t.db, "SELECT status, version FROM tickets WHERE id = 'ticket-1'"),
    ).toEqual([{ status: "qa_harness", version: 2 }]);
    const steps = (
      rows(
        t.db,
        "SELECT payload_json FROM ticket_events WHERE kind = 'gate' ORDER BY id",
      ) as { payload_json: string }[]
    ).map((e) => (JSON.parse(e.payload_json) as { step: string }).step);
    expect(steps).toEqual(["decide"]);
  });
});
