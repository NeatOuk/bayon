import {
  ALL_NOTIFY_EVENTS,
  OPERATOR_SETTINGS,
  OPERATOR_SETTING_KEYS,
  type OperatorSettingKey,
} from "@bayon/core";
import type {
  NotifyChannelStatus,
  NotifyChannelsView,
  NotifyConfigView,
  OperatorSettingsView,
} from "@bayon/proto";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { NotificationsSettings } from "@/notify/notifications-settings";
import {
  apiError,
  bodyOf,
  callsTo,
  renderWithProviders,
  stubFetch,
  type FetchMock,
} from "@/test/render";

// Settings → Notifications: a channel's switch and its events as boxes (never a
// number), the store step when its destination is missing, a test send with its three answers, the
// quiet hours, and the confirm that stands between a bearer holder and a redirected notification.

const SETTINGS = "/api/v1/settings";
const CHANNELS = "/api/v1/notifications/channels";
const CONFIG = "/api/v1/notifications/config";
const TEST = "/api/v1/notifications/test";

const settingsView = (
  over: Partial<Record<OperatorSettingKey, number>> = {},
): OperatorSettingsView => ({
  require_certified: true,
  settings: OPERATOR_SETTING_KEYS.map((key) => ({
    key,
    value: over[key] ?? OPERATOR_SETTINGS[key].default,
    valid: true,
    default: OPERATOR_SETTINGS[key].default,
    updated_at: 1,
  })),
});

const channel = (
  over: Partial<NotifyChannelStatus> & Pick<NotifyChannelStatus, "channel">,
): NotifyChannelStatus => ({
  enabled: false,
  configured: false,
  store: "keychain",
  keychain: { service: "foreman", owner: true },
  secret: null,
  last_sent_at: null,
  ...over,
});

const CHANNELS_VIEW: NotifyChannelsView = [
  channel({ channel: "mac", configured: true }),
  channel({ channel: "ntfy", secret: "NOTIFY_NTFY_URL" }),
  channel({ channel: "webhook", secret: "NOTIFY_WEBHOOK_URL" }),
  channel({ channel: "email", secret: "NOTIFY_SMTP_URL" }),
];

const CONFIG_VIEW: NotifyConfigView = {
  email_to: "old@example.test",
  email_from: "",
  base_url: "",
};

function stub(
  o: {
    readonly settings?: OperatorSettingsView;
    readonly channels?: NotifyChannelsView;
    readonly config?: NotifyConfigView;
    readonly put?: unknown;
    readonly test?: unknown;
    readonly putConfig?: unknown;
  } = {},
): FetchMock {
  const settings = o.settings ?? settingsView();
  return stubFetch({
    [SETTINGS]: (init: RequestInit | undefined) =>
      init?.method === "PUT" ? (o.put ?? settings) : settings,
    [CHANNELS]: o.channels ?? CHANNELS_VIEW,
    [CONFIG]: (init: RequestInit | undefined) =>
      init?.method === "PUT"
        ? (o.putConfig ?? { ...CONFIG_VIEW, email_to: "new@example.test" })
        : (o.config ?? CONFIG_VIEW),
    [TEST]: o.test ?? { channel: "ntfy", sent: true },
  });
}

const card = async (name: string) =>
  within(await screen.findByRole("region", { name }));

const destinationsPanel = () =>
  within(screen.getByRole("region", { name: "notification destinations" }));

/** The Change button of the nth destination field, in NOTIFY_CONFIG_FIELDS order. */
const changeButton = (at: number) => {
  const button = destinationsPanel().getAllByRole("button", {
    name: "Change",
  })[at];
  if (button === undefined) throw new Error(`no Change button at ${at}`);
  return button;
};

afterEach(() => {
  window.location.hash = "";
});

