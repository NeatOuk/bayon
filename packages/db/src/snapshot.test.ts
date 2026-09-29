import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import {
  execute,
  first,
  internalsOf,
  openDb,
  qb,
  read,
  readSnapshot,
  type Internals,
} from "./connection.js";
import { tempDb, unwrap } from "./testing.js";

// readSnapshot vs read: another connection commits between two statements of one read.

const clock = new FakeClock(1_700_000_000_000);
const t = unwrap(await tempDb(clock));
const other = unwrap(await openDb({ path: t.path, clock }));
const writer = unwrap(internalsOf(other));
afterAll(async () => {
  await other.close();
  t.cleanup();
});

const settingsCount = (ix: Internals): number =>
  first(
    ix,
    qb.selectFrom("settings").select((eb) => eb.fn.countAll<number>().as("n")),
  )?.n ?? -1;

let commits = 0;
/** A commit on the other connection, synchronous, so it lands between two statements. */
function commitElsewhere(): void {
  commits += 1;
  execute(
    writer,
    qb.insertInto("settings").values({
      key: `snapshot.test.${commits}`,
      value_json: "1",
      updated_at: 0,
    }),
  );
}

const countTwice = (ix: Internals): [number, number] => {
  const before = settingsCount(ix);
  commitElsewhere();
  return [before, settingsCount(ix)];
};

test("readSnapshot: every statement sees the snapshot the first one opened", async () => {
  const [before, after] = unwrap(await readSnapshot(t.db, countTwice));
  expect(after).toBe(before);
  // Once it ends, the commit is visible.
  expect(unwrap(await read(t.db, settingsCount))).toBe(before + 1);
});

test("read: a later statement sees what committed after the first", async () => {
  const [before, after] = unwrap(await read(t.db, countTwice));
  expect(after).toBe(before + 1);
});

test("readSnapshot returns fn's value and holds no lock afterwards", async () => {
  expect(unwrap(await readSnapshot(t.db, () => 42))).toBe(42);
  commitElsewhere(); // a writer is not blocked by a finished read transaction
});
