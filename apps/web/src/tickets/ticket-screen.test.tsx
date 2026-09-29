import type { TicketEventView, TransitionOption } from "@bayon/proto";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { createQueryClient } from "@/api/query-client";
import { FeedProvider, type Feed } from "@/feed/feed";
import { sessionView } from "@/test/fixtures";
import { inboxItem, inboxPage } from "@/test/inbox-fixtures";
import {
  bodyOf,
  callsTo,
  renderWithProviders,
  silentFeed,
  stubFetch,
} from "@/test/render";
import {
  ZERO_ECONOMICS,
  finding,
  gateView,
  handoffView,
  ticketDetail,
  ticketEvent,
  ticketView,
} from "@/test/ticket-fixtures";
import { TicketScreen } from "@/tickets/ticket-screen";

const DETAIL = "/api/v1/tickets/812";
const TRANSITION = `${DETAIL}/transition`;

type FetchMock = ReturnType<typeof stubFetch>;

const calls = (fetchMock: FetchMock, url: string, method = "GET") =>
  fetchMock.mock.calls.filter(
    ([input, init]) =>
      String(input) === url && (init?.method ?? "GET") === method,
  );

const sent = (fetchMock: FetchMock, url: string, method: string) => {
  const [, init] = calls(fetchMock, url, method)[0] ?? [];
  return {
    ifMatch: new Headers(init?.headers).get("If-Match"),
    body: JSON.parse((init?.body as string | undefined) ?? "null") as unknown,
  };
};

const TICKET = ticketView({
  num: 812,
  title: "transfer idempotency",
  status: "code_review",
  version: 3,
  needs_human: true,
  complexity_tier: "complex",
  complexity_score: 9,
});

const REQUEST_FIX: TransitionOption = {
  to: "review_fix",
  rule: "request_fix",
  allowed: true,
};
const PASS_REVIEW: TransitionOption = {
  to: "qa_harness",
  rule: "pass_review",
  allowed: false,
  reason: "facts_unavailable",
  detail: "code_review gate facts land in M3",
};

const conflict = (currentVersion: number) =>
  Response.json(
    {
      error: {
        class: "conflict",
        message: "stale",
        retryable: false,
        current_version: currentVersion,
      },
    },
    { status: 409 },
  );

test("the detail shows the ticket, its gates, findings, hand-off chain and economics", async () => {
  stubFetch({
    [DETAIL]: ticketDetail(TICKET, {
      gates: [
        gateView({
          kind: "code_review",
          state: "failed",
          findings_total: 2,
          findings_unresolved: 1,
          findings: [
            finding({
              summary: "idempotency guard missing",
              severity: "blocker",
              file: "src/transfer.ts",
              line: 42,
            }),
          ],
        }),
      ],
      economics: {
        ...ZERO_ECONOMICS,
        cost_usd: 6.3,
        review_rounds: 1,
        sessions: 2,
        tokens: 1_200,
        cache_ratio: 0.71,
      },
    }),
  });
  renderWithProviders(<TicketScreen num={812} />);
  expect(
    await screen.findByRole("heading", {
      name: /FRM-812.*transfer idempotency/,
    }),
  ).toBeTruthy();
  expect(screen.getByText("Needs human")).toBeTruthy();
  expect(screen.getByText(/complex \(score 9\)/)).toBeTruthy();
  expect(screen.getByText("1 review round")).toBeTruthy();

  const gates = screen.getByRole("region", { name: "gates" });
  expect(within(gates).getByText("code_review")).toBeTruthy();
  expect(within(gates).getByText("Failed")).toBeTruthy();
  expect(within(gates).getByText("1 open of 2 findings")).toBeTruthy();
  const findings = screen.getByRole("region", { name: "findings" });
  expect(within(findings).getByText("idempotency guard missing")).toBeTruthy();
  expect(within(findings).getByText("src/transfer.ts:42")).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "hand-offs" })).getByText(
      /no hand-offs yet/i,
    ),
  ).toBeTruthy();
  const economics = screen.getByRole("region", { name: "economics" });
  expect(within(economics).getByText(/6\.30/)).toBeTruthy();
  expect(within(economics).getByText("71%")).toBeTruthy();
});

