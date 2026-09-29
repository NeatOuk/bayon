import { FakeClock, type ErrorClass } from "@bayon/core";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  SPINE_SEED,
  newRunInput,
  modelRow,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
} from "../testing.js";
import {
  countAdmittedSessions,
  countLiveSessionsOfRunner,
  listPairFailuresSince,
} from "./admission.js";
import {
  decertifyPairs,
  getLiveCertification,
  listRunnerEligibility,
  storeCertification,
} from "./certifications.js";
import { getFleetOverview } from "./fleet-overview.js";
import { upsertExecutor, upsertRegistration } from "./registration.js";
import { appendRun, finishRun } from "./runs.js";
import { createSession, updateSessionState } from "./sessions.js";

const T0 = 1_700_000_000_000;
const t = unwrap(await tempDb(new FakeClock(T0)));
afterAll(() => t.cleanup());

const { agentId, runnerId, executorId, sessionId } = SPINE_SEED;

beforeAll(async () => {
  unwrap(await seedSpine(t.db, 12));
  unwrap(await seedRows(t.db, { models: [modelRow(runnerId, "cheap")] }));
  unwrap(
    await upsertRegistration(t.db, {
      runner: { id: "r2", kind: "script", adapter: "r2", caps_json: "{}" },
      models: [],
    }),
  );
  unwrap(
    await upsertExecutor(t.db, {
      id: "ctr",
      kind: "container",
      config_json: "{}",
    }),
  );
});

const session = (
  id: string,
  o: Partial<ReturnType<typeof newSessionInput>> = {},
) => createSession(t.db, { ...newSessionInput(), id, ...o });

const failedRun = async (sid: string, errorClass: ErrorClass) => {
  const run = unwrap(await appendRun(t.db, newRunInput(sid)));
  unwrap(
    await finishRun(t.db, run.id, {
      state: "failed",
      error_class: errorClass,
      error_message: "x",
    }),
  );
};

test("countAdmittedSessions counts preparing through handoff_writing, never pending or ended", async () => {
  // The spine's session is idle.
  expect(unwrap(await countAdmittedSessions(t.db, agentId))).toBe(1);
  unwrap(await session("adm-pending"));
  expect(unwrap(await countAdmittedSessions(t.db, agentId))).toBe(1);
  unwrap(await session("adm-preparing"));
  unwrap(
    await updateSessionState(t.db, "adm-preparing", {
      from: ["pending"],
      to: "preparing",
    }),
  );
  expect(unwrap(await countAdmittedSessions(t.db, agentId))).toBe(2);
  unwrap(
    await updateSessionState(t.db, "adm-preparing", {
      from: ["preparing"],
      to: "exited",
    }),
  );
  expect(unwrap(await countAdmittedSessions(t.db, agentId))).toBe(1);
  expect(unwrap(await countAdmittedSessions(t.db, "someone-else"))).toBe(0);
});

test("countLiveSessionsOfRunner counts one runner's live sessions, whatever agent or executor", async () => {
  // The runner's credential is what one-session-at-a-time protects, so nothing else narrows it.
  expect(unwrap(await countLiveSessionsOfRunner(t.db, runnerId))).toBe(1);
  unwrap(await session("run-pending"));
  expect(unwrap(await countLiveSessionsOfRunner(t.db, runnerId))).toBe(1);
  unwrap(await session("run-other-executor", { executor_id: "ctr" }));
  unwrap(
    await updateSessionState(t.db, "run-other-executor", {
      from: ["pending"],
      to: "running",
    }),
  );
  expect(unwrap(await countLiveSessionsOfRunner(t.db, runnerId))).toBe(2);
  expect(unwrap(await countLiveSessionsOfRunner(t.db, "r2"))).toBe(0);
  unwrap(
    await updateSessionState(t.db, "run-other-executor", {
      from: ["running"],
      to: "exited",
    }),
  );
  expect(unwrap(await countLiveSessionsOfRunner(t.db, runnerId))).toBe(1);
});

