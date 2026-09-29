import type { OnTicketEvents } from "@bayon/proto";
import { QueryClient } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "@/app";
import type { Feed } from "@/feed/feed";
import { readFlag, writeFlag } from "@/ide/viewer-prefs";
import { fleet } from "@/test/fixtures";
import {
  projectView,
  projectsView,
  timelineEntry,
  timelinePage,
} from "@/test/project-fixtures";
import { callsTo, silentFeed, stubFetch } from "@/test/render";
import { ticketDetail, ticketEvent, ticketView } from "@/test/ticket-fixtures";

const TIMELINE = "/api/v1/projects/ws-bayon/timeline?limit=30";

const ROWS = timelinePage([
  timelineEntry({
    key: "00000000000000000009",
    ts: Date.UTC(2027, 0, 15, 14, 2),
    agent_id: "bayon-builder",
    actor: "session:01JS",
    ticket_id: "ticket-812",
    ticket_key: "FRM-812",
    session_id: "01JS",
    summary: "FRM-812 building → review",
  }),
  timelineEntry({
    source: "audit",
    key: "00000000000000000008",
    ts: Date.UTC(2027, 0, 15, 13, 58),
    kind: "audit.project.pause",
    summary: "operator paused the project",
  }),
]);

/** A feed whose `tickets` topic the test pushes by hand; the rest stays silent. */
function ticketsFeed() {
  let listener: OnTicketEvents | undefined;
  const feed: Feed = {
    ...silentFeed,
    subscribeTickets: (on) => {
      listener = on;
      return () => {
        listener = undefined;
      };
    },
  };
  const push = (id: number) =>
    act(() => {
      if (listener === undefined) throw new Error("tickets not subscribed");
      listener([ticketEvent(id)], id);
    });
  return { feed, push };
}

const renderAt = (
  hash: string,
  routes: Record<string, unknown>,
  feed: Feed = silentFeed,
) => {
  const fetchMock = stubFetch({
    "/api/v1/fleet": fleet([]),
    "/api/v1/projects": projectsView(projectView()),
    ...routes,
  });
  window.location.hash = hash;
  render(
    <App
      feed={feed}
      queryClient={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    />,
  );
  return fetchMock;
};

/** The panel, once the project has loaded. */
const activity = () => screen.findByRole("region", { name: "activity" });

afterEach(() => {
  window.location.hash = "";
  window.localStorage.clear();
  vi.restoreAllMocks();
});

test("the activity panel lists the newest rows: time, who, summary; a ticket's row opens it as a tab", async () => {
  renderAt("#/p/ws-bayon/overview", {
    [TIMELINE]: ROWS,
    "/api/v1/tickets/812": ticketDetail(
      ticketView({ num: 812, title: "transfer" }),
    ),
  });
  const user = userEvent.setup();
  const rows = await within(await activity()).findByRole("list", {
    name: "activity rows",
  });
  const items = within(rows).getAllByRole("listitem");
  expect(items.map((item) => item.textContent)).toEqual([
    "14:02bayon-builderFRM-812 building → review",
    "13:58operatoroperator paused the project",
  ]);
  expect(within(items[1] as HTMLElement).queryByRole("link")).toBe(null);
  const row = within(rows).getByRole("link", { name: /building → review/ });
  expect(row.getAttribute("href")).toBe(
    "#/p/ws-bayon/overview?open=ticket:812",
  );
  await user.click(row);
  expect(
    await screen.findByRole("heading", { name: "FRM-812 · transfer" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("tab", { selected: true, name: "FRM-812" }),
  ).toBeTruthy();
});

test("a tickets frame refetches the activity at once", async () => {
  const { feed, push } = ticketsFeed();
  const fetchMock = renderAt(
    "#/p/ws-bayon/overview",
    { [TIMELINE]: timelinePage([]) },
    feed,
  );
  expect(
    await within(await activity()).findByText(
      "Nothing has happened in this project yet.",
    ),
  ).toBeTruthy();
  expect(callsTo(fetchMock, TIMELINE)).toHaveLength(1);
  push(1);
  await waitFor(() => expect(callsTo(fetchMock, TIMELINE)).toHaveLength(2));
});

test("folding the panel stops its reads and is remembered for this viewer", async () => {
  const fetchMock = renderAt("#/p/ws-bayon/overview", { [TIMELINE]: ROWS });
  const user = userEvent.setup();
  const panel = await activity();
  await within(panel).findByRole("list", { name: "activity rows" });
  await user.click(within(panel).getByRole("button", { name: /Activity/ }));
  await waitFor(() =>
    expect(within(panel).queryByRole("list", { name: "activity rows" })).toBe(
      null,
    ),
  );
  expect(window.localStorage.getItem("bayon.ide.activity-open")).toBe("0");
  expect(callsTo(fetchMock, TIMELINE)).toHaveLength(1);
});

test("a folded panel stays folded on the next visit, and reads nothing", async () => {
  window.localStorage.setItem("bayon.ide.activity-open", "0");
  const fetchMock = renderAt("#/p/ws-bayon/overview", { [TIMELINE]: ROWS });
  const trigger = within(await activity()).getByRole("button", {
    name: /Activity/,
  });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(callsTo(fetchMock, TIMELINE)).toHaveLength(0);
});

test("blocked storage leaves the defaults in place", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(readFlag("any", true)).toBe(true);
  expect(() => writeFlag("any", false)).not.toThrow();
});