test("the hand-off chain lists each hand-off in order", async () => {
  stubFetch({
    [DETAIL]: ticketDetail(TICKET, {
      handoffs: [
        handoffView({ id: "h1", reason: "phase", accepted_at: 1 }),
        handoffView({ id: "h2", reason: "context_ceiling" }),
      ],
    }),
  });
  renderWithProviders(<TicketScreen num={812} />);
  const chain = await screen.findByRole("region", { name: "hand-offs" });
  const items = within(chain).getAllByRole("listitem");
  expect(items.map((li) => li.textContent)).toEqual([
    expect.stringMatching(/#1 Phase.*accepted/),
    expect.stringMatching(/#2 Context ceiling.*not accepted/),
  ]);
});

test("a disallowed action shows the rule that refuses it; an allowed one posts with If-Match", async () => {
  const fetchMock = stubFetch({
    [DETAIL]: ticketDetail(TICKET, { transitions: [REQUEST_FIX, PASS_REVIEW] }),
    [TRANSITION]: ticketView({ ...TICKET, status: "review_fix", version: 4 }),
  });
  renderWithProviders(<TicketScreen num={812} />);
  const user = userEvent.setup();
  const actions = await screen.findByRole("region", { name: "actions" });
  const refused = within(actions).getByRole("button", {
    name: "Move to QA harness",
  }) as HTMLButtonElement;
  expect(refused.disabled).toBe(true);
  expect(within(actions).getByText(/refused by pass_review/).textContent).toBe(
    "refused by pass_review (facts_unavailable): code_review gate facts land in M3",
  );

  await user.click(
    within(actions).getByRole("button", { name: "Move to Review fix" }),
  );
  await waitFor(() =>
    expect(calls(fetchMock, TRANSITION, "POST")).toHaveLength(1),
  );
  expect(sent(fetchMock, TRANSITION, "POST")).toEqual({
    ifMatch: '"3"',
    body: { to: "review_fix" },
  });
});

test("a 409 refetches the ticket and says it moved on", async () => {
  let version = 3;
  const fetchMock = stubFetch({
    [DETAIL]: () =>
      ticketDetail(
        ticketView({
          ...TICKET,
          version,
          status: version === 3 ? "code_review" : "review_fix",
        }),
        { transitions: [REQUEST_FIX] },
      ),
    [TRANSITION]: () => {
      version = 4;
      return conflict(4);
    },
  });
  renderWithProviders(<TicketScreen num={812} />);
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Move to Review fix" }),
  );
  expect(
    await screen.findByText(/changed while you were looking \(now v4\)/),
  ).toBeTruthy();
  expect(calls(fetchMock, DETAIL).length).toBeGreaterThanOrEqual(2);
  expect(await screen.findByText("Review fix")).toBeTruthy();
});

test("a law refusal on submit shows the rule, the reason and the detail", async () => {
  stubFetch({
    [DETAIL]: ticketDetail(TICKET, {
      transitions: [
        {
          to: "plan_review",
          rule: "submit_plan",
          allowed: true,
          deferred: ["no_source_changes"],
        },
      ],
    }),
    [TRANSITION]: Response.json(
      {
        error: {
          class: "law_refused",
          message: "submit_plan: src/x.ts changed",
          retryable: false,
          rule: "submit_plan",
          reason: "source_changes",
          detail: "src/x.ts changed",
        },
      },
      { status: 422 },
    ),
  });
  renderWithProviders(<TicketScreen num={812} />);
  const user = userEvent.setup();
  const actions = await screen.findByRole("region", { name: "actions" });
  expect(within(actions).getByText(/checked on submit/)).toBeTruthy();
  await user.click(
    within(actions).getByRole("button", { name: "Move to Plan review" }),
  );
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe(
    "refused by submit_plan (source_changes): src/x.ts changed",
  );
});

test("an action that needs notes collects them before it posts", async () => {
  const fetchMock = stubFetch({
    [DETAIL]: ticketDetail(TICKET, {
      transitions: [{ to: "blocked", rule: "block", allowed: true }],
    }),
    [TRANSITION]: ticketView({ ...TICKET, status: "blocked", version: 4 }),
  });
  renderWithProviders(<TicketScreen num={812} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Block" }));
  const submit = screen.getByRole("button", {
    name: "Move to Blocked",
  }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  await user.type(screen.getByLabelText("Blocked reason"), "waiting on keys");
  expect(submit.disabled).toBe(true);
  await user.type(screen.getByLabelText("Unblock condition"), "keys issued");
  expect(submit.disabled).toBe(false);
  await user.click(submit);
  await waitFor(() =>
    expect(calls(fetchMock, TRANSITION, "POST")).toHaveLength(1),
  );
  expect(sent(fetchMock, TRANSITION, "POST").body).toEqual({
    to: "blocked",
    blocked_reason: "waiting on keys",
    unblock_condition: "keys issued",
  });
});

test("a failed move keeps the notes dialog open, with the notes and the refusal", async () => {
  stubFetch({
    [DETAIL]: ticketDetail(TICKET, {
      transitions: [{ to: "blocked", rule: "block", allowed: true }],
    }),
    [TRANSITION]: Response.json(
      {
        error: {
          class: "law_refused",
          message: "block: not yours",
          retryable: false,
          rule: "block",
          reason: "cross_ticket_write",
          detail: "not yours",
        },
      },
      { status: 422 },
    ),
  });
  renderWithProviders(<TicketScreen num={812} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Block" }));
  await user.type(screen.getByLabelText("Blocked reason"), "waiting on keys");
  await user.type(screen.getByLabelText("Unblock condition"), "keys issued");
  await user.click(screen.getByRole("button", { name: "Move to Blocked" }));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe(
    "refused by block (cross_ticket_write): not yours",
  );
  expect(
    (screen.getByLabelText("Blocked reason") as HTMLTextAreaElement).value,
  ).toBe("waiting on keys");
  expect(screen.getByRole("button", { name: "Move to Blocked" })).toBeTruthy();
});

test("a tickets frame naming this ticket refetches it; one naming another does not", async () => {
  let push:
    ((items: readonly TicketEventView[], cursor: number) => void) | undefined;
  const feed: Feed = {
    ...silentFeed,
    subscribeTickets: (on) => {
      push = on;
      return () => {
        push = undefined;
      };
    },
  };
  let status: "code_review" | "review_fix" = "code_review";
  const fetchMock = stubFetch({
    [DETAIL]: () => ticketDetail(ticketView({ ...TICKET, status })),
  });
  renderWithProviders(<TicketScreen num={812} />, { feed });
  await screen.findByText("Code review");
  const send = (event: TicketEventView) =>
    act(() => {
      if (!push) throw new Error("the tickets topic is not subscribed");
      push([event], event.id);
    });
  send(ticketEvent(8, { ticket_id: "ticket-999" }));
  status = "review_fix";
  send(ticketEvent(9, { ticket_id: TICKET.id }));
  expect(await screen.findByText("Review fix")).toBeTruthy();
  expect(calls(fetchMock, DETAIL)).toHaveLength(2);
});

test("add a law links to the mission of each agent that worked the ticket", async () => {
  stubFetch({
    [DETAIL]: ticketDetail(TICKET, {
      events: {
        items: [
          ticketEvent(1, { actor_kind: "session", actor_id: "s1" }),
          ticketEvent(2, { actor_kind: "operator" }),
          ticketEvent(3, { actor_kind: "session", actor_id: "s1" }),
        ],
        next_cursor: 3,
        has_more: false,
      },
    }),
    "/api/v1/sessions/s1": sessionView({ id: "s1", agent_name: "builder-1" }),
  });
  renderWithProviders(<TicketScreen num={812} />);
  const link = await screen.findByRole("link", {
    name: "add a law · builder-1",
  });
  expect(link.getAttribute("href")).toBe("#/missions/builder-1?section=laws");
});

test("with no session on the ticket, add a law says why there is no agent", async () => {
  stubFetch({ [DETAIL]: ticketDetail(TICKET) });
  renderWithProviders(<TicketScreen num={812} />);
  expect(
    await screen.findByText(/no agent has worked this ticket yet/i),
  ).toBeTruthy();
});

test("the operator clears needs-human with a PATCH that carries If-Match", async () => {
  const fetchMock = stubFetch({
    [DETAIL]: (init: RequestInit | undefined) =>
      init?.method === "PATCH"
        ? ticketView({ ...TICKET, needs_human: false, version: 4 })
        : ticketDetail(TICKET),
  });
  renderWithProviders(<TicketScreen num={812} />);
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Clear needs human" }),
  );
  await waitFor(() =>
    expect(calls(fetchMock, DETAIL, "PATCH")).toHaveLength(1),
  );
  expect(sent(fetchMock, DETAIL, "PATCH")).toEqual({
    ifMatch: '"3"',
    body: { needs_human: false },
  });
});

test.each([
  ["an https URL is a link", "https://github.com/o/r/pull/1", true],
  ["any other scheme stays text", "javascript:alert(1)", false],
])("pull request: %s", async (_name, prUrl, linked) => {
  stubFetch({
    [DETAIL]: ticketDetail(ticketView({ ...TICKET, pr_url: prUrl })),
  });
  renderWithProviders(<TicketScreen num={812} />);
  await screen.findByRole("heading", { name: /FRM-812/ });
  const link = screen.queryByRole("link", { name: /^pull request/ });
  if (linked) expect(link?.getAttribute("href")).toBe(prUrl);
  else {
    expect(link).toBeNull();
    expect(screen.getByText(prUrl)).toBeTruthy();
  }
});

test("a ticket's status reads by the status map: blocked is danger, done the one green", async () => {
  stubFetch({
    [DETAIL]: ticketDetail(
      ticketView({
        ...TICKET,
        status: "blocked",
        blocked_reason: "keys",
        unblock_condition: "keys issued",
      }),
    ),
  });
  renderWithProviders(<TicketScreen num={812} />);
  const heading = await screen.findByRole("heading", {
    level: 1,
    name: /FRM-812/,
  });
  expect(heading.textContent).not.toMatch(/Blocked/);
  const status = screen.getByText("Blocked", { selector: "[data-tone]" });
  expect(status.dataset.tone).toBe("danger");
  expect(status.className).not.toMatch(/success/);
});

test("an unknown ticket says so", async () => {
  stubFetch({});
  renderWithProviders(<TicketScreen num={999} />);
  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("The ticket is unavailable")).toBeTruthy();
  expect(alert.textContent).toMatch(/not_found/);
  expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
});

// the browser handed back a body cached before `next_step` existed. Under the app's own
// QueryClient (not the tests' retry-free one) the schema's refusal is final: it shows at once, after
// one request, instead of "loading the ticket…" through three retries a hidden tab pauses.
const renderWithAppClient = (num: number) =>
  render(
    <QueryClientProvider client={createQueryClient()}>
      <FeedProvider feed={silentFeed}>
        <TicketScreen num={num} />
      </FeedProvider>
    </QueryClientProvider>,
  );

test("a body the schema rejects shows the refusal at once, with no retry", async () => {
  const stale = Object.fromEntries(
    Object.entries(ticketDetail(TICKET)).filter(([key]) => key !== "next_step"),
  );
  const fetchMock = stubFetch({ [DETAIL]: stale });
  renderWithAppClient(812);
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /unexpected response from \/tickets\/812/,
  );
  expect(screen.queryByText(/loading the ticket/i)).toBeNull();
  expect(calls(fetchMock, DETAIL)).toHaveLength(1);
});

test("a failure that will be retried says so while the ticket loads", async () => {
  stubFetch({ [DETAIL]: () => new Response("bad gateway", { status: 502 }) });
  renderWithAppClient(812);
  expect(
    await screen.findByText(
      "Loading the ticket… retrying after internal: HTTP 502 from /tickets/812",
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

// the owner saw "needs human" on FRM-82 and did not know where to answer. The ticket
// view lists its open questions, each with the Inbox's own Answer dialog, and the badge goes to the
// Inbox filtered to the ticket.
const QUESTIONS = "/api/v1/inbox?status=open&ticket=812";

test("the ticket lists its open questions and answers one in place; the last answer clears the badge", async () => {
  let answered = false;
  const question = inboxItem({
    id: "h1",
    kind: "decision",
    question: "Keep v1 routes until the log check is confirmed?",
    context_md: "Recommendation: **yes**",
    options: ["yes", "no"],
  });
  const fetchMock = stubFetch({
    [DETAIL]: () =>
      ticketDetail(
        ticketView({
          ...TICKET,
          workspace_id: "shop",
          needs_human: !answered,
          version: answered ? 4 : 3,
        }),
      ),
    [QUESTIONS]: () => inboxPage(answered ? [] : [question]),
    "/api/v1/inbox/h1/answer": () => {
      answered = true;
      return inboxItem({ id: "h1", status: "answered", answer: "yes" });
    },
  });
  const user = userEvent.setup();
  renderWithProviders(<TicketScreen num={812} />);
  const panel = await screen.findByRole("region", { name: "open questions" });
  expect(
    within(panel).getByText("Keep v1 routes until the log check is confirmed?"),
  ).toBeTruthy();
  expect(within(panel).getByText("yes", { selector: "strong" })).toBeTruthy();
  expect(
    within(panel)
      .getByRole("link", { name: "Open in the Inbox" })
      .getAttribute("href"),
  ).toBe("#/p/shop/inbox?ticket=812");
  expect(
    screen.getByRole("link", { name: "Needs human" }).getAttribute("href"),
  ).toBe("#/p/shop/inbox?ticket=812");

  await user.click(within(panel).getByRole("button", { name: "Answer" }));
  await user.click(screen.getByRole("button", { name: "yes" }));
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(callsTo(fetchMock, "/api/v1/inbox/h1/answer", "POST")).toHaveLength(
      1,
    ),
  );
  expect(bodyOf(fetchMock, "/api/v1/inbox/h1/answer", "POST")).toEqual({
    answer: "yes",
  });
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "open questions" })).toBeNull(),
  );
  // The last answer cleared needs_human: the ticket is read again and the badge is gone.
  await waitFor(() =>
    expect(screen.queryByRole("link", { name: "Needs human" })).toBeNull(),
  );
});

