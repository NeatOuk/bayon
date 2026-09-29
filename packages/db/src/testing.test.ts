import { FakeClock } from "@bayon/core";
import { expect, test } from "vitest";
import { insertCommand } from "./api.js";
import { getEventsSince, getSession } from "./index.js";
import {
  addSession,
  appendEvents,
  listCommands,
  seedSpine,
  tempDb,
  unwrap,
} from "./testing.js";

test("addSession, appendEvents and listCommands let other workspaces' tests play the supervisor", async () => {
  const { db, cleanup } = unwrap(await tempDb(new FakeClock(1_000)));
  try {
    unwrap(await seedSpine(db, 2));
    unwrap(await addSession(db, "S1"));
    expect(unwrap(await getSession(db, "S1")).state).toBe("pending");

    expect(unwrap(await appendEvents(db, "S1", 3))).toEqual([1, 2, 3]);
    expect(unwrap(await appendEvents(db, "S1", 2))).toEqual([4, 5]);
    expect(unwrap(await appendEvents(db, "S1", 0))).toEqual([]);
    const page = unwrap(
      await getEventsSince(db, { sessionId: "S1", since: 0, limit: 10 }),
    );
    expect(page.rows.map((row) => row.raw_offset)).toEqual([0, 1, 2, 3, 4]);
    expect(page.rows.every((row) => row.kind === "assistant_text")).toBe(true);

    unwrap(await insertCommand(db, { type: "a", payload: {} }));
    unwrap(await insertCommand(db, { type: "b", payload: {} }));
    // Same-millisecond ids have no defined order; compare as a set.
    const types = unwrap(await listCommands(db)).map((c) => c.type);
    expect(types.toSorted()).toEqual(["a", "b"]);
  } finally {
    cleanup();
  }
});
