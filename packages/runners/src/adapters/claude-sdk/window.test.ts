import { expect, test } from "vitest";
import type { ModelRow } from "../../adapter.js";
import {
  DEFAULT_WINDOW,
  ONE_M_WINDOW,
  bareModel,
  hasOneM,
  streamPrices,
} from "./window.js";

const row = (model: string, priceInPerMtok: number): ModelRow => ({
  id: `claude-sdk.${model}`,
  tier: "complex",
  model,
  priceInPerMtok,
  priceOutPerMtok: 1,
  priceCacheReadPerMtok: 0.1,
  priceCacheWritePerMtok: 1.25,
  contextTokens: DEFAULT_WINDOW,
});

test("the suffix is the CLI's 1M opt-in, and the API sees the bare id", () => {
  expect(hasOneM("claude-opus-5-5[1m]")).toBe(true);
  expect(hasOneM("claude-sonnet-5")).toBe(false);
  expect(bareModel("claude-opus-5-5[1m]")).toBe("claude-opus-5-5");
  expect(bareModel("claude-sonnet-5")).toBe("claude-sonnet-5");
  expect(ONE_M_WINDOW).toBe(1_000_000);
  expect(DEFAULT_WINDOW).toBe(200_000);
});

test("a suffixed row prices its bare id too, after every stored row", () => {
  const suffixed = row("claude-opus-5-5[1m]", 4);
  const plain = row("claude-haiku-4-5", 1);
  expect(streamPrices([suffixed, plain])).toEqual([
    suffixed,
    plain,
    { ...suffixed, model: "claude-opus-5-5" },
  ]);
});

test("a bare row of its own is found first, so it keeps its own price", () => {
  const own = row("claude-sonnet-5", 2);
  const suffixed = row("claude-sonnet-5[1m]", 3);
  const prices = streamPrices([suffixed, own]);
  expect(prices.find((r) => r.model === "claude-sonnet-5")).toBe(own);
});

test("no suffixed row: the rows as given", () => {
  const rows = [row("claude-sonnet-5", 2)];
  expect(streamPrices(rows)).toBe(rows);
});
