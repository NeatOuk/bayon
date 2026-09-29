import { FakeClock } from "@bayon/core";
import { afterAll, expect, onTestFinished, test } from "vitest";
import * as api from "../api.js";
import { tempDb, unwrap } from "../testing.js";
import {
  claimCommand,
  completeCommand,
  getCommand,
  getCommandByIdempotencyKey,
  getCommandQueued,
  insertCommand,
} from "./commands.js";

const T0 = 1_700_000_000_000;
const clock = new FakeClock(T0);
const t = unwrap(await tempDb(clock));
afterAll(() => t.cleanup());

const spawn = {
  session_id: "s-1",
  agent_id: "a-1",
  role: "builder",
  run_class: "build",
};

test("insertCommand stores a pending command", async () => {
  const { id, created } = unwrap(
    await insertCommand(t.db, { type: "session.spawn", payload: spawn }),
  );
  expect(created).toBe(true);
  expect(unwrap(await getCommand(t.db, id))).toMatchObject({
    type: "session.spawn",
    state: "pending",
    ts: clock.now(),
    attempts: 0,
    claimed_at: null,
    payload_json:
      '{"agent_id":"a-1","role":"builder","run_class":"build","session_id":"s-1"}',
  });
});

test("the same idempotency key and command returns the first id", async () => {
  const input = {
    type: "session.spawn",
    payload: spawn,
    idempotencyKey: "key-1",
  };
  const first = unwrap(await insertCommand(t.db, input));
  // Key order does not matter: payloads are compared as canonical JSON.
  const reordered = Object.fromEntries(Object.entries(spawn).toReversed());
  const again = unwrap(
    await insertCommand(t.db, { ...input, payload: reordered }),
  );
  expect(again).toEqual({ id: first.id, created: false });
});

test("the same idempotency key with another type or payload is a conflict", async () => {
  const input = {
    type: "session.spawn",
    payload: spawn,
    idempotencyKey: "key-2",
  };
  unwrap(await insertCommand(t.db, input));
  const conflict = { ok: false, error: { class: "conflict" } };
  expect(
    await insertCommand(t.db, { ...input, type: "session.stop" }),
  ).toMatchObject(conflict);
  expect(
    await insertCommand(t.db, {
      ...input,
      payload: { ...spawn, role: "reviewer" },
    }),
  ).toMatchObject(conflict);
});

test.each([
  ["undefined", undefined],
  ["a function", () => 1],
  ["a bigint", { n: 1n }],
  ["NaN", { n: Number.NaN }],
])(
  "a payload that is not JSON (%s) is a validation error",
  async (_, payload) => {
    expect(await insertCommand(t.db, { type: "x", payload })).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
  },
);

test("an empty type is a validation error", async () => {
  expect(await insertCommand(t.db, { type: "", payload: {} })).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
});

test("claimCommand takes the oldest pending command first, then none", async () => {
  const q = unwrap(await tempDb(clock));
  onTestFinished(() => q.cleanup());
  await clock.advance(1);
  const a = unwrap(await insertCommand(q.db, { type: "a", payload: {} }));
  await clock.advance(1);
  const b = unwrap(await insertCommand(q.db, { type: "b", payload: {} }));
  await clock.advance(1);
  const first = unwrap(await claimCommand(q.db));
  expect(first).toMatchObject({
    id: a.id,
    state: "claimed",
    attempts: 1,
    claimed_at: clock.now(),
  });
  expect(unwrap(await claimCommand(q.db))?.id).toBe(b.id);
  expect(unwrap(await claimCommand(q.db))).toBeNull();
});

test("claimCommand with types takes only those, leaving the rest pending; none claims nothing", async () => {
  const q = unwrap(await tempDb(clock));
  onTestFinished(() => q.cleanup());
  await clock.advance(1);
  const held = unwrap(await insertCommand(q.db, { type: "x", payload: {} }));
  await clock.advance(1);
  const b = unwrap(await insertCommand(q.db, { type: "b", payload: {} }));
  expect(unwrap(await claimCommand(q.db, { types: [] }))).toBeNull();
  expect(unwrap(await claimCommand(q.db, { types: ["b"] }))?.id).toBe(b.id);
  expect(unwrap(await claimCommand(q.db, { types: ["b"] }))).toBeNull();
  expect(unwrap(await getCommand(q.db, held.id)).state).toBe("pending");
  expect(unwrap(await claimCommand(q.db))?.id).toBe(held.id);
});

