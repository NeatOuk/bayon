import type { AttentionItem, Fleet, RunnerUpdateView } from "@bayon/proto";
import { act, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import type { Feed } from "@/feed/feed";
import { FleetScreen } from "@/fleet/fleet-screen";
import { fleet, fleetRow } from "@/test/fixtures";
import { inboxItem, inboxPage } from "@/test/inbox-fixtures";
import { renderWithProviders, silentFeed, stubFetch } from "@/test/render";

/** A feed whose fleet topic the test pushes by hand. */
function fleetFeed() {
  let push: ((fleet: Fleet, cursor: number) => void) | undefined;
  const feed: Feed = {
    ...silentFeed,
    subscribeFleet: (on) => {
      push = on;
      return () => {
        push = undefined;
      };
    },
  };
  const send = (next: Fleet) =>
    act(() => {
      if (!push) throw new Error("the fleet topic is not subscribed");
      push(next, 1);
    });
  return { feed, send };
}

const MINUTE = 60_000;
const builder = fleetRow({
  id: "s1",
  agent: "builder-1",
  runner_id: "runner-a",
  executor_id: "local",
  run_class: "build",
  ticket: 812,
  title: "transfer guard",
  turns: 48,
  cost_usd: 1.2,
  idle_ms: 5_000,
});
const quiet = fleetRow({ id: "s2", agent: "builder-2", idle_ms: 43 * MINUTE });
// Half a minute past the whole, so the few ms before the snapshot lands never change the rounding.
const stale = (): AttentionItem => ({
  session_id: "s2",
  agent: "builder-2",
  why: "stale",
  since: Date.now() - 42.5 * MINUTE,
  detail: null,
});
const crashed = (): AttentionItem => ({
  session_id: "s9",
  agent: "reviewer-1",
  why: "errored",
  since: Date.now() - 125.5 * MINUTE,
  detail: "runner crashed",
});
const runnerUpdate = (o: Partial<RunnerUpdateView> = {}): RunnerUpdateView => ({
  runner_id: "runner-a",
  current: "0.3.283",
  latest: "0.3.290",
  notes_url: null,
  found_at: Date.now(),
  ...o,
});

test("one card per live session, with its facts and a link to its timeline", async () => {
  stubFetch({ "/api/v1/fleet": fleet([builder, quiet]) });
  renderWithProviders(<FleetScreen />);
  const cards = await screen.findAllByTestId("session-card");
  expect(cards).toHaveLength(2);
  const facts = cards[0]?.textContent ?? "";
  for (const fact of [
    "builder-1",
    "runner-a",
    "local",
    "build",
    "#812",
    "transfer guard",
    "48 turns",
    "$1.20",
    "idle 5s",
  ])
    expect(facts).toContain(fact);
  expect(cards[0]?.getAttribute("href")).toBe("#/sessions/s1");
  // The agent is the card's heading, under the section's.
  expect(
    within(cards[0] as HTMLElement).getByRole("heading", {
      level: 3,
      name: "builder-1",
    }),
  ).toBeTruthy();
});

test("a session with a ticket key shows the key, not the number", async () => {
  stubFetch({
    "/api/v1/fleet": fleet([{ ...builder, ticket_key: "FRM-812" }]),
  });
  renderWithProviders(<FleetScreen />);
  const [card] = await screen.findAllByTestId("session-card");
  expect(card?.textContent).toContain("FRM-812 · build");
});

test("today's spend shows against the daily cap, with its share as a bar", async () => {
  stubFetch({
    "/api/v1/fleet": fleet([builder], {
      budget: { today_usd: 14.3, daily_cap_usd: 40 },
    }),
  });
  renderWithProviders(<FleetScreen />);
  const budget = await screen.findByRole("group", { name: "Today's spend" });
  expect(budget.textContent).toContain("$14.30 of $40.00");
  expect(budget.textContent).toContain("35% of the daily cap");
  const used = Number(
    screen.getByRole("progressbar").getAttribute("aria-valuenow"),
  );
  expect(used).toBeCloseTo(35.75);
});

test("with no cap (the seeded null), the budget is spend alone", async () => {
  stubFetch({
    "/api/v1/fleet": fleet([builder], {
      budget: { today_usd: 3.2, daily_cap_usd: null },
    }),
  });
  renderWithProviders(<FleetScreen />);
  const budget = await screen.findByRole("group", { name: "Today's spend" });
  expect(budget.textContent).toContain("$3.20");
  expect(budget.textContent).toContain("No daily cap");
  expect(screen.queryByRole("progressbar")).toBeNull();
});

test("slot counts are busy against capacity, in total and per executor", async () => {
  stubFetch({
    "/api/v1/fleet": fleet([builder], {
      slots: [
        { executor_id: "ctr", busy: 0, capacity: 8 },
        { executor_id: "local", busy: 2, capacity: 4 },
      ],
    }),
  });
  renderWithProviders(<FleetScreen />);
  const slots = await screen.findByRole("group", { name: "Slots in use" });
  expect(slots.textContent).toContain("2 of 12");
  expect(slots.textContent).toContain("ctr 0/8 · local 2/4");
});

test("the live sessions stat counts them by state", async () => {
  stubFetch({
    "/api/v1/fleet": fleet([
      builder,
      { ...quiet, state: "idle" },
      fleetRow({ id: "s3", state: "idle" }),
    ]),
  });
  renderWithProviders(<FleetScreen />);
  const live = await screen.findByRole("group", { name: "Live sessions" });
  expect(live.textContent).toContain("3");
  expect(live.textContent).toContain("2 idle · 1 running");
});

test("admission's queue shows only while it holds a spawn", async () => {
  stubFetch({
    "/api/v1/fleet": fleet([builder], {
      admission: {
        queued: [
          {
            session_id: "q1",
            agent: "builder-3",
            executor_id: "local",
            reason: "fleet_paused",
            since: 1,
          },
        ],
        by_reason: { fleet_paused: 1 },
      },
    }),
  });
  renderWithProviders(<FleetScreen />);
  const queued = await screen.findByRole("group", {
    name: "Queued by admission",
  });
  expect(queued.textContent).toContain("1 fleet paused");
});

test("Needs you comes first on the screen, before the figures and the sessions", async () => {
  stubFetch({
    "/api/v1/fleet": fleet([builder, quiet], { attention: [stale()] }),
  });
  renderWithProviders(<FleetScreen />);
  const needs = await screen.findByRole("region", { name: "Needs you" });
  const sessions = screen.getByRole("region", { name: "live sessions" });
  const spend = screen.getByRole("group", { name: "Today's spend" });
  const follows = (a: Node, b: Node) =>
    Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  expect(follows(needs, spend)).toBe(true);
  expect(follows(needs, sessions)).toBe(true);
  expect(
    screen
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.textContent)
      .slice(0, 1),
  ).toEqual(["Needs you1"]);
});

