import { describe, expect, test } from "vitest";
import {
  NOTIFY_BASE_URL_KEY,
  NOTIFY_CONFIG_FIELDS,
  NOTIFY_CONFIG_KEY,
  NOTIFY_EMAIL_TO_KEY,
  NotifyBaseUrl,
  NotifyConfigPatch,
  NotifyEmail,
  isHttpOrigin,
  notifyLink,
} from "./destinations.js";
import {
  ALL_NOTIFY_EVENTS,
  NOTIFY_CHANNELS,
  NOTIFY_CHANNEL_SECRET,
  NOTIFY_EVENT_KINDS,
  eventBit,
  eventsOfMask,
  notifyEnabledKey,
  notifyEventsKey,
  subscribes,
} from "./kinds.js";
import {
  NOTIFY_BODY_MAX,
  NOTIFY_TITLE_MAX,
  NewNotification,
  WATCHDOG_ASKER,
  armNotification,
  blockNotification,
  budgetNotification,
  armGroup,
  capText,
  destinationChangedNotification,
  groupArms,
  inboxLink,
  jiraFailNotification,
  proposalNotification,
  qaHumanNotification,
  questionNotification,
  runnerUpdateNotification,
  ticketLink,
  utcDay,
  type ArmRow,
  type NotifyTicket,
} from "./messages.js";
import {
  NOTIFY_BACKOFF_MS,
  NOTIFY_MAX_ATTEMPTS,
  isQuiet,
  isQuietHour,
  quietEndsAt,
  quietOff,
  retryAt,
} from "./timing.js";
import { OPERATOR_SETTINGS } from "../operator-settings.js";
import { checkSeededSetting } from "../seeded-settings.js";

const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);
const TICKET: NotifyTicket = {
  id: "01TICKET",
  key: "FRM-12",
  num: 12,
  title: "Add the export",
  workspace_id: "shop",
};

describe("event kinds as bits", () => {
  test("a kind's bit is its index: the mask the settings' help text spells out", () => {
    expect(NOTIFY_EVENT_KINDS.map(eventBit)).toEqual([1, 2, 4, 8, 16, 32, 64]);
    expect(ALL_NOTIFY_EVENTS).toBe(127);
    expect(eventsOfMask(ALL_NOTIFY_EVENTS)).toEqual([...NOTIFY_EVENT_KINDS]);
    expect(eventsOfMask(0)).toEqual([]);
    expect(eventsOfMask(1 + 4)).toEqual(["question", "qa_human"]);
    expect(subscribes(2, "staff_proposal")).toBe(true);
    expect(subscribes(2, "question")).toBe(false);
  });

  test("each channel has its settings in the whitelist, off, subscribed to every kind", () => {
    for (const channel of NOTIFY_CHANNELS) {
      expect(OPERATOR_SETTINGS[notifyEnabledKey(channel)].default).toBe(0);
      const events = OPERATOR_SETTINGS[notifyEventsKey(channel)];
      expect([events.unit, events.min, events.max, events.default]).toEqual([
        "mask",
        0,
        ALL_NOTIFY_EVENTS,
        ALL_NOTIFY_EVENTS,
      ]);
    }
  });

  test("every channel but mac has a host-store secret, named for it", () => {
    expect(NOTIFY_CHANNEL_SECRET).toEqual({
      mac: null,
      ntfy: "NOTIFY_NTFY_URL",
      webhook: "NOTIFY_WEBHOOK_URL",
      email: "NOTIFY_SMTP_URL",
    });
  });
});

describe("the shell-only destinations", () => {
  test("an email is one address, or empty for unset", () => {
    expect(NotifyEmail.safeParse("op@example.test").success).toBe(true);
    expect(NotifyEmail.safeParse("").success).toBe(true);
    for (const bad of [
      "op",
      "Op <op@example.test>",
      "a@example.test, b@example.test",
      "op@example.test\r\nBcc: x@evil.test",
      1,
    ])
      expect([bad, NotifyEmail.safeParse(bad).success]).toEqual([bad, false]);
  });

  test("the base url is an http(s) origin with no path", () => {
    for (const good of [
      "https://bayon.lan",
      "https://bayon.lan:5173",
      "http://127.0.0.1:5173/",
      "",
    ])
      expect([good, NotifyBaseUrl.safeParse(good).success]).toEqual([
        good,
        true,
      ]);
    for (const bad of [
      "https://bayon.lan/app",
      "https://bayon.lan/?x=1",
      "https://bayon.lan/#/p",
      "https://op:pw@bayon.lan",
      "javascript:alert(1)",
      "ftp://bayon.lan",
      "bayon.lan",
    ])
      expect([bad, NotifyBaseUrl.safeParse(bad).success]).toEqual([bad, false]);
    expect(isHttpOrigin("not a url")).toBe(false);
  });

  test("they are shell-only, checked wherever they are seeded", () => {
    expect(checkSeededSetting(NOTIFY_EMAIL_TO_KEY, "op@example.test")).toEqual({
      ok: true,
      value: "governed",
    });
    expect(checkSeededSetting(NOTIFY_BASE_URL_KEY, "https://x.test/p").ok).toBe(
      false,
    );
  });

  test("a link is the origin and the hash path; no origin or no path is no link", () => {
    expect(notifyLink("https://bayon.lan:5173/", "#/inbox")).toBe(
      "https://bayon.lan:5173/#/inbox",
    );
    expect(notifyLink("", "#/inbox")).toBeNull();
    expect(notifyLink("https://bayon.lan", null)).toBeNull();
    expect(notifyLink("https://bayon.lan/app", "#/inbox")).toBeNull();
  });
});

