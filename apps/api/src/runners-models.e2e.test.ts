// POST, PATCH and DELETE /runners/:id/models over HTTP: the bearer, the body's shape
// (no settings: they are shell-only), the runner's adapter's verdict, the one-active-per-tier
// rule, and the audit row each write leaves.
import { FakeClock, canonicalJson, systemClock } from "@bayon/core";
import { getModel, listAuditPage } from "@bayon/db";
import {
  SPINE_SEED,
  modelRow,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import { ApiErrorBody, ModelWriteReply, RunnersView } from "@bayon/proto";
import { registrations } from "@bayon/runners";
import { runnersWithModelRules } from "@bayon/runners/models";
import { afterAll, beforeAll, expect, test } from "vitest";
import { dbStore } from "./db-store.js";
import { startApi, type RunningApi } from "./server.js";

const TOKEN = "e2e-models-bearer-0123456789abcdef";
const RUNNER = SPINE_SEED.runnerId;
const CHEAP = `${RUNNER}.cheap`;
const COMPLEX = `${RUNNER}.complex`;
const SMALL = `${RUNNER}-cheap-model`;
const URL = "http://10.0.0.7:11434/v1";

/**
 * The runner with rules of its own whose registration ships a `[1m]`-suffixed model string
 *, found through the registry and the shape of its own shipped strings, never by name
 * (Invariant 1). New strings for the tests below are derived from its shipped one.
 */
const ONE_M = "[1m]";
const ruledWithOneM = runnersWithModelRules()
  .map((id) => registrations().find((r) => r.runner.id === id))
  .find(
    (r) => r !== undefined && r.models.some((m) => m.model.endsWith(ONE_M)),
  );
if (ruledWithOneM === undefined) {
  throw new Error("no runner with model rules ships a [1m] model");
}
const suffixedShipped = ruledWithOneM.models.find((m) =>
  m.model.endsWith(ONE_M),
);
if (suffixedShipped === undefined) throw new Error("unreachable");
const RULED = ruledWithOneM.runner.id;
const BARE_MODEL = suffixedShipped.model.slice(0, -ONE_M.length);
const NEW_BARE = `${BARE_MODEL}-9`;
const NEW_SUFFIXED = `${NEW_BARE}${ONE_M}`;

let t: TempDb;
let api: RunningApi;

beforeAll(async () => {
  t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  unwrap(await seedSpine(t.db, 8));
  unwrap(
    await seedRows(t.db, {
      models: [
        modelRow(RUNNER, "cheap", { price_out_per_mtok: 2 }),
        modelRow(RUNNER, "complex", { price_out_per_mtok: 30 }),
        // An operator row carrying settings, which the page shows and the REST door never takes.
        modelRow(RUNNER, "standard", {
          id: `${RUNNER}.with-url`,
          model: SMALL,
          source: "operator",
          active: 0,
          settings_json: JSON.stringify({ provider_url: URL }),
        }),
      ],
      // The ruled-with-[1m] runner's own rows, as a booted supervisor registers them.
      runners: [
        {
          id: RULED,
          kind: ruledWithOneM.runner.kind,
          adapter: ruledWithOneM.runner.adapter,
          caps_json: canonicalJson(ruledWithOneM.runner.caps),
          defaults_json: JSON.stringify(ruledWithOneM.runner.defaults),
        },
      ],
    }),
  );
  api = await startApi({
    config: { token: TOKEN, host: "127.0.0.1", port: 0 },
    store: dbStore(t.db),
    clock: systemClock,
    logger: false,
  });
});

afterAll(async () => {
  await api.close();
  t.cleanup();
});

const call = (
  method: string,
  path: string,
  body?: unknown,
  token: string | null = TOKEN,
) =>
  fetch(`${api.url}${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const errorOf = async (res: Response) =>
  ApiErrorBody.parse(await res.json()).error;

const own = (o: Record<string, unknown> = {}) => ({
  id: `${RUNNER}.own`,
  tier: "standard",
  model: SMALL,
  price_in_per_mtok: 0,
  price_out_per_mtok: 0,
  context_tokens: 32_768,
  ...o,
});

const audits = async () =>
  unwrap(await listAuditPage(t.db, { limit: 100, action: "model.*" })).rows;

test("every models route needs the operator's bearer", async () => {
  for (const [method, path, body] of [
    ["POST", `/runners/${RUNNER}/models`, own()],
    ["PATCH", `/runners/${RUNNER}/models/${CHEAP}`, { price_in_per_mtok: 1 }],
    ["DELETE", `/runners/${RUNNER}/models/${CHEAP}`, undefined],
  ] as const) {
    expect((await call(method, path, body, null)).status).toBe(401);
    expect((await call(method, path, body, "wrong-token")).status).toBe(401);
  }
  expect(await audits()).toEqual([]);
});

test("the body's shape: settings are never taken here, and a PATCH must change something", async () => {
  const withSettings = await call("POST", `/runners/${RUNNER}/models`, {
    ...own(),
    settings: { provider_url: URL },
  });
  expect(withSettings.status).toBe(400);
  expect(
    (
      await call("PATCH", `/runners/${RUNNER}/models/${CHEAP}`, {
        settings: {},
      })
    ).status,
  ).toBe(400);
  expect(
    (await call("PATCH", `/runners/${RUNNER}/models/${CHEAP}`, {})).status,
  ).toBe(400);
  expect(
    (
      await call("POST", `/runners/${RUNNER}/models`, {
        ...own(),
        price_in_per_mtok: -1,
      })
    ).status,
  ).toBe(400);
});

test("the runner's adapter judges the model: one it does not register is refused, naming why", async () => {
  const res = await call(
    "POST",
    `/runners/${RUNNER}/models`,
    own({ model: "invented-model" }),
  );
  expect(res.status).toBe(400);
  expect((await errorOf(res)).message).toContain(
    'model "invented-model" is not one this runner registers',
  );
  expect((await call("POST", `/runners/nope/models`, own())).status).toBe(404);
});

test("POST adds the operator's row, audited; the same id again conflicts", async () => {
  const res = await call("POST", `/runners/${RUNNER}/models`, own());
  expect(res.status).toBe(201);
  const reply = ModelWriteReply.parse(await res.json());
  expect(reply).toMatchObject({
    changed: true,
    replaced: [],
    model: {
      id: `${RUNNER}.own`,
      source: "operator",
      active: true,
      price_in_per_mtok: 0,
      // A cache price left out is the input price.
      price_cache_read_per_mtok: 0,
      settings: {},
    },
  });
  const [audit] = await audits();
  expect(audit).toMatchObject({
    actor: "operator",
    action: "model.put",
    target_id: `${RUNNER}.own`,
  });
  expect(JSON.parse(audit?.payload_json ?? "null")).toMatchObject({
    via: "rest",
  });
  const again = await call("POST", `/runners/${RUNNER}/models`, own());
  expect(again.status).toBe(409);
});

test("a second active operator model in a tier is refused 409, with the rule; an adapter's row is replaced", async () => {
  const clash = await call(
    "POST",
    `/runners/${RUNNER}/models`,
    own({ id: `${RUNNER}.own2` }),
  );
  expect(clash.status).toBe(409);
  expect((await errorOf(clash)).message).toContain(
    `already runs operator model ${RUNNER}.own in tier standard`,
  );
  // Moving the operator's row to complex takes the adapter's row's place there.
  const moved = await call("PATCH", `/runners/${RUNNER}/models/${RUNNER}.own`, {
    tier: "complex",
  });
  expect(moved.status).toBe(200);
  expect(ModelWriteReply.parse(await moved.json())).toMatchObject({
    replaced: [COMPLEX],
    model: { tier: "complex", active: true },
  });
  expect(unwrap(await getModel(t.db, COMPLEX)).active).toBe(0);
});

test("PATCH of an adapter's row makes it the operator's; DELETE turns a row off and gives its tier back", async () => {
  const priced = await call("PATCH", `/runners/${RUNNER}/models/${CHEAP}`, {
    price_in_per_mtok: 0.25,
    effort: "high",
  });
  expect(priced.status).toBe(200);
  expect(ModelWriteReply.parse(await priced.json()).model).toMatchObject({
    source: "operator",
    price_in_per_mtok: 0.25,
    price_out_per_mtok: 2,
    effort: "high",
  });
  // Unchanged: nothing written, nothing audited.
  const before = (await audits()).length;
  const same = await call("PATCH", `/runners/${RUNNER}/models/${CHEAP}`, {
    price_in_per_mtok: 0.25,
  });
  expect(ModelWriteReply.parse(await same.json()).changed).toBe(false);
  expect(await audits()).toHaveLength(before);

  const off = await call("DELETE", `/runners/${RUNNER}/models/${RUNNER}.own`);
  expect(off.status).toBe(200);
  expect(ModelWriteReply.parse(await off.json())).toMatchObject({
    changed: true,
    model: { active: false },
  });
  expect(unwrap(await getModel(t.db, COMPLEX)).active).toBe(1);
  expect((await audits())[0]?.action).toBe("model.deactivate");
  expect((await call("DELETE", `/runners/${RUNNER}/models/nope`)).status).toBe(
    404,
  );
  expect(
    (await call("PATCH", `/runners/other/models/${CHEAP}`, { active: true }))
      .status,
  ).toBe(404);
});

test("GET /runners shows each row's source and settings; a PATCH re-judges the stored settings and never drops them", async () => {
  const { runners } = RunnersView.parse(
    await (await call("GET", "/runners")).json(),
  );
  const runner = runners.find((r) => r.id === RUNNER);
  expect(
    runner?.inactive_models.find((m) => m.id === `${RUNNER}.with-url`),
  ).toMatchObject({ source: "operator", settings: { provider_url: URL } });
  // This runner's adapter takes no settings: the row is judged whole, settings included.
  const patched = await call(
    "PATCH",
    `/runners/${RUNNER}/models/${RUNNER}.with-url`,
    { price_in_per_mtok: 0, price_out_per_mtok: 0 },
  );
  expect(patched.status).toBe(400);
  expect((await errorOf(patched)).message).toContain("take no settings");
  expect(unwrap(await getModel(t.db, `${RUNNER}.with-url`)).settings_json).toBe(
    JSON.stringify({ provider_url: URL }),
  );
});

// The runner whose adapter judges an operator's model against the CLI's own window rule rather
// than a closed list: context_tokens is required, and its ceiling depends on whether
// the model string opts into the runner's own `[1m]` suffix.
test("a new unsuffixed model at its ceiling is accepted; past it, refused naming the rule", async () => {
  const ok = await call("POST", `/runners/${RULED}/models`, {
    id: `${RULED}.e2e-bare`,
    tier: "standard",
    model: NEW_BARE,
    price_in_per_mtok: 0,
    price_out_per_mtok: 0,
    context_tokens: 200_000,
  });
  expect(ok.status).toBe(201);
  expect(ModelWriteReply.parse(await ok.json()).model).toMatchObject({
    model: NEW_BARE,
    context_tokens: 200_000,
  });
  const { runners } = RunnersView.parse(
    await (await call("GET", "/runners")).json(),
  );
  const runner = runners.find((r) => r.id === RULED);
  expect(
    [...(runner?.models ?? []), ...(runner?.inactive_models ?? [])].find(
      (m) => m.id === `${RULED}.e2e-bare`,
    ),
  ).toBeDefined();

  const past = await call("POST", `/runners/${RULED}/models`, {
    id: `${RULED}.e2e-bare-too-big`,
    tier: "cheap",
    model: `${NEW_BARE}-b`,
    price_in_per_mtok: 0,
    price_out_per_mtok: 0,
    context_tokens: 1_000_000,
  });
  expect(past.status).toBe(400);
  expect((await errorOf(past)).message).toContain("200000");
});

test("the [1m] opt-in accepts 1,000,000; a string off the pattern is refused", async () => {
  const suffixed = await call("POST", `/runners/${RULED}/models`, {
    id: `${RULED}.e2e-1m`,
    tier: "complex",
    model: NEW_SUFFIXED,
    price_in_per_mtok: 0,
    price_out_per_mtok: 0,
    context_tokens: 1_000_000,
  });
  expect(suffixed.status).toBe(201);
  expect(ModelWriteReply.parse(await suffixed.json()).model).toMatchObject({
    model: NEW_SUFFIXED,
    context_tokens: 1_000_000,
  });

  const offPattern = await call("POST", `/runners/${RULED}/models`, {
    id: `${RULED}.e2e-off-pattern`,
    tier: "cheap",
    model: "not a model string!!",
    price_in_per_mtok: 0,
    price_out_per_mtok: 0,
    context_tokens: 200_000,
  });
  expect(offPattern.status).toBe(400);
});

test("PATCH context_tokens past the rule is refused, and the stored row is untouched", async () => {
  const before = unwrap(await getModel(t.db, `${RULED}.e2e-bare`));
  const patched = await call(
    "PATCH",
    `/runners/${RULED}/models/${RULED}.e2e-bare`,
    { context_tokens: 1_000_000 },
  );
  expect(patched.status).toBe(400);
  expect((await errorOf(patched)).message).toContain("200000");
  expect(unwrap(await getModel(t.db, `${RULED}.e2e-bare`))).toEqual(before);
});