test("a ticket with no project sends its needs-human badge to the fleet Inbox; no questions, no panel", async () => {
  stubFetch({
    [DETAIL]: ticketDetail(TICKET),
    [QUESTIONS]: inboxPage([]),
  });
  renderWithProviders(<TicketScreen num={812} />);
  const badge = await screen.findByRole("link", { name: "Needs human" });
  expect(badge.getAttribute("href")).toBe("#/inbox?ticket=812");
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "open questions" })).toBeNull(),
  );
});

test("a supervisor's question shows the badge without the flag, and is dismissed from the ticket behind a confirm", async () => {
  let dismissed = false;
  const DISMISS = "/api/v1/inbox/s1/dismiss";
  const fetchMock = stubFetch({
    [DETAIL]: () =>
      ticketDetail(
        ticketView({
          ...TICKET,
          needs_human: false,
          open_questions: dismissed ? 0 : 1,
          workspace_id: "shop",
        }),
      ),
    [QUESTIONS]: () =>
      inboxPage(
        dismissed
          ? []
          : [
              inboxItem({
                id: "s1",
                kind: "split",
                question: "Ticket #812 has 5 hand-offs: split it?",
              }),
              // A staffing proposal is not a question: its own panel answers it.
              inboxItem({
                id: "p1",
                kind: "staff_approval",
                question: "Staff it?",
              }),
            ],
      ),
    [DISMISS]: () => {
      dismissed = true;
      return inboxItem({ id: "s1", status: "dismissed" });
    },
  });
  const user = userEvent.setup();
  renderWithProviders(<TicketScreen num={812} />);
  const panel = await screen.findByRole("region", { name: "open questions" });
  expect(within(panel).queryByText("Staff it?")).toBeNull();
  expect(
    screen.getByRole("link", { name: "Needs human" }).getAttribute("href"),
  ).toBe("#/p/shop/inbox?ticket=812");
  await user.click(within(panel).getByRole("button", { name: "Dismiss" }));
  await user.click(
    await screen.findByRole("button", { name: "Dismiss question" }),
  );
  await waitFor(() =>
    expect(callsTo(fetchMock, DISMISS, "POST")).toHaveLength(1),
  );
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "open questions" })).toBeNull(),
  );
  await waitFor(() =>
    expect(screen.queryByRole("link", { name: "Needs human" })).toBeNull(),
  );
});