describe("quiet hours", () => {
  test("off when either end is -1 or the window is empty", () => {
    expect(quietOff({ start: -1, end: 7 })).toBe(true);
    expect(quietOff({ start: 22, end: -1 })).toBe(true);
    expect(quietOff({ start: 5, end: 5 })).toBe(true);
    expect(isQuietHour(3, { start: -1, end: -1 })).toBe(false);
  });

  test("a plain window, and one that wraps midnight", () => {
    const day = { start: 9, end: 17 };
    expect([8, 9, 16, 17].map((h) => isQuietHour(h, day))).toEqual([
      false,
      true,
      true,
      false,
    ]);
    const night = { start: 22, end: 7 };
    expect([21, 22, 23, 0, 6, 7].map((h) => isQuietHour(h, night))).toEqual([
      false,
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  test("it ends at the next local end:00, today or tomorrow", () => {
    const hour = new Date(NOW).getHours();
    const q = { start: hour, end: (hour + 2) % 24 };
    expect(isQuiet(NOW, q)).toBe(true);
    const ends = quietEndsAt(NOW + 5 * 60_000, q);
    expect(new Date(ends).getHours()).toBe(q.end);
    expect(new Date(ends).getMinutes()).toBe(0);
    expect(ends - NOW).toBeGreaterThan(60 * 60_000);
    expect(ends - NOW).toBeLessThanOrEqual(2 * 60 * 60_000 + 60 * 60_000);
    expect(isQuiet(ends, q)).toBe(false);
    // Already past today's end hour: tomorrow's.
    const passed = { start: (hour + 23) % 24, end: hour };
    expect(quietEndsAt(NOW + 60_000, passed) - NOW).toBeGreaterThan(
      22 * 60 * 60_000,
    );
  });
});

describe("backoff", () => {
  test("the first send, then five retries at 30 s, 2 m, 10 m, 1 h and 6 h; a sixth failure is final", () => {
    expect(NOTIFY_MAX_ATTEMPTS).toBe(6);
    expect(
      [1, 2, 3, 4, 5].map((attempts) => (retryAt(attempts, 0) ?? 0) / 1_000),
    ).toEqual([30, 120, 600, 3_600, 21_600]);
    expect(retryAt(6, 0)).toBeNull();
    expect(retryAt(0, 0)).toBeNull();
    expect(NOTIFY_BACKOFF_MS).toHaveLength(5);
  });
});

describe("the notification each moment files", () => {
  const request = {
    id: "01REQ",
    kind: "decision",
    question: "Ship it behind a flag?",
    agent: "shop-builder",
    ticket: TICKET,
    workspace_id: "shop",
  };

  test("an agent's question names the agent and the ticket, and links to that ticket's inbox", () => {
    const n = questionNotification(request);
    expect(NewNotification.parse(n)).toEqual({
      event_kind: "question",
      dedupe_key: "request:01REQ",
      workspace_id: "shop",
      ticket_id: "01TICKET",
      title: "shop-builder asked on FRM-12",
      body: "Ship it behind a flag?",
      link_path: "#/p/shop/inbox?ticket=12",
    });
  });

  test("the watchdog's request is its own; one with no ticket or project links to the fleet inbox", () => {
    const n = questionNotification({
      ...request,
      kind: "retry_storm",
      agent: null,
      ticket: null,
      workspace_id: null,
    });
    expect([n.title, n.link_path]).toEqual([
      `${WATCHDOG_ASKER} asked`,
      "#/inbox",
    ]);
    expect(questionNotification({ ...request, agent: null }).title).toBe(
      "An agent asked on FRM-12",
    );
  });

  test("a proposal, a QA hand-over, a block and a Jira failure", () => {
    expect(proposalNotification(request)).toMatchObject({
      event_kind: "staff_proposal",
      dedupe_key: "proposal:01REQ",
      title: "shop-builder proposes staffing FRM-12",
    });
    expect(
      proposalNotification({ ...request, agent: null, ticket: null }).title,
    ).toBe("The orchestrator proposes a staffing");
    expect(qaHumanNotification({ eventId: 7, ticket: TICKET })).toEqual({
      event_kind: "qa_human",
      dedupe_key: "qa_human:7",
      workspace_id: "shop",
      ticket_id: "01TICKET",
      title: "FRM-12 is ready for your QA",
      body: "Add the export",
      link_path: "#/p/shop/tickets?open=ticket:12",
    });
    expect(
      blockNotification({
        auditId: 9,
        ticket: TICKET,
        reason: "3 failed runs",
        question: "Unblock or park?",
      }),
    ).toMatchObject({
      dedupe_key: "blocked:9",
      title: "FRM-12 was blocked",
      body: "3 failed runs\nUnblock or park?",
      link_path: "#/p/shop/inbox?ticket=12",
    });
    expect(
      blockNotification({
        auditId: 9,
        ticket: null,
        reason: "r",
        question: null,
      }),
    ).toMatchObject({
      title: "A ticket was blocked",
      body: "r",
      link_path: "#/inbox",
    });
    expect(
      jiraFailNotification({
        auditId: 4,
        workspaceId: "shop",
        workspaceName: "Shop",
        message: "Jira at acme.atlassian.net answered HTTP 503",
      }),
    ).toMatchObject({
      event_kind: "jira_sync_failed",
      dedupe_key: "jira_sync:4",
      title: "The Jira sync of Shop failed",
      link_path: "#/p/shop/overview",
    });
  });

  test("a runner update notifies once, ever, per (runner, latest)", () => {
    const n = runnerUpdateNotification({
      runner_id: "runner-a",
      current: "0.3.283",
      latest: "0.3.290",
    });
    expect(n).toMatchObject({
      event_kind: "attention",
      dedupe_key: "runner_update:runner-a:0.3.290",
      title: "runner-a 0.3.283 → 0.3.290 available",
      body: "Nothing upgrades itself. Bumping it lapses the runner's certifications.",
      link_path: "#/runners",
    });
    // No day in the key: the same (runner, latest) never files twice.
    expect(
      runnerUpdateNotification({
        runner_id: "runner-a",
        current: "0.3.283",
        latest: "0.3.290",
      }).dedupe_key,
    ).toBe(n.dedupe_key);
  });

  test("a budget and an arm repeat once a UTC day, keyed by the standing row", () => {
    const budget = {
      id: "B1",
      scope: "agent",
      agent: "shop-builder",
      period: "day",
      cap_usd: 5,
      cap_tokens: 1_000,
      warn_pct: 80,
    };
    const b = budgetNotification(budget, NOW);
    expect(b).toMatchObject({
      dedupe_key: "budget_warn:B1:2026-09-22",
      body: "Agent shop-builder's day budget of $5 / 1000 tokens is past 80% spent.",
    });
    expect(budgetNotification(budget, NOW + 86_400_000).dedupe_key).toBe(
      "budget_warn:B1:2026-09-23",
    );
    expect(
      budgetNotification(
        { ...budget, agent: null, cap_usd: null, cap_tokens: null },
        NOW,
      ).body,
    ).toBe("The fleet's day budget is past 80% spent.");

    // One row of an arm: wording, with a ticket's own group ref.
    const kept = armNotification(
      { why: "worktree_kept", ref: "WT1", ticket: TICKET, count: 1 },
      NOW,
    );
    expect(kept).toMatchObject({
      event_kind: "attention",
      dedupe_key: "attention:worktree_kept:-:01TICKET:2026-09-22",
      title: "A worktree is kept for you to decide on FRM-12",
      link_path: "#/p/shop/tickets?open=ticket:12",
    });
    expect(
      armNotification(
        { why: "executor_unhealthy", ref: "local", ticket: null, count: 1 },
        NOW,
      ),
    ).toMatchObject({
      dedupe_key: "attention:executor_unhealthy:local:-:2026-09-22",
      title: "Executor local is unhealthy",
      link_path: "#/executors",
    });
    expect(
      armNotification(
        { why: "backup_failed", ref: "K1", ticket: null, count: 1 },
        NOW,
      ).link_path,
    ).toBe("#/");
    expect(
      armNotification(
        { why: "unanswered_human", ref: "R1", ticket: TICKET, count: 1 },
        NOW,
      ).link_path,
    ).toBe("#/p/shop/inbox?ticket=12");
    expect(
      armNotification(
        { why: "worktree_dirty", ref: "W", ticket: null, count: 1 },
        NOW,
      ).link_path,
    ).toBe("#/");
    for (const why of ["worktree_dirty", "export_failed"])
      expect(
        armNotification({ why, ref: "markdown", ticket: TICKET, count: 1 }, NOW)
          .title,
      ).toContain("FRM-12");
    // An arm added later still notifies, by its name.
    expect(
      armNotification(
        { why: "brand_new_arm", ref: "X", ticket: null, count: 1 },
        NOW,
      ).title,
    ).toBe("brand_new_arm needs you");
  });

  test("text is capped, control characters dropped, and a surrogate pair never split", () => {
    const n = questionNotification({
      ...request,
      question: `a\u0000b\u0007c\n${"x".repeat(2_000)}`,
      agent: "y".repeat(500),
    });
    expect(n.body.startsWith("abc\n")).toBe(true);
    expect(n.body).toHaveLength(NOTIFY_BODY_MAX);
    expect(n.body.endsWith("…")).toBe(true);
    expect(n.title).toHaveLength(NOTIFY_TITLE_MAX);
    expect(NewNotification.safeParse(n).success).toBe(true);
    const emoji = capText(`${"a".repeat(8)}😀b`, 10);
    expect(emoji).toBe(`${"a".repeat(8)}…`);
    expect(capText("short", 10)).toBe("short");
  });

  test("a title is one line whatever the agent's name held; the body keeps its lines", () => {
    const n = questionNotification({
      ...request,
      agent: "evil\r\nBcc: x@evil.test",
      question: "one\ntwo",
    });
    expect(n.title).toBe("evil Bcc: x@evil.test asked on FRM-12");
    expect(n.body).toBe("one\ntwo");
  });

  test("links: the inbox and a ticket, fleet-wide or a project's, its id encoded", () => {
    expect(inboxLink(null, null)).toBe("#/inbox");
    expect(inboxLink("a b", 3)).toBe("#/p/a%20b/inbox?ticket=3");
    expect(ticketLink({ ...TICKET, workspace_id: null })).toBe("#/tickets/12");
    expect(utcDay(NOW)).toBe("2026-09-22");
  });

  test("the writer's schema refuses a path that is not a GUI hash", () => {
    const n = qaHumanNotification({ eventId: 1, ticket: TICKET });
    expect(
      NewNotification.safeParse({ ...n, link_path: "https://evil.test" })
        .success,
    ).toBe(false);
    expect(
      NewNotification.safeParse({ ...n, body: "x".repeat(1_001) }).success,
    ).toBe(false);
  });
});

describe("the attention arms, grouped", () => {
  const other: NotifyTicket = {
    ...TICKET,
    id: "01OTHER",
    key: "FRM-13",
    num: 13,
  };
  const question = (ref: string, ticket: NotifyTicket | null): ArmRow => ({
    why: "unanswered_human",
    ref,
    ticket,
  });

  test("three questions on one ticket are one notification that says three", () => {
    const grouped = groupArms([
      question("R1", TICKET),
      question("R2", TICKET),
      question("R3", TICKET),
    ]);
    expect(grouped).toEqual([
      { why: "unanswered_human", ref: "R1", ticket: TICKET, count: 3 },
    ]);
    const filed = grouped.map((m) => armNotification(m, NOW));
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({
      event_kind: "attention",
      title: "3 questions have waited over a day on FRM-12",
      link_path: "#/p/shop/inbox?ticket=12",
    });
  });

  test("the grouped key does not move when another row joins the group", () => {
    const key = (rows: readonly ArmRow[]) =>
      groupArms(rows).map((m) => armNotification(m, NOW).dedupe_key);
    expect(key([question("R1", TICKET)])).toEqual([
      "attention:unanswered_human:-:01TICKET:2026-09-22",
    ]);
    // A fourth question the same day must not mint a fourth notification.
    expect(
      key([
        question("R1", TICKET),
        question("R2", TICKET),
        question("R3", TICKET),
        question("R4", TICKET),
      ]),
    ).toEqual(["attention:unanswered_human:-:01TICKET:2026-09-22"]);
  });

  test("two tickets stay two, and an arm with no ticket stays one per ref", () => {
    expect(
      groupArms([question("R1", TICKET), question("R2", other)]).map(
        (m) => m.count,
      ),
    ).toEqual([1, 1]);
    const executors = groupArms([
      { why: "executor_unhealthy", ref: "local", ticket: null },
      { why: "executor_unhealthy", ref: "box", ticket: null },
    ]);
    expect(executors.map((m) => armNotification(m, NOW).title)).toEqual([
      "Executor local is unhealthy",
      "Executor box is unhealthy",
    ]);
  });

  test("one arm never gathers another's rows", () => {
    expect(armGroup(question("R1", TICKET))).not.toBe(
      armGroup({ why: "worktree_dirty", ref: "R1", ticket: TICKET }),
    );
    expect(
      groupArms([
        question("R1", TICKET),
        { why: "worktree_dirty", ref: "W1", ticket: TICKET },
      ]),
    ).toHaveLength(2);
  });

  test("a plural title for every arm that can gather", () => {
    const titles = (why: string, count: number) =>
      armNotification({ why, ref: "X", ticket: TICKET, count }, NOW).title;
    expect(titles("worktree_dirty", 2)).toBe(
      "2 worktrees with uncommitted work are kept on FRM-12",
    );
    expect(titles("worktree_kept", 2)).toBe(
      "2 worktrees are kept for you to decide on FRM-12",
    );
    expect(titles("export_failed", 2)).toBe("2 exports failed on FRM-12");
    expect(titles("brand_new_arm", 2)).toBe(
      "2 brand_new_arm need you on FRM-12",
    );
  });
});

describe("the destination-change alert", () => {
  test("it names the field and both values, and links to the settings", () => {
    const alert = destinationChangedNotification({
      field: "email_to",
      from: "old@example.test",
      to: "new@example.test",
      auditId: 41,
    });
    expect(alert).toMatchObject({
      event_kind: "attention",
      dedupe_key: "notify_config:email_to:41",
      workspace_id: null,
      ticket_id: null,
      link_path: "#/settings/notifications",
    });
    expect(alert.title).toContain("the email recipient");
    expect(alert.body).toContain("old@example.test");
    expect(alert.body).toContain("new@example.test");
    expect(NewNotification.safeParse(alert).success).toBe(true);
  });

  test("an unset value reads as words, and each change has its own key", () => {
    const set = destinationChangedNotification({
      field: "base_url",
      from: "",
      to: "https://bayon.example.test",
      auditId: 7,
    });
    expect(set.body).toContain("was not set");
    expect(set.dedupe_key).toBe("notify_config:base_url:7");
    const unset = destinationChangedNotification({
      field: "base_url",
      from: "https://bayon.example.test",
      to: "",
      auditId: 8,
    });
    expect(unset.body).toContain("is now not set");
    expect(unset.dedupe_key).not.toBe(set.dedupe_key);
  });
});

describe("the config door's body", () => {
  test("those three names only", () => {
    expect(NOTIFY_CONFIG_FIELDS).toEqual([
      "email_to",
      "email_from",
      "base_url",
    ]);
    expect(NOTIFY_CONFIG_KEY.email_to).toBe(NOTIFY_EMAIL_TO_KEY);
    expect(NOTIFY_CONFIG_KEY.base_url).toBe(NOTIFY_BASE_URL_KEY);
    expect(
      NotifyConfigPatch.safeParse({ email_to: "a@example.test" }).success,
    ).toBe(true);
    // Any other key, and the whole body is refused before a row is read.
    expect(
      NotifyConfigPatch.safeParse({ "admission.require_certified": 0 }).success,
    ).toBe(false);
    expect(
      NotifyConfigPatch.safeParse({
        email_to: "a@example.test",
        "notify.poll_ms": 5_000,
      }).success,
    ).toBe(false);
    expect(NotifyConfigPatch.safeParse({}).success).toBe(false);
  });

  test("each value is checked by the schema the shell door uses", () => {
    expect(
      NotifyConfigPatch.safeParse({ email_to: "not-an-address" }).success,
    ).toBe(false);
    // An origin only: a path, a query or userinfo is refused (§14, SSRF and phishing).
    for (const base_url of [
      "https://bayon.example.test/inbox",
      "https://bayon.example.test?x=1",
      "https://u:p@bayon.example.test",
      "ftp://bayon.example.test",
    ])
      expect(NotifyConfigPatch.safeParse({ base_url }).success).toBe(false);
    expect(
      NotifyConfigPatch.safeParse({
        base_url: "https://bayon.example.test:5173",
      }).success,
    ).toBe(true);
    // "" unsets each.
    expect(
      NotifyConfigPatch.safeParse({ email_to: "", base_url: "" }).success,
    ).toBe(true);
  });
});
