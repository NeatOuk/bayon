import { FakeClock, err, ok, type Result } from "@bayon/core";
import { expect, test } from "vitest";
import { pollUntil, within } from "./deadline.js";

const clock = () => new FakeClock(1_000_000);

test("pollUntil returns the first value the probe yields", async () => {
  const c = clock();
  let calls = 0;
  const done = pollUntil(
    { clock: c, timeoutMs: 1_000, intervalMs: 100, what: "third call" },
    async () => ok((calls += 1) >= 3 ? calls : undefined),
  );
  // One event-loop turn first, so the poll has armed its first timer.
  await new Promise((resolve) => setImmediate(resolve));
  await c.advance(1_000);
  expect(await done).toEqual(ok(3));
});

test("pollUntil times out at the deadline, naming what it waited for", async () => {
  const c = clock();
  let calls = 0;
  const done = pollUntil(
    {
      clock: c,
      timeoutMs: 1_000,
      intervalMs: 300,
      what: "heartbeat",
      detail: () => `seen ${calls}`,
    },
    async () => {
      calls += 1;
      return ok(undefined);
    },
  );
  // One event-loop turn first, so the poll has armed its first timer.
  await new Promise((resolve) => setImmediate(resolve));
  await c.advance(1_000);
  expect(await done).toEqual(
    err({
      class: "timeout",
      message: "heartbeat: not within 1 s (seen 5)",
      retryable: false,
    }),
  );
});

test("pollUntil stops at once on an error from the probe", async () => {
  const failed: Result<number> = err({
    class: "internal",
    message: "supervisor exited",
    retryable: false,
  });
  const c = clock();
  const done = await pollUntil(
    { clock: c, timeoutMs: 1_000, intervalMs: 100, what: "x" },
    async () => failed,
  );
  expect(done).toBe(failed);
  expect(c.now()).toBe(1_000_000);
});

test("within resolves with the work's value, or times out", async () => {
  const c = clock();
  expect(
    await within({ clock: c, timeoutMs: 50, what: "x" }, Promise.resolve(7)),
  ).toEqual(ok(7));
  const never = within(
    { clock: c, timeoutMs: 2_500, what: "terminal event" },
    new Promise<never>(() => {}),
  );
  await c.advance(2_500);
  expect(await never).toMatchObject({
    ok: false,
    error: { class: "timeout", message: "terminal event: not within 2.5 s" },
  });
});
