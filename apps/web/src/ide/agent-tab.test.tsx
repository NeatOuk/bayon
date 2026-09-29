import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import type { Feed } from "@/feed/feed";
import {
  fleet,
  fleetRow,
  sessionView,
  terminal,
  text,
  toolCall,
} from "@/test/fixtures";
import { renderIde, sessionsUrl, tabNames } from "@/test/ide-harness";
import {
  agentSessionItem,
  agentSessionsPage,
  projectAgent,
  projectView,
} from "@/test/project-fixtures";
import { silentFeed } from "@/test/render";
import { ticketDetail, ticketView } from "@/test/ticket-fixtures";

// An agent tab's session list: `GET /agents/:id/sessions`, newest first, paged with
// "Load older"; a session opens as a tab that replays it, a ticket as its tab.

const BUILDER = projectAgent({
  id: "bayon-builder",
  runner_id: "runner-a",
  max_concurrency: 2,
});
const BAYON = projectView({ agents: [BUILDER] });

const NEWEST = "01JAGENTSESSION000000003";
const MIDDLE = "01JAGENTSESSION000000002";
const OLDEST = "01JAGENTSESSION000000001";

const PAGES = {
  [sessionsUrl("bayon-builder")]: agentSessionsPage(
    [
      agentSessionItem({
        id: NEWEST,
        ticket_id: "ticket-9",
        ticket_key: "FRM-9",
        role: "reviewer",
        run_class: "review",
        turns: 7,
        cost_usd: 1.5,
        exit_reason: "error",
      }),
      agentSessionItem({ id: MIDDLE }),
    ],
    "page-2",
  ),
  [sessionsUrl("bayon-builder", "page-2")]: agentSessionsPage([
    agentSessionItem({
      id: OLDEST,
      started_at: null,
      ended_at: null,
      state: "pending",
      exit_reason: null,
    }),
  ]),
};

const sessionRows = () =>
  within(screen.getByRole("table", { name: "agent sessions" }))
    .getAllByRole("row")
    .slice(1);

afterEach(() => {
  window.location.hash = "";
  window.localStorage.clear();
});

test("an agent tab lists its sessions newest first, and Load older reads the next page", async () => {
  renderIde("#/p/ws-bayon/agents?open=agent:bayon-builder", BAYON, PAGES);
  const user = userEvent.setup();
  const header = (
    await screen.findByRole("heading", { name: "bayon-builder" })
  ).closest("header");
  if (header === null) throw new Error("no header");
  expect(within(header).getByText("max concurrency 2")).toBeTruthy();
  // The header's facts: its kind in words, enabled as a status, its id copyable.
  expect(within(header).getByText("Builder")).toBeTruthy();
  expect(within(header).getByText("Enabled").dataset.tone).toBe("info");
  expect(
    within(header).getByRole("button", { name: "Copy the agent id" }),
  ).toBeTruthy();
  await waitFor(() => expect(sessionRows()).toHaveLength(2));
  const [newest] = sessionRows();
  if (newest === undefined) throw new Error("no rows");
  expect(
    within(newest)
      .getAllByRole("cell")
      .map((cell) => cell.textContent),
  ).toEqual([
    // The id shortened in the middle, then whole for a screen reader.
    `01JA…000003${NEWEST}`,
    "FRM-9",
    "reviewer · review",
    // An exited session reads by how it ended: an error is a crash.
    "Crashed",
    "2027-01-15 08:00 UTC",
    "2027-01-15 08:01 UTC",
    "7",
    "$1.50",
  ]);
  expect(within(newest).getByText("Crashed").dataset.tone).toBe("danger");
  expect(
    within(newest).getByRole("link", { name: "FRM-9" }).getAttribute("href"),
  ).toBe("#/p/ws-bayon/agents?open=ticket:9");

  await user.click(screen.getByRole("button", { name: "Load older" }));
  await waitFor(() => expect(sessionRows()).toHaveLength(3));
  expect(sessionRows()[2]?.textContent).toBe(
    `01JA…000001${OLDEST}—builder · buildPending——3$0.25`,
  );
  expect(screen.queryByRole("button", { name: "Load older" })).toBe(null);
});

test("a session opens as a tab that replays it, event by event; a ticket opens as its tab", async () => {
  const feed: Feed = {
    ...silentFeed,
    subscribeEvents: (sessionId, on) => {
      if (sessionId === NEWEST)
        on([text(1, "read the ticket"), toolCall(2), terminal(3, "ok")], 3);
      return () => undefined;
    },
  };
  renderIde(
    "#/p/ws-bayon/agents?open=agent:bayon-builder",
    BAYON,
    {
      ...PAGES,
      [`/api/v1/sessions/${NEWEST}`]: sessionView({
        id: NEWEST,
        state: "exited",
      }),
      "/api/v1/tickets/9": ticketDetail(ticketView({ num: 9, title: "nine" })),
    },
    feed,
  );
  const user = userEvent.setup();
  await waitFor(() => expect(sessionRows()).toHaveLength(2));
  await user.click(screen.getByRole("link", { name: NEWEST }));
  expect(window.location.hash).toBe(
    `#/p/ws-bayon/agents?open=session:${NEWEST}`,
  );
  expect(await screen.findByRole("tab", { name: "Timeline" })).toBeTruthy();
  expect(await screen.findByText("read the ticket")).toBeTruthy();
  expect(tabNames()).toEqual(["Agents", "bayon-builder", "session …000003"]);

  await user.click(screen.getByRole("tab", { name: "bayon-builder" }));
  await waitFor(() => expect(sessionRows()).toHaveLength(2));
  await user.click(screen.getByRole("link", { name: "FRM-9" }));
  expect(
    await screen.findByRole("heading", { name: "FRM-9 · nine" }),
  ).toBeTruthy();
  expect(tabNames()).toEqual([
    "Agents",
    "bayon-builder",
    "session …000003",
    "FRM-9",
  ]);
});

test("while the agent has a live session, its tab watches it: a read-only terminal of that session's events", async () => {
  const LIVE = "01JAGENTLIVE000000000001";
  const OTHER = "01JAGENTLIVE000000000002";
  const watched: string[] = [];
  const feed: Feed = {
    ...silentFeed,
    subscribeEvents: (sessionId) => {
      watched.push(sessionId);
      return () => undefined;
    },
  };
  const live = (id: string) =>
    fleetRow({ id, agent: "bayon-builder", workspace_id: "ws-bayon" });
  renderIde(
    "#/p/ws-bayon/agents?open=agent:bayon-builder",
    BAYON,
    { ...PAGES, "/api/v1/fleet": fleet([live(LIVE), live(OTHER)]) },
    feed,
  );
  const user = userEvent.setup();
  const panel = await screen.findByRole("region", { name: "watch" });
  expect(within(panel).getByLabelText(`watch ${LIVE}`)).toBeTruthy();
  expect(watched).toContain(LIVE);

  // Two live sessions: one at a time, the other a click away.
  await user.click(
    within(panel).getByRole("button", { name: `session ${OTHER}` }),
  );
  expect(within(panel).getByLabelText(`watch ${OTHER}`)).toBeTruthy();
  expect(watched).toContain(OTHER);
});

test("an agent with no live session has nothing to watch", async () => {
  renderIde("#/p/ws-bayon/agents?open=agent:bayon-builder", BAYON, PAGES);
  await waitFor(() => expect(sessionRows()).toHaveLength(2));
  expect(screen.queryByRole("region", { name: "watch" })).toBeNull();
});
