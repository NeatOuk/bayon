import {
  FakeClock,
  NOTIFY_NTFY_URL_SECRET,
  NOTIFY_SMTP_URL_SECRET,
  NOTIFY_WEBHOOK_URL_SECRET,
  systemClock,
} from "@bayon/core";
import { openDb, type Db } from "@bayon/db";
import {
  dumpAllRows,
  listAudit,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import {
  ApiErrorBody,
  NotificationsPage,
  NotifyChannelsView,
  NotifyConfigView,
  NotifyTestResult,
} from "@bayon/proto";
import type { LoggerService } from "@nestjs/common";
import { afterAll, beforeAll, expect, test } from "vitest";
import { dbStore } from "../db-store.js";
import { urlSecretParts } from "../secret-scrub.js";
import { startApi, type RunningApi } from "../server.js";
import { buildChannels } from "./channels/index.js";
import type { ExecFile } from "./channels/mac.js";
import { fakeSecrets, startHookFixture, type HookFixture } from "./fixtures.js";
import { Notifier } from "./notifier.js";
import { NOTIFY_TEST_COOLDOWN_MS, NotificationsService } from "./service.js";
import { mailParties } from "./settings.js";

// The notifier's REST door over HTTP, against a temp-file DB, a local HTTP fixture for
// ntfy and the webhook, a stubbed osascript and a stub SMTP transport — never a real destination.
// Each channel's status (booleans and names only), a test send (audited, 409 on a repeat within the
// cooldown, 400 on an unknown channel), the outbox paged; and after every send, failed ones whose
// answers echo the secrets back included, no DB row, response body or log line holds any secret or
// its base64.

const BEARER = "e2e-notify-0123456789abcdef";
const NTFY_URL =
  "https://alice:ntfy-pw-e2e-51c8@ntfy.fixture.test/topic-e2e-3d9a7b";
const WEBHOOK_URL =
  "https://hooks.fixture.test/services/T1/B1/webhook-e2e-8c2f41";
const SMTP_PASS = "smtp-pw-e2e-6e0b93";
const SMTP_URL = `smtps://mailer%40acme.test:${SMTP_PASS}@smtp.fixture.test:465`;
const SECRETS = [NTFY_URL, WEBHOOK_URL, SMTP_URL];

let spine: TempDb;
let apiDb: Db;
let api: RunningApi;
let fx: HookFixture;
let notifier: Notifier;
const clock = new FakeClock(Date.UTC(2026, 8, 22, 12));
const lines: string[] = [];
const bodies: string[] = [];
const osascript: string[][] = [];
/** Every message the stub SMTP transport was handed: who it was for, and what it said. */
const mails: { to: string; from: string; subject: string; text: string }[] = [];

const capture = (...parts: unknown[]) =>
  void lines.push(
    parts.map((p) => (p instanceof Error ? p.stack : String(p))).join(" "),
  );
const nestLogger: LoggerService = {
  log: capture,
  error: capture,
  warn: capture,
  debug: capture,
  verbose: capture,
  fatal: capture,
};

beforeAll(async () => {
  spine = unwrap(await tempDb(clock));
  unwrap(await seedSpine(spine.db, 1));
  unwrap(
    await seedRows(spine.db, {
      workspaces: [{ id: "shop", name: "Shop", kind: "single" }],
      tickets: [ticketRow(12, { workspace_id: "shop" })],
    }),
  );
  apiDb = unwrap(await openDb({ path: spine.path, clock }));
  fx = await startHookFixture();
  const execFile: ExecFile = (_file, args) => {
    osascript.push([...args]);
    return Promise.resolve();
  };
  const channels = buildChannels({
    secrets: fakeSecrets({
      [NOTIFY_NTFY_URL_SECRET]: NTFY_URL,
      [NOTIFY_WEBHOOK_URL_SECRET]: WEBHOOK_URL,
      [NOTIFY_SMTP_URL_SECRET]: SMTP_URL,
    }),
    parties: () => mailParties(apiDb),
    fetch: fx.fetchVia(),
    platform: "darwin",
    execFile,
    // An SMTP server that refuses with everything it was given, in every form.
    makeTransport: (o) => ({
      sendMail: (m) => {
        mails.push({
          to: m.to,
          from: m.from,
          subject: m.subject,
          text: m.text,
        });
        return Promise.reject(
          Object.assign(
            new Error(
              `535 rejected ${o.auth?.user ?? ""}:${o.auth?.pass ?? ""} ${Buffer.from(`\0${o.auth?.user ?? ""}\0${o.auth?.pass ?? ""}`).toString("base64")}`,
            ),
            { code: "EAUTH" },
          ),
        );
      },
      close: () => undefined,
    }),
  });
  notifier = new Notifier({
    db: apiDb,
    clock,
    channels,
    logger: { warn: capture, error: capture },
  });
  api = await startApi({
    config: { token: BEARER, host: "127.0.0.1", port: 0 },
    store: dbStore(apiDb),
    clock: systemClock,
    logger: nestLogger,
    notifications: new NotificationsService({
      db: apiDb,
      clock,
      channels,
      store: {
        kind: "keychain",
        keychain: { service: "foreman-0123456789ab", owner: false },
      },
      logger: { warn: capture, error: capture },
    }),
  });
});

afterAll(async () => {
  await notifier?.stop();
  await api?.close();
  await apiDb?.close();
  await fx?.close();
  spine?.cleanup();
});

async function http(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ readonly status: number; readonly json: unknown }> {
  const res = await fetch(`${api.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${BEARER}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, json: text === "" ? null : JSON.parse(text) };
}

const setting = (key: string, value: unknown) =>
  seedRows(spine.db, {
    settings: [{ key, value_json: JSON.stringify(value), updated_at: 0 }],
  });

test("GET /notifications/channels: each channel's switch, whether it is configured, the store and the secret's name", async () => {
  const res = await http("GET", "/notifications/channels");
  expect(res.status).toBe(200);
  const view = NotifyChannelsView.parse(res.json);
  expect(view).toEqual([
    {
      channel: "mac",
      enabled: false,
      configured: true,
      store: "keychain",
      keychain: { service: "foreman-0123456789ab", owner: false },
      secret: null,
      last_sent_at: null,
    },
    {
      channel: "ntfy",
      enabled: false,
      configured: true,
      store: "keychain",
      keychain: { service: "foreman-0123456789ab", owner: false },
      secret: "NOTIFY_NTFY_URL",
      last_sent_at: null,
    },
    {
      channel: "webhook",
      enabled: false,
      configured: true,
      store: "keychain",
      keychain: { service: "foreman-0123456789ab", owner: false },
      secret: "NOTIFY_WEBHOOK_URL",
      last_sent_at: null,
    },
    // No recipient yet: email is not configured, whatever the host store holds.
    {
      channel: "email",
      enabled: false,
      configured: false,
      store: "keychain",
      keychain: { service: "foreman-0123456789ab", owner: false },
      secret: "NOTIFY_SMTP_URL",
      last_sent_at: null,
    },
  ]);
  unwrap(await setting("notify.email.to", "op@example.test"));
  unwrap(await setting("notify.ntfy.enabled", 1));
  const after = NotifyChannelsView.parse(
    (await http("GET", "/notifications/channels")).json,
  );
  expect(after.find((c) => c.channel === "email")?.configured).toBe(true);
  expect(after.find((c) => c.channel === "ntfy")?.enabled).toBe(true);
});

test("POST /notifications/test sends one now, audited; a repeat inside the cooldown is 409", async () => {
  const res = await http("POST", "/notifications/test", { channel: "ntfy" });
  expect(res.status).toBe(200);
  expect(NotifyTestResult.parse(res.json)).toEqual({
    channel: "ntfy",
    sent: true,
  });
  expect(fx.seen.at(-1)?.headers.title).toBe("Bayon test notification");
  expect(
    (await http("POST", "/notifications/test", { channel: "ntfy" })).status,
  ).toBe(409);
  await clock.advance(NOTIFY_TEST_COOLDOWN_MS);
  expect(
    (await http("POST", "/notifications/test", { channel: "ntfy" })).status,
  ).toBe(200);

  const mac = await http("POST", "/notifications/test", { channel: "mac" });
  expect(NotifyTestResult.parse(mac.json)).toEqual({
    channel: "mac",
    sent: true,
  });
  expect(osascript.at(-1)?.slice(-3)).toEqual([
    "--",
    "Bayon test notification",
    "Notifications reach you on this channel.",
  ]);

  const tests = unwrap(await listAudit(apiDb)).filter(
    (a) => a.action === "notify.test",
  );
  expect(
    tests.map((a) => [a.actor, a.target_kind, a.target_id, a.payload_json]),
  ).toEqual([
    ["operator", "notify_channel", "ntfy", '{"sent":true}'],
    ["operator", "notify_channel", "ntfy", '{"sent":true}'],
    ["operator", "notify_channel", "mac", '{"sent":true}'],
  ]);
});

test("a test that fails answers why, scrubbed; an unknown channel is 400", async () => {
  const echo = `bad hook ${WEBHOOK_URL} ${Buffer.from(WEBHOOK_URL).toString("base64")}`;
  fx.answers.push({ status: 500, body: echo });
  const res = await http("POST", "/notifications/test", { channel: "webhook" });
  expect(res.status).toBe(200);
  const result = NotifyTestResult.parse(res.json);
  expect(result).toMatchObject({
    channel: "webhook",
    sent: false,
    error: { class: "runner_error", retryable: true },
  });
  expect(result.error?.message).toMatch(/^webhook answered HTTP 500/);

  const email = NotifyTestResult.parse(
    (await http("POST", "/notifications/test", { channel: "email" })).json,
  );
  expect(email).toMatchObject({ sent: false, error: { retryable: false } });

  for (const body of [
    { channel: "pager" },
    {},
    { channel: "ntfy", extra: 1 },
  ]) {
    const bad = await http("POST", "/notifications/test", body);
    expect([JSON.stringify(body), bad.status]).toEqual([
      JSON.stringify(body),
      400,
    ]);
    expect(ApiErrorBody.parse(bad.json).error.class).toBe("validation");
  }
});

test("GET /notifications pages the outbox newest first, each with its deliveries", async () => {
  await notifier.tick(); // a first boot: the watermarks start here
  unwrap(
    await seedRows(spine.db, {
      human_requests: [1, 2, 3].map((n) => ({
        id: `R${n}`,
        session_id: "session-fixture",
        ticket_id: "ticket-12",
        kind: "decision",
        question: `question ${n}?`,
        asked_at: clock.now(),
      })),
    }),
  );
  fx.answers.push({ status: 503, body: `down ${NTFY_URL}` });
  await notifier.tick();
  const first = await http("GET", "/notifications?limit=2");
  expect(first.status).toBe(200);
  const page = NotificationsPage.parse(first.json);
  expect(page.items.map((n) => n.title)).toEqual([
    "fixture asked on FRM-12",
    "fixture asked on FRM-12",
  ]);
  expect(page.items.map((n) => n.body)).toEqual(["question 3?", "question 2?"]);
  expect(page.items[0]?.deliveries.map((d) => [d.channel, d.state])).toEqual([
    ["email", "skipped"],
    ["mac", "skipped"],
    ["ntfy", "sent"],
    ["webhook", "skipped"],
  ]);
  expect(page.next_cursor).not.toBeNull();
  const rest = NotificationsPage.parse(
    (
      await http(
        "GET",
        `/notifications?limit=2&cursor=${page.next_cursor ?? 0}`,
      )
    ).json,
  );
  expect(rest.items.map((n) => n.body)).toEqual(["question 1?"]);
  expect(
    rest.items[0]?.deliveries.find((d) => d.channel === "ntfy"),
  ).toMatchObject({
    state: "pending",
    attempts: 1,
  });
  expect(rest.next_cursor).toBeNull();
  for (const q of ["cursor=0", "cursor=x", "limit=0", "limit=101", "other=1"])
    expect([q, (await http("GET", `/notifications?${q}`)).status]).toEqual([
      q,
      400,
    ]);

  const ntfy = NotifyChannelsView.parse(
    (await http("GET", "/notifications/channels")).json,
  ).find((c) => c.channel === "ntfy");
  expect(ntfy?.last_sent_at).not.toBeNull();
});

const configRows = async () =>
  unwrap(await listAudit(apiDb)).filter((a) => a.action === "notify.config");

const config = async () =>
  NotifyConfigView.parse((await http("GET", "/notifications/config")).json);

test("PUT /notifications/config writes the three, audits both values, and tells the address it replaced", async () => {
  expect(await config()).toEqual({
    email_to: "op@example.test",
    email_from: "",
    base_url: "",
  });
  const mailsBefore = mails.length;
  const put = await http("PUT", "/notifications/config", {
    email_to: "newop@example.test",
    base_url: "https://bayon.example.test:5173",
  });
  expect(put.status).toBe(200);
  expect(NotifyConfigView.parse(put.json)).toEqual({
    email_to: "newop@example.test",
    email_from: "",
    base_url: "https://bayon.example.test:5173",
  });
  expect(await config()).toEqual(NotifyConfigView.parse(put.json));

  // One audit row per field, naming the field and both values (§14).
  expect(
    (await configRows()).map((a) => [
      a.actor,
      a.target_kind,
      a.target_id,
      JSON.parse(a.payload_json ?? "null"),
    ]),
  ).toEqual([
    [
      "operator",
      "setting",
      "notify.email.to",
      { field: "email_to", from: "op@example.test", to: "newop@example.test" },
    ],
    [
      "operator",
      "setting",
      "notify.base_url",
      {
        field: "base_url",
        from: "",
        to: "https://bayon.example.test:5173",
      },
    ],
  ]);

  // The mailbox losing the notifications is told, by mail, whatever `enabled` and quiet hours say:
  // a bearer holder cannot redirect them quietly (§14, the safeguard the review asked for).
  const told = mails.slice(mailsBefore);
  expect(told.map((m) => m.to)).toEqual(["op@example.test"]);
  expect(told[0]?.subject).toContain("the email recipient");
  expect(told[0]?.text).toContain("op@example.test");
  expect(told[0]?.text).toContain("newop@example.test");

  // And both changes are in the outbox, so every channel that is on carries them too.
  const page = NotificationsPage.parse(
    (await http("GET", "/notifications?limit=5")).json,
  );
  expect(
    page.items.filter((n) => n.link_path === "#/settings/notifications"),
  ).toHaveLength(2);
});

test("PUT /notifications/config: only those three keys, only values their schema passes", async () => {
  const before = await config();
  const rowsBefore = (await configRows()).length;
  for (const body of [
    { email_to: "not-an-address" },
    { email_from: "a@b@c" },
    { base_url: "https://bayon.example.test/inbox" },
    { base_url: "https://user:pw@bayon.example.test" },
    { base_url: "notaurl" },
    { "notify.email.to": "x@example.test" },
    { "admission.require_certified": 0 },
    { "executors.untrusted_roles": "reviewer" },
    { email_to: "a@example.test", "backup.keep": 1 },
    {},
  ]) {
    const bad = await http("PUT", "/notifications/config", body);
    expect([JSON.stringify(body), bad.status]).toEqual([
      JSON.stringify(body),
      400,
    ]);
    expect(ApiErrorBody.parse(bad.json).error.class).toBe("validation");
  }
  expect(await config()).toEqual(before);
  expect((await configRows()).length).toBe(rowsBefore);
});

test("the value it already has changes nothing, audits nothing and tells nobody", async () => {
  const current = await config();
  const rowsBefore = (await configRows()).length;
  const mailsBefore = mails.length;
  const again = await http("PUT", "/notifications/config", {
    email_to: current.email_to,
  });
  expect(again.status).toBe(200);
  expect(NotifyConfigView.parse(again.json)).toEqual(current);
  expect((await configRows()).length).toBe(rowsBefore);
  expect(mails.length).toBe(mailsBefore);
});

test("no secret, in any form, reached a DB row, a response body or a log line", async () => {
  const forms = SECRETS.flatMap(urlSecretParts)
    .flatMap((p) => [
      p,
      Buffer.from(p).toString("base64"),
      encodeURIComponent(p),
    ])
    .filter((p) => p.length >= 8);
  const rows = JSON.stringify(unwrap(await dumpAllRows(apiDb)));
  const everything = {
    rows,
    bodies: bodies.join("\n"),
    logs: lines.join("\n"),
  };
  for (const [where, text] of Object.entries(everything))
    expect([where, forms.filter((f) => text.includes(f))]).toEqual([where, []]);
  // And the checks had something to look at: sends failed, and said so.
  expect(lines.some((l) => l.includes("ntfy answered HTTP 503"))).toBe(true);
  expect(rows).toContain("webhook answered HTTP 500");
});