test("completeCommand is a CAS from claimed", async () => {
  const q = unwrap(await tempDb(clock));
  onTestFinished(() => q.cleanup());
  const done = unwrap(await insertCommand(q.db, { type: "a", payload: {} }));
  const failed = unwrap(await insertCommand(q.db, { type: "b", payload: {} }));

  expect(
    await completeCommand(q.db, done.id, { state: "done", result: { ok: 1 } }),
  ).toMatchObject({ ok: false, error: { class: "conflict" } }); // still pending
  unwrap(await claimCommand(q.db));
  unwrap(await claimCommand(q.db));

  expect(
    unwrap(
      await completeCommand(q.db, done.id, {
        state: "done",
        result: { ok: 1 },
      }),
    ),
  ).toMatchObject({ state: "done", result_json: '{"ok":1}', error: null });
  expect(await completeCommand(q.db, done.id, { state: "done" })).toMatchObject(
    { ok: false, error: { class: "conflict" } },
  );

  const error = {
    class: "spawn_failed" as const,
    message: "no slot",
    retryable: true,
    cause: { slots: 0 },
  };
  const failedRow = unwrap(
    await completeCommand(q.db, failed.id, { state: "failed", error }),
  );
  expect(failedRow.state).toBe("failed");
  expect(JSON.parse(failedRow.error ?? "null")).toEqual(error);

  expect(
    await completeCommand(q.db, "no-such-command", { state: "done" }),
  ).toMatchObject({ ok: false, error: { class: "not_found" } });
});

test("a failure whose cause is not JSON is stored without the cause", async () => {
  const q = unwrap(await tempDb(clock));
  onTestFinished(() => q.cleanup());
  const { id } = unwrap(await insertCommand(q.db, { type: "a", payload: {} }));
  unwrap(await claimCommand(q.db));
  const row = unwrap(
    await completeCommand(q.db, id, {
      state: "failed",
      error: {
        class: "internal",
        message: "boom",
        retryable: false,
        cause: 10n,
      },
    }),
  );
  expect(JSON.parse(row.error ?? "null")).toEqual({
    class: "internal",
    message: "boom",
    retryable: false,
  });
});

test("a result that is not JSON is a validation error", async () => {
  expect(
    await completeCommand(t.db, "any", { state: "done", result: 1n }),
  ).toMatchObject({ ok: false, error: { class: "validation" } });
});

test("getCommand of an unknown id is not_found", async () => {
  expect(await getCommand(t.db, "no-such-command")).toMatchObject({
    ok: false,
    error: { class: "not_found" },
  });
});

test("getCommandByIdempotencyKey finds the command a key created", async () => {
  // A repeated POST /sessions mints a fresh session_id, so insertCommand would call it a
  // conflict; the API looks the key up first and returns this command instead.
  const { id } = unwrap(
    await insertCommand(t.db, {
      type: "session.spawn",
      payload: spawn,
      idempotencyKey: "lookup-1",
    }),
  );
  const found = unwrap(await getCommandByIdempotencyKey(t.db, "lookup-1"));
  expect(found).toEqual(unwrap(await getCommand(t.db, id)));
  expect(found).toMatchObject({ id, idempotency_key: "lookup-1" });
});

test("getCommandByIdempotencyKey of an unused key is null", async () => {
  expect(
    unwrap(await getCommandByIdempotencyKey(t.db, "never-used")),
  ).toBeNull();
});

test("getCommandByIdempotencyKey of an empty key is a validation error", async () => {
  expect(await getCommandByIdempotencyKey(t.db, "")).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
});

// getCommandQueued: a conformance run is minutes long and the supervisor runs them one
// at a time, so GET /commands/:id has to say what is queued ahead of one, and against which clock.
/** One command per `payload`, each a second after the last, as the API's would be. */
async function queue(
  type: string,
  payloads: readonly unknown[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const payload of payloads) {
    ids.push(unwrap(await insertCommand(t.db, { type, payload })).id);
    await clock.advance(1_000);
  }
  return ids;
}

const idsAhead = async (id: string): Promise<string[]> =>
  unwrap(await getCommandQueued(t.db, id)).ahead.map((row) => row.id);

test("getCommandQueued reports the clock the row was read against", async () => {
  const { id } = unwrap(
    await insertCommand(t.db, { type: "test.elapsed", payload: {} }),
  );
  await clock.advance(90_000);
  const queued = unwrap(await getCommandQueued(t.db, id));
  expect(queued.row.id).toBe(id);
  expect(queued.now).toBe(clock.now());
  expect(queued.now - queued.row.ts).toBe(90_000);
});

test("getCommandQueued lists the unsettled commands of its type queued before it, oldest first", async () => {
  const lane = "test.lane";
  const [first, second, third] = await queue(lane, [
    { n: 1 },
    { n: 2 },
    { n: 3 },
  ]);
  if (first === undefined || second === undefined || third === undefined)
    throw new Error("no commands");
  expect(await idsAhead(first)).toEqual([]);
  expect(await idsAhead(third)).toEqual([first, second]);
  // Claimed is still in the lane — it is the run holding it. Only a settled command leaves.
  expect(unwrap(await claimCommand(t.db, { types: [lane] }))?.id).toBe(first);
  expect(await idsAhead(third)).toEqual([first, second]);
  unwrap(await completeCommand(t.db, first, { state: "done" }));
  expect(await idsAhead(third)).toEqual([second]);
});