test("Needs you lists what the server flags, each with its badge and its way on", async () => {
  stubFetch({
    "/api/v1/fleet": fleet([builder, quiet], {
      attention: [crashed(), stale()],
    }),
  });
  renderWithProviders(<FleetScreen />);
  const needs = await screen.findByRole("region", { name: "Needs you" });
  const rows = within(needs).getAllByRole("listitem");
  expect(rows.map((row) => row.textContent)).toEqual([
    "Crashedreviewer-1 · exited with an error 2h 5m agorunner crashedOpen the sessionDismiss",
    "Stalebuilder-2 · silent for 42mOpen to stop or hand off",
  ]);
  expect(within(rows[0] as HTMLElement).getByText("Crashed").dataset.tone).toBe(
    "danger",
  );
  expect(within(rows[1] as HTMLElement).getByText("Stale").dataset.tone).toBe(
    "warning",
  );
  const links = within(needs)
    .getAllByRole("link")
    .map((link) => [link.textContent, link.getAttribute("href")]);
  expect(links).toEqual([
    ["Open the session", "#/sessions/s9"],
    // A stale session is live, so its entry names the remedy rather than only its age.
    ["Open to stop or hand off", "#/sessions/s2"],
  ]);
  // The stale session's card is edged in the warning tone too.
  const [, quietCard] = screen.getAllByTestId("session-card");
  expect(quietCard?.className).toContain("border-warning");
});

test("an error exit can be dismissed; a live stale session offers no dismissal", async () => {
  const fetchMock = stubFetch({
    "/api/v1/fleet": fleet([builder, quiet], {
      attention: [crashed(), stale()],
    }),
    "/api/v1/fleet/attention/s9/ack": {
      session_id: "s9",
      acked_at: Date.now(),
      acked_by: "operator",
    },
  });
  renderWithProviders(<FleetScreen />);
  const needs = await screen.findByRole("region", { name: "Needs you" });

  // Exactly one dismissal, on the error exit: dismissing a live condition would hide something
  // still true, so the stale entry must not offer one.
  const buttons = within(needs).getAllByRole("button");
  expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
    "Dismiss reviewer-1's error",
  ]);

  await act(async () => {
    buttons[0]?.click();
  });
  expect(
    fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.includes("/ack")),
  ).toEqual(["/api/v1/fleet/attention/s9/ack"]);
});

