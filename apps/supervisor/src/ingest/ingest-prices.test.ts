// A segment's mapper bills with the database's prices: the operator's row of the
// session's runner, read when the segment begins, ahead of the adapter's registration.
import { mkdtempSync, rmSync } from "node:fs";
import { FakeClock } from "@bayon/core";
import {
  SPINE_SEED,
  modelRow,
  newRunInput,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
} from "@bayon/db/testing";
import type { ModelRow } from "@bayon/runners";
import { pino } from "pino";
import { afterAll, expect, test } from "vitest";
import { ingestHarness } from "../testing/ingest-harness.js";
import { createIngest } from "./ingest.js";

const clock = new FakeClock(1_700_000_000_000);
const t = unwrap(await tempDb(clock));
unwrap(await seedSpine(t.db, 2));
const home = mkdtempSync("/tmp/frm-");
afterAll(() => {
  t.cleanup();
  rmSync(home, { recursive: true, force: true });
});
const h = ingestHarness({
  db: t.db,
  home,
  sessionInput: newSessionInput,
  runInput: newRunInput,
});

test("the operator's price is the first the mapper is given, before the registration's", async () => {
  unwrap(
    await seedRows(t.db, {
      models: [
        modelRow(SPINE_SEED.runnerId, "standard", {
          id: "own",
          model: "own-model",
          source: "operator",
          price_in_per_mtok: 0.5,
          price_out_per_mtok: 1.5,
          price_cache_read_per_mtok: 0.05,
          price_cache_write_per_mtok: 0.5,
        }),
      ],
    }),
  );
  const ingest = createIngest({
    db: t.db,
    clock,
    log: pino({ level: "silent" }),
  });
  const seen: (readonly ModelRow[])[] = [];
  const sessionId = await h.session();
  const s = await h.start(
    ingest,
    sessionId,
    { runs: [{ events: [] }] },
    { watchPrices: (p) => seen.push(p) },
  );
  expect(seen).toHaveLength(1);
  expect(seen[0]?.[0]).toMatchObject({
    id: "own",
    model: "own-model",
    priceInPerMtok: 0.5,
    priceOutPerMtok: 1.5,
  });
  expect(seen[0]?.slice(1)).toEqual(h.adapter.registration().models);
  await h.adapter.stop(s.handle, "kill");
  await s.attachment.closed;
});
