import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import {
  newRunInput,
  newSessionInput,
  seedSpine,
  tempDb,
  unwrap,
} from "../testing.js";
import { appendRun, finishRun } from "./runs.js";
import { createSession } from "./sessions.js";

const T0 = 1_700_000_000_000;
const clock = new FakeClock(T0);
const t = unwrap(await tempDb(clock));
unwrap(await seedSpine(t.db, 2));
afterAll(() => t.cleanup());

const newSession = async () =>
  unwrap(await createSession(t.db, newSessionInput())).id;

test("appendRun numbers runs per session and starts them running", async () => {
  const a = await newSession();
  const b = await newSession();
  const first = unwrap(await appendRun(t.db, newRunInput(a)));
  const second = unwrap(await appendRun(t.db, newRunInput(a)));
  const other = unwrap(await appendRun(t.db, newRunInput(b)));
  expect([first.seq, second.seq, other.seq]).toEqual([1, 2, 1]);
  expect(first).toMatchObject({
    state: "running",
    started_at: T0,
    tool_calls: 0,
  });
});

test("a duplicate idempotency_key returns the existing run", async () => {
  const session = await newSession();
  const input = { ...newRunInput(session), idempotency_key: "send-1" };
  const first = unwrap(await appendRun(t.db, input));
  const again = unwrap(await appendRun(t.db, input));
  expect(again).toEqual(first);
  const elsewhere = await newSession();
  expect(
    await appendRun(t.db, {
      ...newRunInput(elsewhere),
      idempotency_key: "send-1",
    }),
  ).toMatchObject({ ok: false, error: { class: "conflict" } });
});

test("finishRun is a CAS from running", async () => {
  const run = unwrap(await appendRun(t.db, newRunInput(await newSession())));
  await clock.advance(5_000);
  const finished = unwrap(
    await finishRun(t.db, run.id, {
      state: "failed",
      error_class: "runner_exited_without_terminal",
      error_message: "stream ended",
    }),
  );
  expect(finished).toMatchObject({
    state: "failed",
    ended_at: T0 + 5_000,
    error_class: "runner_exited_without_terminal",
  });
  expect(await finishRun(t.db, run.id, { state: "ok" })).toMatchObject({
    ok: false,
    error: { class: "conflict" },
  });
  expect(await finishRun(t.db, "no-such-run", { state: "ok" })).toMatchObject({
    ok: false,
    error: { class: "not_found" },
  });
});

test("appendRun for an unknown session is a validation error", async () => {
  expect(await appendRun(t.db, newRunInput("no-such-session"))).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
});
