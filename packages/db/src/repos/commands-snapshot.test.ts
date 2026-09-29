import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import {
  execute,
  internalsOf,
  openDb,
  qb,
  type Internals,
} from "../connection.js";
import { tempDb, unwrap } from "../testing.js";
import { getCommandQueued, insertCommand } from "./commands.js";

// getCommandQueued answers three things at once — the row, the clock, and what the claimer takes
// before it — and an operator reads them as one instant: "pending, nothing ahead" is the screen's
// way of saying nobody has picked this up. The supervisor writes the same file from its own
// connection, so unless the three statements share a snapshot it can settle the run in front
// between them, and a run already going reads as a wedged one.

const LANE = "test.snapshot-lane";

/** A clock that lets a test slip one commit in between two statements of the same read. */
class InterleavingClock extends FakeClock {
  #next: (() => void) | null = null;

  /** Runs `fn` the next time anything asks the time, then forgets it. */
  once(fn: () => void): void {
    this.#next = fn;
  }

  override now(): number {
    const fn = this.#next;
    this.#next = null;
    fn?.();
    return super.now();
  }
}

const clock = new InterleavingClock(1_700_000_000_000);
const t = unwrap(await tempDb(clock));
// The supervisor's connection: its own, as the daemon's is.
const other = unwrap(await openDb({ path: t.path, clock }));
const supervisor: Internals = unwrap(internalsOf(other));
afterAll(async () => {
  await other.close();
  t.cleanup();
});

/** The supervisor settling a command, synchronously, so it commits between two statements. */
const settle = (id: string) => (): void => {
  execute(
    supervisor,
    qb
      .updateTable("commands")
      .set({ state: "done", claimed_at: clock.now(), attempts: 1 })
      .where("id", "=", id),
  );
};

test("what is ahead is read in the snapshot the row was read in", async () => {
  const head = unwrap(
    await insertCommand(t.db, { type: LANE, payload: { n: 1 } }),
  );
  await clock.advance(1_000);
  const behind = unwrap(
    await insertCommand(t.db, { type: LANE, payload: { n: 2 } }),
  );
  // The supervisor finishes the run in front the instant after the row is read.
  clock.once(settle(head.id));
  const queued = unwrap(await getCommandQueued(t.db, behind.id));
  expect(queued.row.state).toBe("pending");
  // Read outside a transaction this is [] — "pending, nothing ahead", for a run that is waiting.
  expect(queued.ahead.map((row) => row.id)).toEqual([head.id]);
  // The commit is not lost, only held off: the next read sees the lane empty in front.
  expect(unwrap(await getCommandQueued(t.db, behind.id)).ahead).toEqual([]);
});
