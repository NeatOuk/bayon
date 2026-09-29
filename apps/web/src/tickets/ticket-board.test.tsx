import type { TicketEventView } from "@bayon/proto";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import type { Feed } from "@/feed/feed";
import { renderWithProviders, silentFeed, stubFetch } from "@/test/render";
import {
  ticketEvent,
  ticketSummary,
  ticketsPage,
} from "@/test/ticket-fixtures";
import { TicketBoard } from "@/tickets/ticket-board";

const LIST = "/api/v1/tickets?limit=100";

/** The board's columns: every region but the toasts' (the Toaster is mounted beside every screen). */
const columns = () =>
  screen
    .getAllByRole("region")
    .map((r) => r.getAttribute("aria-label"))
    .filter((name) => name !== "Notifications");

/** The wide columns: those drawn with their cards. */
const wide = () =>
  screen
    .getAllByRole("region")
    .filter((r) => r.dataset.collapsed === undefined)
    .map((r) => r.getAttribute("aria-label"))
    .filter((name) => name !== "Notifications");

/** Every status, in the laws' order, the closed ones last. */
const EVERY_COLUMN = [
  "Backlog",
  "Prioritized",
  "Staffed",
  "Spiking",
  "Plan review",
  "Planned",
  "Building",
  "Code review",
  "Review fix",
  "QA harness",
  "Human QA",
  "Rework",
  "Blocked",
  "Hand-off pending",
  "Done",
  "Parked",
  "Rejected",
  "Split",
];

test("the board groups tickets by status, in the laws' order, with tier and needs-human badges", async () => {
  stubFetch({
    [LIST]: ticketsPage([
      ticketSummary(
        {
          num: 2,
          status: "building",
          needs_human: true,
          complexity_tier: "complex",
        },
        2,
      ),
      ticketSummary({ num: 1, status: "backlog" }),
    ]),
  });
  renderWithProviders(<TicketBoard project={null} />);
  const backlog = await screen.findByRole("region", { name: "Backlog" });
  const card = within(backlog).getByRole("link", { name: /FRM-1/ });
  expect(card.getAttribute("href")).toBe("#/tickets/1");
  const building = screen.getByRole("region", { name: "Building" });
  expect(within(building).getByText("Needs human")).toBeTruthy();
  expect(within(building).getByText("complex")).toBeTruthy();
  expect(within(building).getByText("2 review rounds")).toBeTruthy();
  expect(within(backlog).queryByText("Needs human")).toBeNull();
  expect(within(backlog).queryByText(/review round/)).toBeNull();
  // Every status is a column, always, in the laws' order; only the ones holding a card are wide.
  expect(columns()).toEqual(EVERY_COLUMN);
  expect(wide()).toEqual(["Backlog", "Building"]);
  // Columns read by their human labels, not the stored status: an h2 each, its cards h3 under it.
  expect(
    within(building).getByRole("heading", {
      level: 2,
      name: "Building 1 ticket",
    }),
  ).toBeTruthy();
  expect(
    within(building).getByRole("heading", { level: 3, name: "ticket 2" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("heading", { level: 1, name: "Tickets" }),
  ).toBeTruthy();
});

test("the board pages on while the server has more", async () => {
  stubFetch({
    [LIST]: ticketsPage([ticketSummary({ num: 1 })], true),
    "/api/v1/tickets?cursor=1&limit=100": ticketsPage([
      ticketSummary({ num: 2 }),
    ]),
  });
  renderWithProviders(<TicketBoard project={null} />);
  const backlog = await screen.findByRole("region", { name: "Backlog" });
  await within(backlog).findByRole("link", { name: /FRM-2/ });
  expect(within(backlog).getAllByRole("link")).toHaveLength(2);
});

test("search and the needs-human filter are the server's", async () => {
  stubFetch({
    [LIST]: ticketsPage([
      ticketSummary({ num: 1 }),
      ticketSummary({ num: 2, title: "login flow" }),
    ]),
    "/api/v1/tickets?q=login&limit=100": ticketsPage([
      ticketSummary({ num: 2, title: "login flow" }),
    ]),
    "/api/v1/tickets?q=login&needs_human=1&limit=100": ticketsPage([]),
  });
  renderWithProviders(<TicketBoard project={null} />);
  const user = userEvent.setup();
  await screen.findByRole("link", { name: /FRM-1/ });
  await user.type(screen.getByLabelText("Search tickets"), "login");
  await user.click(screen.getByRole("button", { name: "Search" }));
  await waitFor(() =>
    expect(screen.queryByRole("link", { name: /FRM-1/ })).toBeNull(),
  );
  expect(screen.getByRole("link", { name: /FRM-2/ })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Needs human only" }));
  expect(await screen.findByText(/no tickets match/i)).toBeTruthy();
  // The empty board's way on: clear what narrowed it.
  await user.click(screen.getByRole("button", { name: "Clear the filters" }));
  expect(await screen.findByRole("link", { name: /FRM-1/ })).toBeTruthy();
  expect(
    (screen.getByLabelText("Search tickets") as HTMLInputElement).value,
  ).toBe("");
});

test("a frame on the tickets topic refetches the board", async () => {
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
  let moved = false;
  stubFetch({
    [LIST]: () =>
      ticketsPage([
        ticketSummary({ num: 1, status: moved ? "prioritized" : "backlog" }),
      ]),
  });
  renderWithProviders(<TicketBoard project={null} />, { feed });
  await screen.findByRole("region", { name: "Backlog" });
  moved = true;
  act(() => {
    if (!push) throw new Error("the tickets topic is not subscribed");
    push([ticketEvent(7, { to_status: "prioritized" })], 7);
  });
  await waitFor(() =>
    expect(
      within(screen.getByRole("region", { name: "Prioritized" })).getByRole(
        "link",
        { name: /FRM-1/ },
      ),
    ).toBeTruthy(),
  );
  // The emptied column stays where it was, narrow: the board does not shift.
  expect(
    screen.getByRole("region", { name: "Backlog" }).dataset.collapsed,
  ).toBe("true");
});

test("coming back to the board resumes the tickets topic from its cursor, so history is not replayed", () => {
  const since: number[] = [];
  let push:
    ((items: readonly TicketEventView[], cursor: number) => void) | undefined;
  const feed: Feed = {
    ...silentFeed,
    subscribeTickets: (on, from = 0) => {
      since.push(from);
      push = on;
      return () => {
        push = undefined;
      };
    },
  };
  stubFetch({ [LIST]: ticketsPage([]) });
  const first = renderWithProviders(<TicketBoard project={null} />, { feed });
  act(() => push?.([ticketEvent(7)], 7));
  first.unmount();
  renderWithProviders(<TicketBoard project={null} />, { feed });
  expect(since).toEqual([0, 7]);
});

const WORKSPACES = "/api/v1/workspaces";
const alpha = { workspaces: [{ id: "ws-a", name: "alpha", kind: "single" }] };

test("one project's board asks the server for its tickets only, and New ticket starts in it", async () => {
  stubFetch({
    "/api/v1/tickets?workspace_id=ws-a&limit=100": ticketsPage([
      ticketSummary({ num: 4, workspace_id: "ws-a" }),
    ]),
    [WORKSPACES]: alpha,
  });
  renderWithProviders(<TicketBoard project="ws-a" />);
  const backlog = await screen.findByRole("region", { name: "Backlog" });
  within(backlog).getByRole("link", { name: /FRM-4/ });
  // The filter says which project; no card repeats it.
  expect(within(backlog).queryByLabelText("project alpha")).toBeNull();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "New ticket" }));
  const dialog = await screen.findByRole("dialog");
  await waitFor(() =>
    expect(
      within(dialog).getByRole("combobox", { name: "Project" }).textContent,
    ).toContain("alpha"),
  );
});

