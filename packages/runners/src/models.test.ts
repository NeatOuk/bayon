// checkOperatorModel hands the row's context_tokens on to its runner's validateModel hook
//, beside model-check.test.ts's coverage of the rest of the fill-in. The runner whose
// hook actually judges context_tokens is found through the registry, never by name (Invariant 1,
// the same rule tools/frm/src/config-models.test.ts follows): among the runners with rules of
// their own, the one whose verdict on its own shipped row flips when context_tokens is absurdly
// large is the one reading it.
import { expect, test } from "vitest";
import { registrations } from "./adapters/registry.js";
import {
  checkOperatorModel,
  runnersWithModelRules,
  type StoredRunner,
} from "./models.js";

const ruled = runnersWithModelRules()
  .map((id) => registrations().find((r) => r.runner.id === id))
  .filter((r) => r !== undefined);

const inputFor = (
  r: (typeof ruled)[number],
  contextTokens: number | undefined,
) => {
  const shipped = r.models[0];
  if (shipped === undefined) throw new Error(`${r.runner.id}: no models`);
  return {
    id: shipped.id,
    runner_id: r.runner.id,
    tier: shipped.tier,
    model: shipped.model,
    ...(shipped.effort === undefined ? {} : { effort: shipped.effort }),
    price_in_per_mtok: 0,
    price_out_per_mtok: 0,
    ...(contextTokens === undefined ? {} : { context_tokens: contextTokens }),
  };
};

const storedRunnerOf = (r: (typeof ruled)[number]): StoredRunner => ({
  id: r.runner.id,
  defaults_json: JSON.stringify(r.runner.defaults),
  registered: r.models.map((m) => m.model),
});

const reader = ruled.find((r) => {
  const stored = storedRunnerOf(r);
  const shipped = r.models[0];
  if (shipped === undefined) return false;
  const atOwn = checkOperatorModel(inputFor(r, shipped.contextTokens), stored);
  const atHuge = checkOperatorModel(
    inputFor(r, Number.MAX_SAFE_INTEGER),
    stored,
  );
  return atOwn.ok && !atHuge.ok;
});

test("a runner exists whose hook judges context_tokens", () => {
  expect(reader).toBeDefined();
});

test("context_tokens reaches the hook when the input carries one", () => {
  if (reader === undefined) throw new Error("no reader found");
  const stored = storedRunnerOf(reader);
  const shipped = reader.models[0];
  if (shipped === undefined) throw new Error("no shipped model");
  expect(
    checkOperatorModel(inputFor(reader, shipped.contextTokens), stored).ok,
  ).toBe(true);
  expect(
    checkOperatorModel(inputFor(reader, Number.MAX_SAFE_INTEGER), stored).ok,
  ).toBe(false);
});

test("absent when the input carries none, and the hook is refused for wanting it", () => {
  if (reader === undefined) throw new Error("no reader found");
  const stored = storedRunnerOf(reader);
  expect(checkOperatorModel(inputFor(reader, undefined), stored).ok).toBe(
    false,
  );
});