test("an open runner update shows in Needs you, links to Runners, and dismisses", async () => {
  const fetchMock = stubFetch({
    "/api/v1/fleet": fleet([builder], {
      runner_updates: [runnerUpdate()],
    }),
    "/api/v1/runners/runner-a/updates/0.3.290/dismiss": {
      runner_id: "runner-a",
      latest: "0.3.290",
    },
  });
  renderWithProviders(<FleetScreen />);
  const needs = await screen.findByRole("region", { name: "Needs you" });
  expect(needs.textContent).toContain("runner-a 0.3.283 → 0.3.290 available");
  expect(
    within(needs)
      .getByRole("link", { name: "Open runners" })
      .getAttribute("href"),
  ).toBe("#/runners");

  await act(async () => {
    within(needs)
      .getByRole("button", {
        name: "Dismiss the runner-a 0.3.290 update",
      })
      .click();
  });
  expect(
    fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.includes("/updates/")),
  ).toEqual(["/api/v1/runners/runner-a/updates/0.3.290/dismiss"]);
});

test("open questions in the Inbox are in Needs you, linked to the Inbox", async () => {
  stubFetch({
    "/api/v1/fleet": fleet([builder]),
    "/api/v1/inbox?status=open": inboxPage([
      inboxItem({ id: "h1" }),
      inboxItem({ id: "h2" }),
    ]),
  });
  renderWithProviders(<FleetScreen />);
  const needs = await screen.findByRole("region", { name: "Needs you" });
  expect(
    await within(needs).findByText("2 questions wait for your answer"),
  ).toBeTruthy();
  expect(
    within(needs)
      .getByRole("link", { name: "Answer in the Inbox" })
      .getAttribute("href"),
  ).toBe("#/inbox");
});

test("with nothing flagged, Needs you says so in one line", async () => {
  stubFetch({ "/api/v1/fleet": fleet([builder]) });
  renderWithProviders(<FleetScreen />);
  const needs = await screen.findByRole("region", { name: "Needs you" });
  expect(needs.textContent).toBe("Needs youNothing needs you");
  expect(within(needs).queryByRole("list")).toBeNull();
});

test("with no live session, the empty state points to the board", async () => {
  stubFetch({ "/api/v1/fleet": fleet([]) });
  renderWithProviders(<FleetScreen />);
  expect(await screen.findByText("No live sessions")).toBeTruthy();
  expect(
    screen
      .getByRole("link", { name: "Open the Tickets board" })
      .getAttribute("href"),
  ).toBe("#/tickets");
});

test("updates arrive over the WebSocket, and the browser infers nothing", async () => {
  const fetchMock = stubFetch({ "/api/v1/fleet": fleet([builder, quiet]) });
  const { feed, send } = fleetFeed();
  renderWithProviders(<FleetScreen />, { feed });
  expect(await screen.findByText("48 turns")).toBeTruthy();

  send(fleet([{ ...builder, turns: 49 }])); // builder-2 leaves the fleet
  expect(await screen.findByText("49 turns")).toBeTruthy();
  expect(screen.getAllByTestId("session-card")).toHaveLength(1);
  expect(screen.getByRole("region", { name: "Needs you" }).textContent).toBe(
    "Needs youNothing needs you",
  );
  // The fleet once, the pulse schedule, the projects (for a paused one, and readiness with the
  // runners, role bindings and settings) and the Inbox's open count the header rides too: no GET
  // /sessions/:id for the one that left.
  expect(fetchMock.mock.calls.map(([input]) => String(input)).sort()).toEqual([
    "/api/v1/agents/pulse-policies",
    "/api/v1/fleet",
    "/api/v1/inbox?status=open",
    "/api/v1/projects",
    "/api/v1/role-bindings",
    "/api/v1/runners",
    "/api/v1/settings",
  ]);

  // Query hands setQueryData to observers on its own schedule, hence findBy.
  send(fleet([builder], { attention: [crashed()] }));
  const needs = screen.getByRole("region", { name: "Needs you" });
  expect(await within(needs).findByText(/runner crashed/)).toBeTruthy();
});

// a fresh install with nothing certified said "Nothing needs you".
test("an install that can't work yet says what to set up, each with its one action", async () => {
  stubFetch({
    "/api/v1/fleet": fleet([]),
    "/api/v1/projects": { projects: [] },
    "/api/v1/runners": { runners: [] },
    "/api/v1/role-bindings": { items: [] },
    "/api/v1/settings": { settings: [], require_certified: true },
  });
  renderWithProviders(<FleetScreen />);
  const needs = await screen.findByRole("region", { name: "Needs you" });
  expect(
    await within(needs).findByText(
      "No project yet: there is nothing to work on",
    ),
  ).toBeTruthy();
  expect(
    within(needs)
      .getByRole("link", { name: "Create a project" })
      .getAttribute("href"),
  ).toBe("#/projects/new");
  expect(within(needs).queryByText("Nothing needs you")).toBeNull();
});
