import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import {
  newRunInput,
  newSessionInput,
  seedSpine,
  tempDb,
  unwrap,
} from "../testing.js";
import { SUPERVISOR_RUNNER_TYPE, insertEventsBatch } from "./events.js";
import { appendRun, finishRun, getOpenRun, listRuns } from "./runs.js";
import { createSession } from "./sessions.js";

const T0 = 1_700_000_000_000;
const t = unwrap(await tempDb(new FakeClock(T0)));
afterAll(() => t.cleanup());
unwrap(await seedSpine(t.db, 2));

test("the open run is the latest run with no terminal event, whatever its state", async () => {
  const session = unwrap(await createSession(t.db, newSessionInput())).id;
  expect(unwrap(await getOpenRun(t.db, session))).toBeNull();
  const one = unwrap(await appendRun(t.db, newRunInput(session)));
  const two = unwrap(await appendRun(t.db, newRunInput(session)));
  expect(unwrap(await getOpenRun(t.db, session))?.id).toBe(two.id);

  // A timer's verdict is not a terminal: the run stays open until one is written.
  unwrap(await finishRun(t.db, two.id, { state: "timeout" }));
  expect(unwrap(await getOpenRun(t.db, session))?.id).toBe(two.id);
  unwrap(
    await insertEventsBatch(t.db, [
      {
        session_id: session,
        run_id: two.id,
        ts: T0,
        kind: "terminal",
        runner_type: SUPERVISOR_RUNNER_TYPE,
        raw_offset: -two.seq,
      },
    ]),
  );
  expect(unwrap(await getOpenRun(t.db, session))?.id).toBe(one.id);

  // Only a terminal closes a run.
  unwrap(
    await insertEventsBatch(t.db, [
      {
        session_id: session,
        run_id: one.id,
        ts: T0,
        kind: "turn_end",
        runner_type: "script.step",
        raw_offset: 0,
      },
    ]),
  );
  expect(unwrap(await getOpenRun(t.db, session))?.id).toBe(one.id);
  unwrap(
    await insertEventsBatch(t.db, [
      {
        session_id: session,
        run_id: one.id,
        ts: T0,
        kind: "terminal",
        runner_type: "script.terminal",
        raw_offset: 1,
      },
    ]),
  );
  expect(unwrap(await getOpenRun(t.db, session))).toBeNull();
  expect(unwrap(await listRuns(t.db, session)).map((r) => r.seq)).toEqual([
    1, 2,
  ]);
});