test("listPairFailuresSince: this pair's failed runner_error runs only, from `since` on", async () => {
  unwrap(await session("fail-other-runner", { runner_id: "r2" }));
  unwrap(await session("fail-other-executor", { executor_id: "ctr" }));
  await failedRun(sessionId, "runner_error");
  await failedRun(sessionId, "timeout");
  await failedRun("fail-other-runner", "runner_error");
  await failedRun("fail-other-executor", "runner_error");
  const pair = { runnerId, executorId };
  expect(
    unwrap(await listPairFailuresSince(t.db, { ...pair, since: T0 })),
  ).toEqual([T0]);
  expect(
    unwrap(await listPairFailuresSince(t.db, { ...pair, since: T0 + 1 })),
  ).toEqual([]);
  expect(
    unwrap(
      await listPairFailuresSince(t.db, {
        runnerId: "r2",
        executorId,
        since: T0,
      }),
    ),
  ).toEqual([T0]);
});

const MODEL = `${runnerId}.cheap`;

const cert = (passedAt: number | null) => ({
  runner_id: runnerId,
  executor_id: executorId,
  model_id: MODEL,
  model: `${runnerId}-cheap-model`,
  runner_version: "1",
  suite_version: "1",
  kit_hash: "sha256:k",
  caps_hash: "sha256:c",
  result_json: "{}",
  report_path: null,
  gate_eligible: passedAt !== null,
  passed_at: passedAt,
});

const eligibility = async () =>
  unwrap(await listRunnerEligibility(t.db, executorId, [MODEL])).find(
    (r) => r.id === runnerId,
  );

test("LIVE_PAIR: admission and reviewer selection read one predicate", async () => {
  expect(
    unwrap(
      await getLiveCertification(t.db, runnerId, executorId, MODEL, false),
    ),
  ).toBeNull();
  unwrap(await storeCertification(t.db, cert(null)));
  expect(
    unwrap(
      await getLiveCertification(t.db, runnerId, executorId, MODEL, false),
    ),
  ).toBeNull();
  expect(await eligibility()).toMatchObject({ conformance_passed_at: null });

  unwrap(await storeCertification(t.db, cert(5)));
  expect(
    unwrap(
      await getLiveCertification(t.db, runnerId, executorId, MODEL, false),
    ),
  ).toMatchObject({ passed_at: 5 });
  expect(await eligibility()).toMatchObject({
    gate_eligible: 1,
    conformance_passed_at: 5,
  });
  expect(
    unwrap(await getLiveCertification(t.db, runnerId, "ctr", MODEL, false)),
  ).toBeNull();

  unwrap(
    await decertifyPairs(t.db, [
      {
        runner_id: runnerId,
        executor_id: executorId,
        model_id: MODEL,
        compression: false,
        reason: "version",
      },
    ]),
  );
  expect(
    unwrap(
      await getLiveCertification(t.db, runnerId, executorId, MODEL, false),
    ),
  ).toBeNull();
  expect(await eligibility()).toMatchObject({
    gate_eligible: 0,
    conformance_passed_at: null,
  });
});

test("the fleet's admission block lists pending queued sessions by reason; an ended one keeps its reason unlisted", async () => {
  const queue = async (id: string, reason: string) => {
    unwrap(await session(id));
    unwrap(
      await updateSessionState(t.db, id, {
        from: ["pending"],
        to: "pending",
        patch: { queued_reason: reason },
      }),
    );
  };
  await queue("q-slot-1", "slot");
  await queue("q-slot-2", "slot");
  await queue("q-paused", "fleet_paused");
  await queue("q-ended", "budget");
  unwrap(
    await updateSessionState(t.db, "q-ended", {
      from: ["pending"],
      to: "exited",
    }),
  );
  const { admission } = unwrap(await getFleetOverview(t.db));
  expect(admission.by_reason).toEqual({ slot: 2, fleet_paused: 1 });
  // Oldest first; one clock, so created_at ties and the id decides.
  expect(admission.queued.map((q) => [q.session_id, q.reason])).toEqual([
    ["q-paused", "fleet_paused"],
    ["q-slot-1", "slot"],
    ["q-slot-2", "slot"],
  ]);
  expect(admission.queued[0]).toMatchObject({
    agent: SPINE_SEED.agentName,
    executor_id: executorId,
    since: T0,
  });
});