test("commands minted in one millisecond are ahead in the order the claimer takes them", async () => {
  // The clock above advances a second between inserts, which hides the case the real clock
  // produces: the API mints several commands in the same millisecond, and ids are ULIDs from a
  // stateless mint (core id.ts), so id order is not insertion order. `ahead` promises the
  // claimer's order — (ts, id) — so it must agree with claimCommand row for row.
  const lane = "test.same-ms";
  const ids: string[] = [];
  for (const n of [1, 2, 3, 4]) {
    ids.push(
      unwrap(await insertCommand(t.db, { type: lane, payload: { n } })).id,
    );
  }
  const rows = unwrap(await getCommandQueued(t.db, ids[0] ?? ""));
  expect(new Set(ids).size).toBe(4);
  expect(rows.row.ts).toBe(clock.now()); // one millisecond holds all four
  const ahead = new Map<string, string[]>();
  for (const id of ids) ahead.set(id, await idsAhead(id));
  const claimed: string[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    const row = unwrap(await claimCommand(t.db, { types: [lane] }));
    if (row === null) throw new Error("the lane emptied early");
    claimed.push(row.id);
    unwrap(await completeCommand(t.db, row.id, { state: "done" }));
  }
  expect(claimed.toSorted()).toEqual(ids.toSorted());
  // What was ahead of each is exactly what the claimer took before it — for every one of them.
  for (const [i, id] of claimed.entries()) {
    expect(ahead.get(id)).toEqual(claimed.slice(0, i));
  }
});

test("a settled command is in no queue, and another type queues separately", async () => {
  const mine = "test.mine";
  const [older, newer] = await queue(mine, [{ n: 1 }, { n: 2 }]);
  if (older === undefined || newer === undefined)
    throw new Error("no commands");
  // Inserted last of all, so every command above is older — and none of them is its type.
  const other = unwrap(
    await insertCommand(t.db, { type: "test.other", payload: {} }),
  ).id;
  expect(await idsAhead(other)).toEqual([]);
  expect(await idsAhead(newer)).toEqual([older]);
  // Settled: it is out of its lane whatever is still queued in it.
  unwrap(await claimCommand(t.db, { types: [mine] }));
  unwrap(await completeCommand(t.db, older, { state: "done" }));
  unwrap(await claimCommand(t.db, { types: [mine] }));
  unwrap(await completeCommand(t.db, newer, { state: "done" }));
  expect(await idsAhead(newer)).toEqual([]);
});

test("getCommandQueued of an unknown id is not_found", async () => {
  expect(await getCommandQueued(t.db, "no-such-command")).toMatchObject({
    ok: false,
    error: { class: "not_found" },
  });
});

test("@bayon/db/api exports the API's writers, its command reads, and the fleet overview", () => {
  expect(Object.keys(api).toSorted()).toEqual([
    "DAILY_CAP_KEY",
    "ERRORED_WITHIN_MS",
    "LOCAL_ROOTS_VIA_GUI",
    "NOTIFY_CONFIG_ACTION",
    "PHASE_CHANGE",
    "STALE_AFTER_MS",
    "acceptHandoff",
    "ackAttention",
    "addLocalRoot",
    "answerHumanRequest",
    "answerStaffProposal",
    "appendAudit",
    "appendKnowledge",
    "appendTicketEvent",
    "askHumanRequests",
    "claimDelivery",
    "claimJiraPush",
    "createExecutor",
    "createProject",
    "createProjectAgent",
    "createTicket",
    "deactivateOperatorModel",
    "deferDelivery",
    "deleteBudget",
    "dismissHumanRequest",
    "dismissRunnerUpdate",
    "fileJiraPushes",
    "getBudgetCap",
    "getCommand",
    "getCommandByIdempotencyKey",
    "getCommandQueued",
    "getFleetOverview",
    "insertCommand",
    "insertHumanRequest",
    "insertHumanRequests",
    "insertMissionVersion",
    "insertNotifications",
    "linkTicket",
    "markMessagesRead",
    "mirrorJiraPage",
    "parkDepartedJira",
    "phaseHandoffKey",
    "putBudget",
    "putNotifyConfig",
    "putOperatorModel",
    "putOperatorSettings",
    "putRoleBinding",
    "rerunGate",
    "resolveFinding",
    "sendMessage",
    "setAgentFromApi",
    "setBudgetCap",
    "setFleetPaused",
    "setProjectPaused",
    "setProjectSettings",
    "setPulsePolicy",
    "settleDelivery",
    "settleJiraPush",
    "staffTicket",
    "transitionTicket",
    "updateTicketCas",
    "waiveFinding",
    "waiveGate",
    "writeHandoffJudgement",
  ]);
});
