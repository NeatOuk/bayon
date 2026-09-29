import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { InboxScreen } from "@/inbox/inbox-screen";
import { inboxItem, inboxPage } from "@/test/inbox-fixtures";
import { watchReactWarnings } from "@/test/console-errors";
import { pushFeed } from "@/test/push-feed";
import {
  apiError,
  bodyOf,
  callsTo,
  renderWithProviders,
  stubFetch,
} from "@/test/render";

const OPEN = "/api/v1/inbox?status=open";
const ANSWERED = "/api/v1/inbox?status=answered";
const ANSWER = "/api/v1/inbox/h1/answer";
const T0 = 1_800_000_000_000;

test("it says it is loading, then lists the open requests with their ticket, session and context", async () => {
  stubFetch({
    [OPEN]: inboxPage([
      inboxItem({
        id: "h1",
        question: "Use the ledger lock?",
        context_md: "The **guard** fails.",
      }),
    ]),
  });
  renderWithProviders(<InboxScreen />);
  expect(screen.getByRole("status").textContent).toBe("Loading the inbox…");
  const open = await screen.findByRole("region", { name: "open requests" });
  expect(
    within(open).getByRole("heading", {
      level: 3,
      name: "Use the ledger lock?",
    }),
  ).toBeTruthy();
  expect(within(open).getByText("guard")).toBeTruthy();
  // The ticket heads its group: its number links to it, its title beside it.
  const group = within(open).getByRole("region", {
    name: "#812 transfer idempotency",
  });
  expect(
    within(group).getByRole("link", { name: "#812" }).getAttribute("href"),
  ).toBe("#/tickets/812");
  expect(
    within(open).getByRole("link", { name: "builder-1" }).getAttribute("href"),
  ).toBe("#/sessions/s1");
  // The session's state beside it, as the status map reads it.
  expect(within(open).getByText("Running").dataset.tone).toBe("info");
});

test("an empty inbox says nothing needs you", async () => {
  stubFetch({ [OPEN]: inboxPage([]) });
  renderWithProviders(<InboxScreen />);
  expect(await screen.findByText("Nothing needs you")).toBeTruthy();
});

test("a failed read says so", async () => {
  stubFetch({ [OPEN]: () => apiError(500, "internal", "db down") });
  renderWithProviders(<InboxScreen />);
  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("The inbox is unavailable")).toBeTruthy();
  expect(within(alert).getByText("db down")).toBeTruthy();
});

test("an answer posts, closes the dialog and refetches: the request moves to answered", async () => {
  let answered = false;
  const done = inboxItem({
    id: "h1",
    status: "answered",
    answer: "yes",
    answered_by: "operator",
    answered_at: T0,
  });
  const fetchMock = stubFetch({
    [OPEN]: () =>
      inboxPage(
        answered ? [] : [inboxItem({ id: "h1", options: ["yes", "no"] })],
      ),
    [ANSWERED]: () => inboxPage(answered ? [done] : []),
    [ANSWER]: () => {
      answered = true;
      return done;
    },
  });
  const user = userEvent.setup();
  renderWithProviders(<InboxScreen />);
  await user.click(await screen.findByRole("button", { name: "Answer" }));
  const dialog = screen.getByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "yes" }));
  await user.click(within(dialog).getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(callsTo(fetchMock, ANSWER, "POST")).toHaveLength(1),
  );
  expect(bodyOf(fetchMock, ANSWER, "POST")).toEqual({ answer: "yes" });
  expect(await screen.findByText("Nothing needs you")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(
    await screen.findByRole("status", { name: "Answer sent" }),
  ).toBeTruthy();

  await user.click(screen.getByRole("tab", { name: "Answered" }));
  expect(await screen.findByText("Answer: yes")).toBeTruthy();
});

