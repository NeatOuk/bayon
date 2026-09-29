// POST /fleet/pause|resume, GET/PUT /settings and GET /audit over HTTP: the kill switch
// audited and idempotent, the settings whitelist enforced at the door (unknown key or bad value →
// 400, nothing written), and the audit log paged newest first.
import {
  FLEET_PAUSED_KEY,
  FakeClock,
  OPERATOR_SETTINGS,
  OPERATOR_SETTING_KEYS,
  systemClock,
} from "@bayon/core";
import { getSettings } from "@bayon/db";
import {
  SPINE_SEED,
  listAudit,
  seedSpine,
  tempDb,
  unwrap,
  updateRowForTest,
  type RowPatch,
  type TempDb,
} from "@bayon/db/testing";
import {
  ApiErrorBody,
  AuditPage,
  Fleet,
  FleetPauseState,
  OperatorSettingsView,
} from "@bayon/proto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { dbStore } from "./db-store.js";
import { startApi, type RunningApi } from "./server.js";

const TOKEN = "e2e-fleet-control-bearer-0123456789ab";

let t: TempDb;
let api: RunningApi;

beforeAll(async () => {
  t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
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

const call = (path: string, init: RequestInit = {}) =>
  fetch(`${api.url}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });

const post = (path: string) => call(path, { method: "POST" });
const put = (body: unknown) =>
  call("/settings", { method: "PUT", body: JSON.stringify(body) });
const actions = async () =>
  unwrap(await listAudit(t.db)).map((r) => [r.actor, r.action, r.payload_json]);
const paused = async () =>
  unwrap(await getSettings(t.db, [FLEET_PAUSED_KEY])).get(FLEET_PAUSED_KEY);

test("the kill switch: pause, pause again (no change), resume; audited once per change; GET /fleet shows it", async () => {
  const res = await post("/fleet/pause");
  expect(res.status).toBe(200);
  expect(FleetPauseState.parse(await res.json())).toMatchObject({
    paused: true,
    changed: true,
  });
  expect(await paused()).toBe(1);
  expect(Fleet.parse(await (await call("/fleet")).json()).paused).toBe(true);

  const again = FleetPauseState.parse(
    await (await post("/fleet/pause")).json(),
  );
  expect(again).toMatchObject({ paused: true, changed: false });

  const resumed = await post("/fleet/resume");
  expect(resumed.status).toBe(200);
  expect(FleetPauseState.parse(await resumed.json())).toMatchObject({
    paused: false,
    changed: true,
  });
  expect(await paused()).toBe(0);
  expect(Fleet.parse(await (await call("/fleet")).json()).paused).toBe(false);
  expect(await actions()).toEqual([
    ["operator", "fleet.pause", JSON.stringify({ via: "rest" })],
    ["operator", "fleet.resume", JSON.stringify({ via: "rest" })],
  ]);
});

test("without the bearer, POST /fleet/pause is 401 and pauses nothing", async () => {
  const res = await fetch(`${api.url}/fleet/pause`, { method: "POST" });
  expect(res.status).toBe(401);
  expect(await paused()).toBe(0);
});

test("GET /settings: every whitelisted key in order, its value, default and last write", async () => {
  const res = await call("/settings");
  expect(res.status).toBe(200);
  const view = OperatorSettingsView.parse(await res.json());
  const { settings } = view;
  expect(settings.map((s) => s.key)).toEqual([...OPERATOR_SETTING_KEYS]);
  // A security control: reported read-only, never in the whitelist.
  expect(view.require_certified).toBe(true);
  expect(settings.map((s) => s.key)).not.toContain(
    "admission.require_certified",
  );
  for (const s of settings) {
    expect(s).toMatchObject({
      value: OPERATOR_SETTINGS[s.key].default,
      default: OPERATOR_SETTINGS[s.key].default,
      valid: true,
    });
    expect(s.updated_at).not.toBeNull();
  }
});

test("PUT /settings: whitelisted keys are written and audited; the answer is the new view", async () => {
  const res = await put({
    settings: { "admission.recheck_ms": 2_000, "backup.at_utc_hour": 4 },
  });
  expect(res.status).toBe(200);
  const { settings } = OperatorSettingsView.parse(await res.json());
  expect(settings.find((s) => s.key === "admission.recheck_ms")?.value).toBe(
    2_000,
  );
  expect(settings.find((s) => s.key === "backup.at_utc_hour")?.value).toBe(4);
  expect((await actions()).slice(2)).toEqual([
    [
      "operator",
      "settings.put",
      JSON.stringify({ via: "rest", from: 5_000, to: 2_000 }),
    ],
    [
      "operator",
      "settings.put",
      JSON.stringify({ via: "rest", from: 3, to: 4 }),
    ],
  ]);
});

test.each([
  [
    "a key outside the whitelist",
    { "executors.untrusted_roles": ["reviewer"] },
  ],
  ["fleet.paused, which has its own doors", { "fleet.paused": 1 }],
  [
    "admission.require_certified, a security control",
    { "admission.require_certified": 0 },
  ],
  ["a value out of bounds", { "admission.recheck_ms": 0 }],
  [
    "a known key beside an unknown one",
    { "backup.keep": 3, "gates.wall_clock_ms": 1 },
  ],
  ["a string for a number", { "backup.keep": "3" }],
  ["no key at all", {}],
])(
  "PUT /settings refuses %s: 400 validation, nothing written or audited",
  async (_, settings) => {
    const before = await actions();
    const res = await put({ settings });
    expect(res.status).toBe(400);
    expect(ApiErrorBody.parse(await res.json()).error.class).toBe("validation");
    expect(await actions()).toEqual(before);
    const keep = unwrap(await getSettings(t.db, ["backup.keep"])).get(
      "backup.keep",
    );
    expect(keep).toBe(14);
  },
);

test("GET /audit pages newest first and filters by actor and action", async () => {
  const first = AuditPage.parse(await (await call("/audit?limit=2")).json());
  expect(first.items.map((i) => i.action)).toEqual([
    "settings.put",
    "settings.put",
  ]);
  expect(first.items[0]?.payload).toEqual({ via: "rest", from: 3, to: 4 });
  expect(first.has_more).toBe(true);
  expect(first.next_cursor).toBe(first.items[1]?.id);
  const second = AuditPage.parse(
    await (await call(`/audit?limit=2&before=${first.next_cursor}`)).json(),
  );
  expect(second.items.map((i) => i.action)).toEqual([
    "fleet.resume",
    "fleet.pause",
  ]);
  expect(second).toMatchObject({ has_more: false, next_cursor: null });

  const fleet = AuditPage.parse(
    await (await call("/audit?actor=operator&action=fleet.*")).json(),
  );
  expect(fleet.items.map((i) => i.action)).toEqual([
    "fleet.resume",
    "fleet.pause",
  ]);
  const none = AuditPage.parse(
    await (await call("/audit?actor=supervisor")).json(),
  );
  expect(none.items).toEqual([]);
});

test.each(["limit=0", "limit=201", "before=0", "actor=a*b", "action="])(
  "GET /audit?%s is 400",
  async (query) => {
    const res = await call(`/audit?${query}`);
    expect(res.status).toBe(400);
  },
);

test("PUT /settings/budget is audited and shows up in GET /audit with both values", async () => {
  // The cap has its own door, outside the /settings whitelist — so it needs its own audit row, or
  // the one control that stops runaway spend changes with no trace of who did it.
  const res = await call("/settings/budget", {
    method: "PUT",
    body: JSON.stringify({ daily_cap_usd: 22 }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ daily_cap_usd: 22 });

  const raise = await call("/settings/budget", {
    method: "PUT",
    body: JSON.stringify({ daily_cap_usd: 100 }),
  });
  expect(raise.status).toBe(200);

  const page = AuditPage.parse(
    await (await call("/audit?actor=operator&action=budget.*")).json(),
  );
  const caps = page.items.filter((i) => i.action === "budget.put");
  expect(caps).toHaveLength(2);
  // Newest first: the 22 -> 100 raise, the exact change this ticket was filed over.
  expect(caps[0]).toMatchObject({
    actor: "operator",
    action: "budget.put",
    target_kind: "setting",
    target_id: "budget.daily_cap_usd",
  });
  expect(caps[0]?.payload).toMatchObject({ from: 22, to: 100 });
});

test("POST /fleet/attention/:id/ack clears an error exit from the strip, and refuses a live one", async () => {
  // The strip mixed live conditions with post-mortem facts, and the facts sat there for 24 h with
  // no way to clear them. Only the finished one is dismissible.
  unwrap(await seedSpine(t.db, 19));
  const setSession = async (patch: RowPatch<"sessions">) =>
    unwrap(
      await updateRowForTest(t.db, "sessions", SPINE_SEED.sessionId, patch),
    );
  await setSession({
    state: "exited",
    ended_at: 1_700_000_000_000 - 60_000,
    exit_reason: "error",
    error_message: "runner crashed",
  });

  const onStrip = async (): Promise<string[]> =>
    Fleet.parse(await (await call("/fleet")).json()).attention.map(
      (a) => a.session_id,
    );
  expect(await onStrip()).toContain(SPINE_SEED.sessionId);

  const acked = await post(`/fleet/attention/${SPINE_SEED.sessionId}/ack`);
  expect(acked.status).toBe(200);
  expect(await acked.json()).toMatchObject({
    session_id: SPINE_SEED.sessionId,
    acked_by: "operator",
  });
  // Dismissed stays dismissed, and the act is on the record with its actor.
  expect(await onStrip()).not.toContain(SPINE_SEED.sessionId);
  expect(await onStrip()).not.toContain(SPINE_SEED.sessionId);
  const page = AuditPage.parse(
    await (await call("/audit?action=attention.ack")).json(),
  );
  expect(page.items[0]).toMatchObject({
    actor: "operator",
    action: "attention.ack",
    target_kind: "session",
    target_id: SPINE_SEED.sessionId,
  });

  // A session that is not an error exit has nothing terminal to dismiss: 409, not a silent hide.
  await setSession({ state: "idle", ended_at: null, exit_reason: null });
  const refused = await post(`/fleet/attention/${SPINE_SEED.sessionId}/ack`);
  expect(refused.status).toBe(409);
  expect(ApiErrorBody.parse(await refused.json()).error.message).toContain(
    "only a finished session's error",
  );
});