// the page reads as the ticket beside what to do with it, and its log as rows.
test("actions, economics and add-a-law sit in the rail; the log reads a move as two statuses and who made it", async () => {
  stubFetch({
    [DETAIL]: ticketDetail(TICKET, {
      transitions: [REQUEST_FIX],
      events: {
        items: [
          ticketEvent(1, {
            kind: "transition",
            from_status: "building",
            to_status: "code_review",
            actor_kind: "session",
            actor_id: "01K5Z9Q2B7XJ4M0NBUILD00001",
            reason: "ready for review",
          }),
        ],
        next_cursor: 1,
        has_more: false,
      },
    }),
  });
  renderWithProviders(<TicketScreen num={812} />);
  const rail = await screen.findByRole("complementary", {
    name: "ticket rail",
  });
  for (const name of ["actions", "economics", "add a law"])
    expect(within(rail).getByRole("region", { name })).toBeTruthy();
  const log = screen.getByRole("region", { name: "events" });
  const [row] = within(log).getAllByRole("listitem");
  const badges = within(row as HTMLElement)
    .getAllByText(/Building|Code review/)
    .map((b) => [b.textContent, b.dataset.tone]);
  expect(badges).toEqual([
    ["Building", "info"],
    ["Code review", "info"],
  ]);
  expect(row?.textContent).toContain("Session");
  expect(row?.textContent).toContain("ready for review");
  expect(
    within(row as HTMLElement).getByTitle("01K5Z9Q2B7XJ4M0NBUILD00001"),
  ).toBeTruthy();
});
