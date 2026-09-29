// The prices a session's mapper bills with: the database's rows of its runner — the
// operator's price, not the adapter's registration — active first; a row with a null price is not
// a price; the registration's rows come last, for a model the database has no priced row of.
import { FakeClock } from "@bayon/core";
import { modelRow, seedRows, tempDb, unwrap } from "@bayon/db/testing";
import type { ModelRow } from "@bayon/runners";
import { afterAll, expect, test } from "vitest";
import { runnerPrices } from "./prices.js";

const t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
afterAll(() => t.cleanup());

const prices = (p: number) => ({
  price_in_per_mtok: p,
  price_out_per_mtok: p * 2,
  price_cache_read_per_mtok: p / 10,
  price_cache_write_per_mtok: p,
});

unwrap(
  await seedRows(t.db, {
    runners: [
      { id: "r1", kind: "script", adapter: "r1", caps_json: "{}" },
      { id: "r2", kind: "script", adapter: "r2", caps_json: "{}" },
    ],
    models: [
      // The adapter's row, replaced by the operator's for the same model string.
      modelRow("r1", "complex", { model: "m", active: 0, ...prices(5) }),
      modelRow("r1", "complex", {
        id: "r1.own",
        model: "m",
        source: "operator",
        ...prices(0),
        context_tokens: 32_768,
      }),
      modelRow("r1", "cheap", {
        model: "unpriced",
        ...prices(1),
        price_out_per_mtok: null,
      }),
      modelRow("r1", "standard", {
        model: "gone",
        retired_at: 1,
        active: 0,
        ...prices(9),
      }),
      modelRow("r2", "cheap", { model: "m", ...prices(7) }),
    ],
  }),
);

const registered: ModelRow = {
  id: "r1.registered",
  tier: "cheap",
  model: "unpriced",
  priceInPerMtok: 3,
  priceOutPerMtok: 3,
  priceCacheReadPerMtok: 3,
  priceCacheWritePerMtok: 3,
  contextTokens: 1,
};

test("the operator's active row comes first; unpriced, retired and other runners' rows are left out", async () => {
  const rows = unwrap(await runnerPrices(t.db, "r1", [registered]));
  expect(rows.map((r) => r.id)).toEqual([
    "r1.own",
    "r1.complex",
    "r1.registered",
  ]);
  expect(rows[0]).toEqual({
    id: "r1.own",
    tier: "complex",
    model: "m",
    priceInPerMtok: 0,
    priceOutPerMtok: 0,
    priceCacheReadPerMtok: 0,
    priceCacheWritePerMtok: 0,
    contextTokens: 32_768,
  });
});
