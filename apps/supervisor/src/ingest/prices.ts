// What a session's mapper prices tokens with: its runner's models rows as the database
// holds them — the operator's price is the one billed — active first, then the adapter's own
// registered rows for any model string the database has no priced row of (a runner a test never
// registered). A row with a null price is not a price: the mapper marks such a model unpriced, and
// admission refuses to spawn one.
import { ok, type Result } from "@bayon/core";
import { listModels, type Db, type ModelRow as StoredModel } from "@bayon/db";
import type { ModelRow } from "@bayon/runners";

const priced = (m: StoredModel): ModelRow | null => {
  const {
    price_in_per_mtok: priceIn,
    price_out_per_mtok: priceOut,
    price_cache_read_per_mtok: cacheRead,
    price_cache_write_per_mtok: cacheWrite,
  } = m;
  if (
    priceIn === null ||
    priceOut === null ||
    cacheRead === null ||
    cacheWrite === null
  )
    return null;
  return {
    id: m.id,
    tier: m.tier,
    model: m.model,
    priceInPerMtok: priceIn,
    priceOutPerMtok: priceOut,
    priceCacheReadPerMtok: cacheRead,
    priceCacheWritePerMtok: cacheWrite,
    contextTokens: m.context_tokens ?? 0,
  };
};

/** `runnerId`'s prices, the database's first (active before inactive), then `registered`. */
export async function runnerPrices(
  db: Db,
  runnerId: string,
  registered: readonly ModelRow[],
): Promise<Result<readonly ModelRow[]>> {
  const rows = await listModels(db);
  if (!rows.ok) return rows;
  const stored = rows.value
    .filter((m) => m.runner_id === runnerId && m.retired_at === null)
    .toSorted((a, b) => b.active - a.active)
    .flatMap((m) => {
      const p = priced(m);
      return p === null ? [] : [p];
    });
  return ok([...stored, ...registered]);
}