test("the whole board names each card's project, and picking one moves to its link", async () => {
  stubFetch({
    [LIST]: ticketsPage([
      ticketSummary({ num: 1, workspace_id: "ws-a" }),
      ticketSummary({ num: 2, workspace_id: null }),
    ]),
    [WORKSPACES]: alpha,
  });
  window.location.hash = "#/tickets";
  renderWithProviders(<TicketBoard project={null} />);
  const backlog = await screen.findByRole("region", { name: "Backlog" });
  await within(backlog).findByLabelText("project alpha");
  expect(within(backlog).getAllByLabelText(/^project /)).toHaveLength(1);
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Project" }));
  await user.click(await screen.findByRole("option", { name: "alpha" }));
  expect(window.location.hash).toBe("#/p/ws-a/tickets");
});

// the badge says where to answer. It is a link of its own beside the card's, never
// inside it: the project's Inbox filtered to the ticket, or the fleet's for a ticket with none.
test("a card's needs-human badge links to its project's Inbox, filtered to the ticket", async () => {
  stubFetch({
    [LIST]: ticketsPage([
      ticketSummary({
        num: 2,
        status: "building",
        needs_human: true,
        workspace_id: "shop",
      }),
      ticketSummary({ num: 3, status: "building", needs_human: true }),
    ]),
  });
  renderWithProviders(<TicketBoard project={null} />);
  const building = await screen.findByRole("region", { name: "Building" });
  const badges = within(building).getAllByRole("link", { name: "Needs human" });
  expect(badges.map((b) => b.getAttribute("href"))).toEqual([
    "#/p/shop/inbox?ticket=2",
    "#/inbox?ticket=3",
  ]);
  // Not nested in the card's own link.
  for (const badge of badges) {
    expect(badge.parentElement?.closest("a") ?? null).toBeNull();
  }
  expect(
    within(building).getByRole("link", { name: /FRM-2/ }).getAttribute("href"),
  ).toBe("#/tickets/2");
});