test("a 409 says someone answered first, and refetches the inbox", async () => {
  let taken = false;
  const fetchMock = stubFetch({
    [OPEN]: () =>
      inboxPage(taken ? [] : [inboxItem({ id: "h1", question: "Ship it?" })]),
    [ANSWER]: () => {
      taken = true;
      return apiError(409, "conflict", "already answered");
    },
  });
  const user = userEvent.setup();
  renderWithProviders(<InboxScreen />);
  await user.click(await screen.findByRole("button", { name: "Answer" }));
  await user.type(screen.getByLabelText("Your answer"), "no");
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    '"Ship it?" was answered before yours reached the server',
  );
  expect(await screen.findByText("Nothing needs you")).toBeTruthy();
  expect(callsTo(fetchMock, OPEN).length).toBeGreaterThanOrEqual(2);
});

test("a retryable 409 keeps the dialog and shows the server's reason, not 'answered first'", async () => {
  // Approving a staffing proposal whose agent is busy: the request stays open.
  const reason =
    "proposal h1 cannot be staffed now (no_agent); it stays open — approve it again later, or reject it";
  stubFetch({
    [OPEN]: inboxPage([inboxItem({ id: "h1", question: "Staff FRM-1?" })]),
    [ANSWER]: () =>
      Response.json(
        { error: { class: "conflict", message: reason, retryable: true } },
        { status: 409 },
      ),
  });
  const user = userEvent.setup();
  renderWithProviders(<InboxScreen />);
  await user.click(await screen.findByRole("button", { name: "Answer" }));
  await user.type(screen.getByLabelText("Your answer"), "approve");
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect((await screen.findByRole("alert")).textContent).toBe(reason);
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.queryByText(/answered before yours/)).toBeNull();
});

test("an empty answer never reaches the server", async () => {
  const fetchMock = stubFetch({ [OPEN]: inboxPage([inboxItem({ id: "h1" })]) });
  const user = userEvent.setup();
  renderWithProviders(<InboxScreen />);
  await user.click(await screen.findByRole("button", { name: "Answer" }));
  await user.type(screen.getByLabelText("Your answer"), "   ");
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Write an answer of 1 to 4000 characters.",
  );
  expect(callsTo(fetchMock, ANSWER, "POST")).toHaveLength(0);
});

test("an inbox frame replaces the open list", async () => {
  stubFetch({ [OPEN]: inboxPage([]) });
  const { feed, pushInbox } = pushFeed();
  renderWithProviders(<InboxScreen />, { feed });
  await screen.findByText("Nothing needs you");
  pushInbox(inboxPage([inboxItem({ id: "h9", question: "Merge now?" })]));
  expect(await screen.findByText("Merge now?")).toBeTruthy();
});