test("a channel that is off, not configured, shows the one command that stores its destination", async () => {
  stub();
  renderWithProviders(<NotificationsSettings />);
  const ntfy = await card("ntfy notifications");
  expect(ntfy.getByText("Not configured")).toBeTruthy();
  expect(ntfy.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  // The command, the pbpaste form, and a button to copy it — never a field asking for the value.
  const command = ntfy.getByText(/security add-generic-password/);
  expect(command.textContent).toContain("NOTIFY_NTFY_URL");
  expect(command.textContent).toContain('"$(pbpaste)"');
  // The live install's own service, as the API reported it.
  expect(command.textContent).toContain("-s foreman -a NOTIFY_NTFY_URL");
  expect(
    ntfy.getByRole("button", {
      name: "Copy the Keychain command for NOTIFY_NTFY_URL",
    }),
  ).toBeTruthy();
  expect(ntfy.getByText(/FRM_SECRET_NOTIFY_NTFY_URL/)).toBeTruthy();
  expect(ntfy.queryByRole("textbox")).toBeNull();
});

test("an API on another home: the command names that home's service, and says it is not ~/.foreman's", async () => {
  stub({
    channels: [
      channel({
        channel: "ntfy",
        secret: "NOTIFY_NTFY_URL",
        keychain: { service: "foreman-0123456789ab", owner: false },
      }),
    ],
  });
  renderWithProviders(<NotificationsSettings />);
  const ntfy = await card("ntfy notifications");
  expect(ntfy.getByText(/security add-generic-password/).textContent).toBe(
    'security add-generic-password -U -s foreman-0123456789ab -a NOTIFY_NTFY_URL -w "$(pbpaste)"',
  );
  expect(ntfy.getByText(/wc -c/).textContent).toBe(
    "security find-generic-password -s foreman-0123456789ab -a NOTIFY_NTFY_URL -w | wc -c",
  );
  expect(
    ntfy.getByText(
      "Then run, for the Keychain · foreman-0123456789ab (this home's own, not ~/.foreman's):",
    ),
  ).toBeTruthy();
});

test("a configured channel says where its secret is and shows no store step", async () => {
  stub({
    channels: [
      channel({
        channel: "ntfy",
        secret: "NOTIFY_NTFY_URL",
        configured: true,
        enabled: true,
        last_sent_at: 1_800_000_000_000,
      }),
    ],
    settings: settingsView({ "notify.ntfy.enabled": 1 }),
  });
  renderWithProviders(<NotificationsSettings />);
  const ntfy = await card("ntfy notifications");
  expect(ntfy.getByText("Configured")).toBeTruthy();
  expect(ntfy.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  expect(ntfy.queryByText(/security add-generic-password/)).toBeNull();
  expect(
    ntfy.getByText(
      "NOTIFY_NTFY_URL is in the API's Keychain · foreman (this install); it never leaves the API.",
    ),
  ).toBeTruthy();
  expect(ntfy.getByText(/Last sent/)).toBeTruthy();
});

test("a channel's last error is shown as an error", async () => {
  stub({
    channels: [
      channel({
        channel: "webhook",
        secret: "NOTIFY_WEBHOOK_URL",
        configured: true,
        last_error: "webhook answered HTTP 500",
      }),
    ],
  });
  renderWithProviders(<NotificationsSettings />);
  const webhook = await card("webhook notifications");
  expect(webhook.getByRole("alert").textContent).toContain(
    "webhook answered HTTP 500",
  );
});

test("the switch writes notify.<channel>.enabled at once", async () => {
  const user = userEvent.setup();
  const fetchMock = stub();
  renderWithProviders(<NotificationsSettings />);
  const mac = await card("mac notifications");
  await user.click(mac.getByRole("switch"));
  await waitFor(() =>
    expect(callsTo(fetchMock, SETTINGS, "PUT")).toHaveLength(1),
  );
  expect(bodyOf(fetchMock, SETTINGS, "PUT")).toEqual({
    settings: { "notify.mac.enabled": 1 },
  });
});

test("the events boxes write the mask, and the number is never shown", async () => {
  const user = userEvent.setup();
  const fetchMock = stub({
    settings: settingsView({ "notify.mac.events": 0 }),
  });
  renderWithProviders(<NotificationsSettings />);
  const mac = await card("mac notifications");
  // Plain labels, not bits.
  for (const label of [
    "Questions",
    "Staffing proposals",
    "Ready for your QA",
    "Blocked tickets",
    "Jira sync failures",
    "Budget warnings",
    "Needs attention",
  ])
    expect(mac.getByRole("checkbox", { name: new RegExp(label) })).toBeTruthy();
  expect(mac.queryByText(String(ALL_NOTIFY_EVENTS))).toBeNull();

  // Blocked tickets is bit 8: from 0, ticking it sends exactly 8.
  await user.click(mac.getByRole("checkbox", { name: /Blocked tickets/ }));
  await waitFor(() =>
    expect(callsTo(fetchMock, SETTINGS, "PUT")).toHaveLength(1),
  );
  expect(bodyOf(fetchMock, SETTINGS, "PUT")).toEqual({
    settings: { "notify.mac.events": 8 },
  });
});

test("unticking one kind leaves every other where it was", async () => {
  const user = userEvent.setup();
  const fetchMock = stub();
  renderWithProviders(<NotificationsSettings />);
  const mac = await card("mac notifications");
  const questions = mac.getByRole("checkbox", { name: /Questions/ });
  expect(questions.getAttribute("aria-checked")).toBe("true");
  await user.click(questions);
  await waitFor(() =>
    expect(callsTo(fetchMock, SETTINGS, "PUT")).toHaveLength(1),
  );
  // 127 without bit 1.
  expect(bodyOf(fetchMock, SETTINGS, "PUT")).toEqual({
    settings: { "notify.mac.events": ALL_NOTIFY_EVENTS - 1 },
  });
});

test("Send test: sent, refused, and the cooldown read as a wait rather than a failure", async () => {
  const user = userEvent.setup();
  const answers: unknown[] = [
    { channel: "ntfy", sent: true },
    {
      channel: "ntfy",
      sent: false,
      error: {
        class: "runner_error",
        message: "ntfy answered HTTP 500",
        retryable: true,
      },
    },
    apiError(409, "conflict", "a test of ntfy ran 1000 ms ago"),
  ];
  stub({ test: () => answers.shift() });
  renderWithProviders(<NotificationsSettings />);
  const ntfy = await card("ntfy notifications");
  const button = ntfy.getByRole("button", { name: "Send test" });

  await user.click(button);
  expect(
    (await ntfy.findByText(/Sent\. It should reach you now\./)).textContent,
  ).toBeTruthy();

  await user.click(button);
  expect((await ntfy.findByRole("alert")).textContent).toContain(
    "Not sent: ntfy answered HTTP 500",
  );

  await user.click(button);
  expect(
    (
      await ntfy.findByText(
        "A test just went to this channel. Wait a few seconds.",
      )
    ).textContent,
  ).toBeTruthy();
});

test("quiet hours and the poll interval save together; −1 reads as off", async () => {
  const user = userEvent.setup();
  const fetchMock = stub();
  renderWithProviders(<NotificationsSettings />);
  const timing = within(
    await screen.findByRole("region", {
      name: "notification timing",
    }),
  );
  const start = timing.getByLabelText("Quiet hours start") as HTMLInputElement;
  expect(start.value).toBe("-1");
  const hint = document.getElementById(
    start.getAttribute("aria-describedby")?.split(" ")[0] ?? "",
  );
  expect(hint?.textContent).toContain("Now -1; default -1");

  await user.clear(start);
  await user.type(start, "22");
  await user.clear(timing.getByLabelText("Quiet hours end"));
  await user.type(timing.getByLabelText("Quiet hours end"), "7");
  await user.click(timing.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(callsTo(fetchMock, SETTINGS, "PUT")).toHaveLength(1),
  );
  expect(bodyOf(fetchMock, SETTINGS, "PUT")).toEqual({
    settings: { "notify.quiet_start_hour": 22, "notify.quiet_end_hour": 7 },
  });
});

test("changing a destination asks first, naming both values, and Cancel sends nothing", async () => {
  const user = userEvent.setup();
  const fetchMock = stub();
  renderWithProviders(<NotificationsSettings />);
  const field = (await screen.findByLabelText(
    "the email recipient",
  )) as HTMLInputElement;
  expect(field.value).toBe("old@example.test");
  await user.clear(field);
  await user.type(field, "new@example.test");

  await user.click(changeButton(0));

  const dialog = within(await screen.findByRole("alertdialog"));
  expect(
    dialog.getByRole("heading", { name: "Change the email recipient?" }),
  ).toBeTruthy();
  const said = (await screen.findByRole("alertdialog")).textContent ?? "";
  expect(said).toContain("old@example.test");
  expect(said).toContain("new@example.test");
  expect(said).toContain("audit log");
  // The old address is told: the safeguard, said before the change is made.
  expect(said).toContain("no longer the recipient");
  // Nothing has been sent yet: the confirm is the gate.
  expect(callsTo(fetchMock, CONFIG, "PUT")).toHaveLength(0);

  await user.click(dialog.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(callsTo(fetchMock, CONFIG, "PUT")).toHaveLength(0);
});

test("confirming sends exactly that one field, and says what it is now", async () => {
  const user = userEvent.setup();
  const fetchMock = stub();
  renderWithProviders(<NotificationsSettings />);
  const field = (await screen.findByLabelText(
    "the email recipient",
  )) as HTMLInputElement;
  await user.clear(field);
  await user.type(field, "new@example.test");
  await user.click(changeButton(0));
  const dialog = within(await screen.findByRole("alertdialog"));
  await user.click(dialog.getByRole("button", { name: "Change it" }));

  await waitFor(() =>
    expect(callsTo(fetchMock, CONFIG, "PUT")).toHaveLength(1),
  );
  expect(bodyOf(fetchMock, CONFIG, "PUT")).toEqual({
    email_to: "new@example.test",
  });
  // The change is an event: a toast says it, with the audit log beside it.
  expect(
    (
      await screen.findByRole("status", {
        name: /is now new@example\.test/,
      })
    ).textContent,
  ).toContain("audit log");
});

test("a value the schema refuses never reaches the confirm", async () => {
  const user = userEvent.setup();
  const fetchMock = stub();
  renderWithProviders(<NotificationsSettings />);
  const base = (await screen.findByLabelText(
    "the link origin",
  )) as HTMLInputElement;
  await user.type(base, "https://bayon.example.test/inbox");
  const destinations = destinationsPanel();
  await user.click(changeButton(2));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(destinations.getByRole("alert").textContent).toContain(
    "an http(s) origin with no path",
  );
  expect(callsTo(fetchMock, CONFIG, "PUT")).toHaveLength(0);
});

test("a refused PUT says why and leaves the field to be corrected", async () => {
  const user = userEvent.setup();
  stub({
    putConfig: apiError(400, "validation", "email_to: not an email address"),
  });
  renderWithProviders(<NotificationsSettings />);
  const field = (await screen.findByLabelText(
    "the email recipient",
  )) as HTMLInputElement;
  await user.clear(field);
  await user.type(field, "new@example.test");
  await user.click(changeButton(0));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Change it",
    }),
  );
  expect(
    (await screen.findByText(/Not changed: email_to: not an email address/))
      .textContent,
  ).toBeTruthy();
});

test("the notify settings are not drawn twice: General points at this tab instead", async () => {
  stub();
  const { unmount } = renderWithProviders(<NotificationsSettings />);
  expect(await screen.findByLabelText("Quiet hours start")).toBeTruthy();
  unmount();

  const { GeneralSettings } = await import("@/settings/general-settings");
  stubFetch({
    [SETTINGS]: settingsView(),
    "/api/v1/executors": { executors: [], untrusted_roles: [] },
  });
  renderWithProviders(<GeneralSettings />);
  expect(await screen.findByLabelText("Queue recheck (ms)")).toBeTruthy();
  expect(screen.queryByLabelText("Quiet hours start")).toBeNull();
  expect(screen.queryByLabelText("Mac notifications")).toBeNull();
  expect(
    screen.getByRole("link", { name: "their own tab" }).getAttribute("href"),
  ).toBe("#/settings/notifications");
});