test("a card waiting on a supervisor's question shows the badge though its flag is down", async () => {
  stubFetch({
    [LIST]: ticketsPage([
      ticketSummary({ num: 4, status: "building", open_questions: 1 }),
      ticketSummary({ num: 5, status: "building" }),
    ]),
  });
  renderWithProviders(<TicketBoard project={null} />);
  const building = await screen.findByRole("region", { name: "Building" });
  expect(
    within(building)
      .getAllByRole("link", { name: "Needs human" })
      .map((b) => b.getAttribute("href")),
  ).toEqual(["#/inbox?ticket=4"]);
});

test("a card whose next step waits on you says so, and why on hover", async () => {
  stubFetch({
    [LIST]: ticketsPage([
      ticketSummary(
        { num: 1, status: "qa_harness" },
        0,
        "QA needs your note (no QA harness configured)",
      ),
      ticketSummary({ num: 2, status: "building" }),
    ]),
  });
  renderWithProviders(<TicketBoard project={null} />);
  const qa = await screen.findByRole("region", { name: "QA harness" });
  const badge = within(qa).getByText("Waiting on you");
  // The waiting tone (warning): the operator is asked, not alarmed.
  expect(badge.dataset.tone).toBe("warning");
  const chip = badge.parentElement;
  expect(chip?.getAttribute("title")).toBe(
    "QA needs your note (no QA harness configured)",
  );
  expect(chip?.textContent).toBe(
    "Waiting on you: QA needs your note (no QA harness configured)",
  );
  const building = screen.getByRole("region", { name: "Building" });
  expect(within(building).queryByText(/waiting on you/i)).toBeNull();
});

// the closed statuses are folded to narrow columns at the right; one with cards opens on
// a click and folds again, and the flow's columns never move.
test("a closed status is folded until opened, with its count; an empty one only holds its place", async () => {
  stubFetch({
    [LIST]: ticketsPage([
      ticketSummary({ num: 1, status: "backlog" }),
      ticketSummary({ num: 5, status: "done" }),
      ticketSummary({ num: 6, status: "done" }),
    ]),
  });
  renderWithProviders(<TicketBoard project={null} />);
  const done = await screen.findByRole("region", { name: "Done" });
  expect(done.dataset.collapsed).toBe("true");
  expect(within(done).queryByRole("link")).toBeNull();
  const user = userEvent.setup();
  const open = within(done).getByRole("button", {
    name: "Show Done, 2 tickets",
  });
  expect(open.getAttribute("aria-expanded")).toBe("false");
  // An empty closed column has nothing to open.
  expect(
    within(screen.getByRole("region", { name: "Parked" })).queryByRole(
      "button",
    ),
  ).toBeNull();

  await user.click(open);
  const opened = screen.getByRole("region", { name: "Done" });
  expect(opened.dataset.collapsed).toBeUndefined();
  expect(within(opened).getAllByRole("link")).toHaveLength(2);
  expect(wide()).toEqual(["Backlog", "Done"]);
  expect(columns()).toEqual(EVERY_COLUMN);

  await user.click(within(opened).getByRole("button", { name: "Fold Done" }));
  expect(screen.getByRole("region", { name: "Done" }).dataset.collapsed).toBe(
    "true",
  );
});

test("a card clamps a long title and keeps it whole on hover, its facts in a quiet row", async () => {
  const title =
    "Checkout page shows the old VAT rate for EU customers after the 1 July change, on every device";
  stubFetch({
    [LIST]: ticketsPage([
      ticketSummary({
        num: 1,
        title,
        priority: 2,
        type: "bug",
        complexity_tier: "cheap",
      }),
    ]),
  });
  renderWithProviders(<TicketBoard project={null} />);
  const card = await screen.findByRole("heading", { level: 3, name: title });
  expect(card.className).toContain("line-clamp-3");
  expect(card.getAttribute("title")).toBe(title);
  const link = screen.getByRole("link", { name: /FRM-1/ });
  expect(within(link).getByText("P2")).toBeTruthy();
  expect(within(link).getByText("Bug")).toBeTruthy();
  expect(within(link).getByText("cheap")).toBeTruthy();
});

test("the filters are one row of controls of one height", async () => {
  stubFetch({ [LIST]: ticketsPage([ticketSummary({ num: 1 })]) });
  renderWithProviders(<TicketBoard project={null} />);
  const bar = await screen.findByRole("form", { name: "filter tickets" });
  const search = within(bar).getByRole("button", { name: "Search" });
  // The button stands beside a default (h-9) input: the default size, not sm.
  expect(search.dataset.size).toBe("default");
  expect(within(bar).getByLabelText("Search tickets").className).toContain(
    "h-9",
  );
});