test("more pages load on the keyset cursor", async () => {
  stubFetch({
    [OPEN]: inboxPage([inboxItem({ id: "h1", question: "first?" })], "c1"),
    [`${OPEN}&cursor=c1`]: inboxPage([
      inboxItem({ id: "h2", question: "second?" }),
    ]),
  });
  const user = userEvent.setup();
  renderWithProviders(<InboxScreen />);
  await screen.findByText("first?");
  await user.click(screen.getByRole("button", { name: "Load more" }));
  expect(await screen.findByText("second?")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
});

// where a ticket's "needs human" badge goes — its requests only, with a way back to all.
test.each([
  [undefined, "/api/v1/inbox?status=open&ticket=812", "#/inbox"],
  [
    "shop",
    "/api/v1/inbox?status=open&project=shop&ticket=812",
    "#/p/shop/inbox",
  ],
])(
  "one ticket's requests (project %s): the server filters, and Show all goes back",
  async (project, url, all) => {
    stubFetch({
      [url]: inboxPage([inboxItem({ id: "h1", question: "Keep v1?" })]),
    });
    renderWithProviders(<InboxScreen project={project} ticket={812} />);
    const open = await screen.findByRole("region", {
      name: "open requests",
    });
    expect(within(open).getByText("Keep v1?")).toBeTruthy();
    expect(screen.getByText(/Only ticket #812's requests\./)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Show all" }).getAttribute("href"),
    ).toBe(all);
  },
);

// a question that no longer matters is dismissed, not answered with something invented.
test("Dismiss asks first, then posts; Cancel posts nothing; the Dismissed tab shows it; a proposal has none", async () => {
  let dismissed = false;
  const DISMISS = "/api/v1/inbox/h1/dismiss";
  const gone = inboxItem({
    id: "h1",
    question: "Retire v1 first?",
    status: "dismissed",
    answered_by: "operator",
    answered_at: T0,
  });
  const fetchMock = stubFetch({
    [OPEN]: () =>
      inboxPage(
        dismissed
          ? []
          : [
              inboxItem({ id: "h1", question: "Retire v1 first?" }),
              inboxItem({
                id: "p1",
                kind: "staff_approval",
                question: "Staff #812 with builder-1?",
              }),
            ],
      ),
    "/api/v1/inbox?status=dismissed": () => inboxPage(dismissed ? [gone] : []),
    [DISMISS]: () => {
      dismissed = true;
      return gone;
    },
  });
  const user = userEvent.setup();
  renderWithProviders(<InboxScreen />);
  const open = await screen.findByRole("region", { name: "open requests" });
  const [question, proposal] = within(open).getAllByRole("listitem");
  if (question === undefined || proposal === undefined)
    throw new Error("two rows");
  expect(
    within(proposal).queryByRole("button", { name: "Dismiss" }),
  ).toBeNull();

  await user.click(within(question).getByRole("button", { name: "Dismiss" }));
  expect(await screen.findByRole("alertdialog")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(callsTo(fetchMock, DISMISS, "POST")).toHaveLength(0);

  await user.click(within(question).getByRole("button", { name: "Dismiss" }));
  await user.click(
    await screen.findByRole("button", { name: "Dismiss question" }),
  );
  await waitFor(() =>
    expect(callsTo(fetchMock, DISMISS, "POST")).toHaveLength(1),
  );
  await waitFor(() =>
    expect(screen.queryByText("Retire v1 first?")).toBeNull(),
  );
  await user.click(screen.getByRole("tab", { name: "Dismissed" }));
  expect(
    await screen.findByText("Dismissed as no longer relevant"),
  ).toBeTruthy();
});

// a wall of questions becomes one group per ticket, newest first, each question a
// heading-weight line with its facts under it.
test("requests are grouped by ticket, the newest group and question first, each group counted", async () => {
  const other = {
    id: "ticket-9",
    num: 9,
    title: "guest basket",
    status: "code_review",
  };
  stubFetch({
    [OPEN]: inboxPage([
      inboxItem({ id: "h1", question: "Old on 812?", asked_at: T0 }),
      inboxItem({
        id: "h2",
        question: "On 9?",
        ticket: other,
        asked_at: T0 + 5_000,
      }),
      inboxItem({ id: "h3", question: "New on 812?", asked_at: T0 + 9_000 }),
      inboxItem({
        id: "h4",
        question: "No ticket?",
        ticket: null,
        asked_at: T0 + 1_000,
      }),
    ]),
  });
  renderWithProviders(<InboxScreen />);
  const open = await screen.findByRole("region", { name: "open requests" });
  const groups = within(open).getAllByRole("region");
  expect(groups.map((g) => g.getAttribute("aria-labelledby") !== null)).toEqual(
    [true, true, true],
  );
  expect(
    within(open)
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.textContent),
  ).toEqual([
    "#812 transfer idempotency",
    "#9 guest basket",
    "Not about a ticket",
  ]);
  expect(
    within(open)
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent),
  ).toEqual(["New on 812?", "Old on 812?", "On 9?", "No ticket?"]);
  expect(within(groups[0] as HTMLElement).getByText("2").textContent).toBe(
    "2 requests",
  );
});

test("a recommendation is called out; the meta row reads kind, age and asker, with the session's id", async () => {
  stubFetch({
    [OPEN]: inboxPage([
      inboxItem({
        id: "h1",
        kind: "decision",
        context_md: "Recommendation: Keep v1 for a week",
        session: {
          id: "01K5Z9Q2B7XJ4M0NBUILD00001",
          agent: "builder-1",
          role: "builder",
          state: "running",
        },
      }),
    ]),
  });
  renderWithProviders(<InboxScreen />);
  const open = await screen.findByRole("region", { name: "open requests" });
  const recommended = within(open)
    .getByText("Recommendation:")
    .closest<HTMLElement>("[data-slot=recommendation]");
  expect(recommended?.textContent).toBe("Recommendation: Keep v1 for a week");
  expect(recommended?.className).toContain("bg-info-subtle");
  const meta = open.querySelector("[data-slot=inbox-meta]") as HTMLElement;
  expect(within(meta).getByText("Decision")).toBeTruthy();
  expect(
    within(meta)
      .getByText(/^asked /)
      .getAttribute("title"),
  ).toMatch(/ UTC$/);
  expect(
    within(meta).getByRole("link", { name: "builder-1" }).getAttribute("href"),
  ).toBe("#/sessions/01K5Z9Q2B7XJ4M0NBUILD00001");
  // The session's id, shortened, whole for a screen reader and on hover.
  expect(within(meta).getByTitle("01K5Z9Q2B7XJ4M0NBUILD00001")).toBeTruthy();
});

test("picking an option chip starts the answer from it; Send still decides", async () => {
  const fetchMock = stubFetch({
    [OPEN]: inboxPage([
      inboxItem({
        id: "h1",
        options: ["Keep v1", "Remove v1"],
        context_md: "Recommendation: Keep v1",
      }),
    ]),
    [ANSWER]: inboxItem({ id: "h1", status: "answered", answer: "Remove v1" }),
  });
  const user = userEvent.setup();
  renderWithProviders(<InboxScreen />);
  const options = await screen.findByRole("group", { name: "options" });
  await user.click(within(options).getByRole("button", { name: "Remove v1" }));
  expect(callsTo(fetchMock, ANSWER, "POST")).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "Answer" }));
  expect(
    (screen.getByLabelText("Your answer") as HTMLTextAreaElement).value,
  ).toBe("Remove v1");
  // The dialog calls out the recommendation in the card's words.
  expect(
    within(screen.getByRole("dialog"))
      .getByText("Recommendation:")
      .closest("[data-slot=recommendation]")?.textContent,
  ).toBe("Recommendation: Keep v1");
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() =>
    expect(callsTo(fetchMock, ANSWER, "POST")).toHaveLength(1),
  );
  expect(bodyOf(fetchMock, ANSWER, "POST")).toEqual({ answer: "Remove v1" });
});

test("a long question is clamped to three lines, and Show more opens it", async () => {
  const long = `Store the key in the ledger table? ${"More words here. ".repeat(20)}`;
  stubFetch({ [OPEN]: inboxPage([inboxItem({ id: "h1", question: long })]) });
  const user = userEvent.setup();
  renderWithProviders(<InboxScreen />);
  const heading = await screen.findByRole("heading", { level: 3 });
  expect(heading.className).toContain("line-clamp-3");
  await user.click(screen.getByRole("button", { name: "Show more" }));
  expect(heading.className).not.toContain("line-clamp-3");
  expect(
    screen
      .getByRole("button", { name: "Show less" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
});

test("an empty tab has a way on", async () => {
  stubFetch({ [OPEN]: inboxPage([]) });
  renderWithProviders(<InboxScreen />);
  await screen.findByText("Nothing needs you");
  expect(
    screen
      .getByRole("link", { name: "Back to the Fleet" })
      .getAttribute("href"),
  ).toBe("#/");
});

test("switching tabs rewrites ?tab= and logs no React scheduling warning", async () => {
  window.location.hash = "#/inbox";
  stubFetch({
    [OPEN]: inboxPage([inboxItem({ id: "h1" })]),
    [ANSWERED]: inboxPage([]),
    "/api/v1/inbox?status=dismissed": inboxPage([]),
  });
  renderWithProviders(<InboxScreen />);
  await screen.findByRole("region", { name: "open requests" });
  const warnings = watchReactWarnings();
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Answered" }));
  expect(window.location.hash).toBe("#/inbox?tab=answered");
  await user.click(screen.getByRole("tab", { name: "Dismissed" }));
  await screen.findByText("Nothing dismissed");
  await user.click(screen.getByRole("tab", { name: "Open" }));
  expect(window.location.hash).toBe("#/inbox");
  await act(async () => undefined);
  expect(warnings()).toEqual([]);
  window.location.hash = "";
});
