import type { TimelineEntry } from "@bayon/proto";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { historyUrl, navigate, renderIde, tabNames } from "@/test/ide-harness";
import {
  projectView,
  timelineEntry,
  timelinePage,
} from "@/test/project-fixtures";
import { pushFeed } from "@/test/push-feed";
import { apiError, callsTo } from "@/test/render";
import { formatLocalTime } from "@/lib/format";
import { ticketDetail, ticketEvent, ticketView } from "@/test/ticket-fixtures";

// The IDE's History view, inside the whole app so its links navigate: the project's
// timeline filtered by the URL, paged on its cursor, exported, and live behind a pill.

const BAYON = projectView();
const HISTORY = "#/p/ws-bayon/history";
const NOW = Date.now();
const MINUTE = 60_000;

/** Local midnight of a calendar day, as the date inputs mean it. */
const midnight = (year: number, month: number, day: number): number =>
  new Date(year, month - 1, day).getTime();

const TICKET_ROW = timelineEntry({
  source: "ticket",
  key: "00000000000000000009",
  ts: NOW - 5 * MINUTE,
  kind: "ticket.transition",
  actor: "session:01JSESSIONABCDEF123456",
  agent_id: "bayon-builder",
  ticket_id: "ticket-812",
  ticket_key: "FRM-812",
  session_id: "01JSESSIONABCDEF123456",
  summary: "FRM-812 building → review",
  payload: { from: "building", to: "review" },
});
const SESSION_ROW = timelineEntry({
  source: "session",
  key: "01JSESSIONABCDEF123456:started",
  ts: NOW - 10 * MINUTE,
  kind: "session.started",
  actor: "supervisor",
  agent_id: "bayon-builder",
  ticket_key: "FRM-812",
  session_id: "01JSESSIONABCDEF123456",
  summary: "bayon-builder started build on FRM-812",
});
const PULSE_ROW = timelineEntry({
  source: "pulse",
  key: "01JPULSEABCDEF123456",
  ts: NOW - 2 * 60 * MINUTE,
  kind: "pulse.done",
  actor: "supervisor",
  session_id: "01JPULSESESSION0000001",
  summary: "orchestrator pulse (interval): done",
});
const AUDIT_ROW = timelineEntry({
  source: "audit",
  key: "00000000000000000004",
  ts: NOW - 3 * 24 * 60 * MINUTE,
  kind: "audit.project.pause",
  actor: "operator",
  summary: "operator paused the project",
});
const ROWS = [TICKET_ROW, SESSION_ROW, PULSE_ROW, AUDIT_ROW];

/** `n` rows, newest first, each with its own summary `row <i>`. */
const numbered = (from: number, n: number): TimelineEntry[] =>
  Array.from({ length: n }, (_, i) =>
    timelineEntry({
      source: "audit",
      key: String(1_000 - from - i).padStart(20, "0"),
      ts: NOW - (from + i) * MINUTE,
      summary: `row ${from + i}`,
    }),
  );

const history = () => screen.findByRole("list", { name: "history events" });
const items = async () => within(await history()).getAllByRole("listitem");
const rowOf = async (summary: string) => {
  const found = (await items()).find((item) =>
    item.textContent?.includes(summary),
  );
  if (found === undefined) throw new Error(`no row ${summary}`);
  return found;
};

afterEach(() => {
  window.location.hash = "";
  vi.restoreAllMocks();
});

describe("rows", () => {
  test("show the local time and how long ago, the kind, the agent and actor, the ticket and the summary", async () => {
    renderIde(HISTORY, BAYON, { [historyUrl("ws-bayon")]: timelinePage(ROWS) });
    const row = await rowOf("FRM-812 building → review");
    expect(
      screen.getByRole("heading", { level: 1, name: "History" }),
    ).toBeTruthy();
    // The actor's id shortened in the middle, then whole for a screen reader.
    expect(row.textContent).toBe(
      `${formatLocalTime(TICKET_ROW.ts)}5 min agoticket.transitionbayon-builder` +
        "session 01JS…12345601JSESSIONABCDEF123456FRM-812FRM-812 building → reviewdetails",
    );
    expect(row.getAttribute("aria-posinset")).toBe("1");
    expect(row.getAttribute("aria-setsize")).toBe("4");
    expect(within(row).getByText(formatLocalTime(TICKET_ROW.ts)).title).toMatch(
      / UTC$/,
    );
    expect((await rowOf("operator paused")).textContent).toContain("3 d ago");
    expect(
      screen.getByText("The beginning of this project's history: 4 events."),
    ).toBeTruthy();
  });

  test("a ticket row opens its ticket, a session row its session, a pulse row its pulse; one naming none is text", async () => {
    renderIde(HISTORY, BAYON, {
      [historyUrl("ws-bayon")]: timelinePage(ROWS),
      "/api/v1/tickets/812": ticketDetail(
        ticketView({ num: 812, title: "transfer" }),
      ),
    });
    const user = userEvent.setup();
    const link = async (summary: string) =>
      within(await rowOf(summary)).getByRole("link");
    expect((await link("building → review")).getAttribute("href")).toBe(
      `${HISTORY}?open=ticket:812`,
    );
    expect((await link("started build")).getAttribute("href")).toBe(
      `${HISTORY}?open=session:01JSESSIONABCDEF123456`,
    );
    expect((await link("orchestrator pulse")).getAttribute("href")).toBe(
      `${HISTORY}?open=pulse:01JPULSEABCDEF123456`,
    );
    expect(within(await rowOf("operator paused")).queryByRole("link")).toBe(
      null,
    );

    await user.click(await link("building → review"));
    expect(
      await screen.findByRole("heading", { name: "FRM-812 · transfer" }),
    ).toBeTruthy();
    navigate(HISTORY);
    await user.click(await link("started build"));
    expect(window.location.hash).toBe(
      `${HISTORY}?open=session:01JSESSIONABCDEF123456`,
    );
    navigate(HISTORY);
    await user.click(await link("orchestrator pulse"));
    expect(window.location.hash).toBe(
      `${HISTORY}?open=pulse:01JPULSEABCDEF123456`,
    );
    await waitFor(() =>
      expect(tabNames()).toEqual([
        "History",
        "FRM-812",
        "session …123456",
        "pulse …123456",
      ]),
    );
  });

  test("a payload opens as formatted JSON behind its row's details", async () => {
    renderIde(HISTORY, BAYON, { [historyUrl("ws-bayon")]: timelinePage(ROWS) });
    const user = userEvent.setup();
    const row = await rowOf("building → review");
    expect(within(await rowOf("started build")).queryByRole("button")).toBe(
      null,
    );
    const details = within(row).getByRole("button", { name: /details/ });
    expect(details.getAttribute("aria-expanded")).toBe("false");
    await user.click(details);
    expect(details.getAttribute("aria-expanded")).toBe("true");
    expect(within(row).getByText(/"from": "building"/).textContent).toBe(
      '{\n  "from": "building",\n  "to": "review"\n}',
    );
  });
});

describe("filters", () => {
  test("each filter reaches the URL and the request: chips as source prefixes, the agent, the dates, the ticket and search on Enter", async () => {
    const days = `from=${midnight(2026, 9, 1)}&to=${midnight(2026, 9, 23)}`;
    const fetchMock = renderIde(HISTORY, BAYON, {
      [historyUrl("ws-bayon", "kind=ticket.*")]: timelinePage([]),
      [historyUrl("ws-bayon", "kind=ticket.*,gate.*")]: timelinePage([]),
      [historyUrl("ws-bayon", "kind=ticket.*,gate.*&agent=bayon-reviewer")]:
        timelinePage([]),
      [historyUrl(
        "ws-bayon",
        "kind=ticket.*,gate.*&agent=bayon-reviewer&from=" +
          `${midnight(2026, 9, 1)}`,
      )]: timelinePage([]),
      [historyUrl(
        "ws-bayon",
        `kind=ticket.*,gate.*&agent=bayon-reviewer&${days}`,
      )]: timelinePage([]),
      [historyUrl(
        "ws-bayon",
        `kind=ticket.*,gate.*&agent=bayon-reviewer&ticket=FRM-812&${days}&q=deploy%20ok`,
      )]: timelinePage([]),
    });
    const user = userEvent.setup();
    await screen.findByText("This project has no history yet.");

    await user.click(screen.getByRole("button", { name: "Tickets" }));
    expect(window.location.hash).toBe(`${HISTORY}?kind=ticket`);
    await user.click(screen.getByRole("button", { name: "Gates" }));
    expect(window.location.hash).toBe(`${HISTORY}?kind=ticket,gate`);

    await user.click(screen.getByRole("combobox", { name: "Agent" }));
    await user.click(
      await screen.findByRole("option", { name: "bayon-reviewer" }),
    );
    expect(window.location.hash).toBe(
      `${HISTORY}?kind=ticket,gate&agent=bayon-reviewer`,
    );

    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "2026-09-01" },
    });
    await waitFor(() =>
      expect(screen.getByLabelText("To").getAttribute("min")).toBe(
        "2026-09-01",
      ),
    );
    fireEvent.change(screen.getByLabelText("To"), {
      target: { value: "2026-09-22" },
    });
    expect(window.location.hash).toBe(
      `${HISTORY}?kind=ticket,gate&agent=bayon-reviewer&from=2026-09-01&to=2026-09-22`,
    );
    expect(screen.getByLabelText("From").getAttribute("aria-describedby")).toBe(
      screen.getByText(/^Days and times are in your timezone/).id,
    );

    // Typing asks nothing; Enter applies both fields at once.
    await user.type(screen.getByLabelText("Ticket"), "FRM-812");
    await user.type(screen.getByLabelText("Search"), "deploy ok{Enter}");
    const all =
      `${HISTORY}?kind=ticket,gate&agent=bayon-reviewer&ticket=FRM-812` +
      "&from=2026-09-01&to=2026-09-22&q=deploy%20ok";
    expect(window.location.hash).toBe(all);
    await waitFor(() =>
      expect(
        callsTo(
          fetchMock,
          historyUrl(
            "ws-bayon",
            `kind=ticket.*,gate.*&agent=bayon-reviewer&ticket=FRM-812&${days}&q=deploy%20ok`,
          ),
        ),
      ).toHaveLength(1),
    );
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("ticket=FRM-8&"),
      ),
    ).toEqual([]);
    expect(
      callsTo(fetchMock, historyUrl("ws-bayon", "kind=ticket.*")),
    ).toHaveLength(1);
  });

  test("an unknown ticket shows the server's 400 under the ticket field", async () => {
    renderIde(HISTORY, BAYON, {
      [historyUrl("ws-bayon", "ticket=FRM-99")]: apiError(
        400,
        "validation",
        "no ticket FRM-99",
      ),
    });
    const user = userEvent.setup();
    await screen.findByText("This project has no history yet.");
    await user.type(screen.getByLabelText("Ticket"), "FRM-99{Enter}");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("no ticket FRM-99");
    const field = screen.getByLabelText("Ticket");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe(alert.id);
    expect(screen.queryByText(/The history is unavailable/)).toBe(null);
  });

  test("no match is said as such, and Clear all filters asks for everything again", async () => {
    const fetchMock = renderIde(`${HISTORY}?kind=gate&q=nothing`, BAYON, {
      [historyUrl("ws-bayon", "kind=gate.*&q=nothing")]: timelinePage([]),
      [historyUrl("ws-bayon")]: timelinePage(ROWS),
    });
    const user = userEvent.setup();
    expect(
      await screen.findByText("No events match these filters."),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear all filters" }));
    expect(window.location.hash).toBe(HISTORY);
    expect(await rowOf("building → review")).toBeTruthy();
    expect(callsTo(fetchMock, historyUrl("ws-bayon"))).toHaveLength(1);
    expect(
      screen
        .getByRole("button", { name: "Clear all" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  test("a filtered URL sets every control and the request; moving back restores the filters it had", async () => {
    const filtered =
      `${HISTORY}?kind=gate,finding&agent=bayon-builder&ticket=FRM-812` +
      "&from=2026-09-01&to=2026-09-22&q=deploy";
    const fetchMock = renderIde(filtered, BAYON, {
      [historyUrl(
        "ws-bayon",
        `kind=gate.*,finding.*&agent=bayon-builder&ticket=FRM-812&from=${midnight(2026, 9, 1)}&to=${midnight(2026, 9, 23)}&q=deploy`,
      )]: timelinePage([TICKET_ROW]),
      [historyUrl("ws-bayon", "kind=gate.*")]: timelinePage([]),
    });
    await rowOf("building → review");
    const pressed = (name: string) =>
      screen.getByRole("button", { name }).getAttribute("aria-pressed");
    expect(pressed("Gates")).toBe("true");
    expect(pressed("Findings")).toBe("true");
    expect(pressed("Tickets")).toBe("false");
    expect(
      within(screen.getByRole("combobox", { name: "Agent" })).getByText(
        "bayon-builder",
      ),
    ).toBeTruthy();
    const value = (label: string) =>
      (screen.getByLabelText(label) as HTMLInputElement).value;
    expect([
      value("Ticket"),
      value("Search"),
      value("From"),
      value("To"),
    ]).toEqual(["FRM-812", "deploy", "2026-09-01", "2026-09-22"]);

    navigate(`${HISTORY}?kind=gate`);
    expect(
      await screen.findByText("No events match these filters."),
    ).toBeTruthy();
    expect(value("Ticket")).toBe("");
    expect(value("Search")).toBe("");
    navigate(filtered);
    expect(await rowOf("building → review")).toBeTruthy();
    expect(value("Ticket")).toBe("FRM-812");
    // Back on a filter set already read: the cached list, not a second read.
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("q=deploy")),
    ).toHaveLength(1);
  });

  test("opening a row's tab and coming back to the view keeps the filters", async () => {
    const fetchMock = renderIde(`${HISTORY}?kind=ticket`, BAYON, {
      [historyUrl("ws-bayon", "kind=ticket.*")]: timelinePage([TICKET_ROW]),
      "/api/v1/tickets/812": ticketDetail(
        ticketView({ num: 812, title: "transfer" }),
      ),
    });
    const user = userEvent.setup();
    await user.click(
      within(await rowOf("building → review")).getByRole("link"),
    );
    expect(window.location.hash).toBe(`${HISTORY}?kind=ticket&open=ticket:812`);
    await screen.findByRole("heading", { name: "FRM-812 · transfer" });
    await user.click(screen.getByRole("tab", { name: "History" }));
    expect(window.location.hash).toBe(`${HISTORY}?kind=ticket`);
    expect(
      screen
        .getByRole("button", { name: "Tickets" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(callsTo(fetchMock, historyUrl("ws-bayon"))).toHaveLength(0);
  });
});

describe("paging", () => {
  const FIRST = timelinePage(numbered(0, 50), "c1");
  // The second page repeats the first's last row: it shows once.
  const SECOND = timelinePage([...numbered(49, 1), ...numbered(50, 2)]);

  test("Load older reads the next page on the cursor; a row repeated across pages shows once", async () => {
    const errors = vi.spyOn(console, "error");
    const fetchMock = renderIde(HISTORY, BAYON, {
      [historyUrl("ws-bayon")]: FIRST,
      [historyUrl("ws-bayon", "cursor=c1")]: SECOND,
    });
    const user = userEvent.setup();
    const first = (await items())[0];
    expect(first?.getAttribute("aria-setsize")).toBe("-1");
    await user.click(screen.getByRole("button", { name: "Load older" }));
    expect(
      await screen.findByText(
        "The beginning of this project's history: 52 events.",
      ),
    ).toBeTruthy();
    expect((await items())[0]?.getAttribute("aria-setsize")).toBe("52");
    expect(
      callsTo(fetchMock, historyUrl("ws-bayon", "cursor=c1")),
    ).toHaveLength(1);
    expect(
      errors.mock.calls.flat().some((arg) => String(arg).includes("same key")),
    ).toBe(false);
  });

  test("scrolling near the end reads the next page on its own", async () => {
    const fetchMock = renderIde(HISTORY, BAYON, {
      [historyUrl("ws-bayon")]: FIRST,
      [historyUrl("ws-bayon", "cursor=c1")]: SECOND,
    });
    const list = await history();
    expect(
      callsTo(fetchMock, historyUrl("ws-bayon", "cursor=c1")),
    ).toHaveLength(0);
    act(() => list.parentElement?.scrollTo({ top: 50 * 32 }));
    await waitFor(() =>
      expect(
        callsTo(fetchMock, historyUrl("ws-bayon", "cursor=c1")),
      ).toHaveLength(1),
    );
    const summaries = (await items()).map(
      (item) => /row \d+/.exec(item.textContent ?? "")?.[0],
    );
    expect(summaries.at(-1)).toBe("row 51");
    expect(new Set(summaries).size).toBe(summaries.length);
  });
});

test("a page that adds no new row starts no other read on its own; Load older still reads on", async () => {
  // The repeat page is held until the list shows it loading, as a real network would.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchMock = renderIde(HISTORY, BAYON, {
    [historyUrl("ws-bayon")]: timelinePage(numbered(0, 50), "c1"),
    // Every row a repeat, and a cursor on: a server whose cursor stuck.
    [historyUrl("ws-bayon", "cursor=c1")]: async () => {
      await held;
      return timelinePage(numbered(40, 10), "c2");
    },
    [historyUrl("ws-bayon", "cursor=c2")]: timelinePage(numbered(50, 1)),
  });
  const user = userEvent.setup();
  const list = await history();
  act(() => list.parentElement?.scrollTo({ top: 50 * 32 }));
  expect(await screen.findByText("Loading older events…")).toBeTruthy();
  await act(async () => release());
  await screen.findByRole("button", { name: "Load older" });
  // Let the render after that page commit its effects and any read they start (no timers).
  for (let i = 0; i < 5; i += 1) await act(() => Promise.resolve());
  expect(callsTo(fetchMock, historyUrl("ws-bayon", "cursor=c1"))).toHaveLength(
    1,
  );
  expect(callsTo(fetchMock, historyUrl("ws-bayon", "cursor=c2"))).toHaveLength(
    0,
  );
  await user.click(screen.getByRole("button", { name: "Load older" }));
  expect(
    await screen.findByText(
      "The beginning of this project's history: 51 events.",
    ),
  ).toBeTruthy();
});

describe("export", () => {
  const PREFLIGHT =
    "/api/v1/projects/ws-bayon/timeline?limit=1&kind=audit.*&q=deploy";
  const FILTERED = `${HISTORY}?kind=audit&q=deploy`;
  const LIST = historyUrl("ws-bayon", "kind=audit.*&q=deploy");

  test("checks the current filters, then downloads them through a same-origin link", async () => {
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    const fetchMock = renderIde(FILTERED, BAYON, {
      [LIST]: timelinePage([AUDIT_ROW]),
      [PREFLIGHT]: timelinePage([AUDIT_ROW], "c"),
    });
    const user = userEvent.setup();
    await rowOf("operator paused");
    await user.click(screen.getByRole("button", { name: "Export" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Export CSV" }),
    );
    expect(await screen.findByText("CSV download started")).toBeTruthy();
    expect(callsTo(fetchMock, PREFLIGHT)).toHaveLength(1);
    expect(clicked).toHaveLength(1);
    const link = clicked[0];
    expect(link?.getAttribute("href")).toBe(
      "/api/v1/projects/ws-bayon/timeline/export?format=csv&kind=audit.*&q=deploy",
    );
    expect(link?.getAttribute("download")).toBe("");
    expect(link?.isConnected).toBe(false);
  });

  test("a refused check says why and downloads nothing", async () => {
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    renderIde(FILTERED, BAYON, {
      [LIST]: timelinePage([AUDIT_ROW]),
      [PREFLIGHT]: apiError(
        404,
        "not_found",
        "project ws-bayon does not exist",
      ),
    });
    const user = userEvent.setup();
    await rowOf("operator paused");
    await user.click(screen.getByRole("button", { name: "Export" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Export JSONL" }),
    );
    expect(
      await screen.findByText("Export failed: project ws-bayon does not exist"),
    ).toBeTruthy();
    expect(click).not.toHaveBeenCalled();
  });
});

describe("live", () => {
  test("a tickets frame that brings a newer row shows the pill; show inserts it at the top without reading the list again", async () => {
    const { feed, pushTickets } = pushFeed();
    const NEW = timelineEntry({
      source: "ticket",
      key: "00000000000000000010",
      ts: NOW - MINUTE,
      summary: "FRM-812 review → done",
    });
    const pages = [timelinePage(ROWS), timelinePage([NEW, ...ROWS])];
    const fetchMock = renderIde(
      HISTORY,
      BAYON,
      {
        [historyUrl("ws-bayon")]: () =>
          pages.length > 1 ? pages.shift() : pages[0],
      },
      feed,
    );
    const user = userEvent.setup();
    await rowOf("building → review");
    expect(callsTo(fetchMock, historyUrl("ws-bayon"))).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /new event/ })).toBe(null);

    pushTickets([ticketEvent(1)]);
    const pill = await screen.findByRole("button", {
      name: "1 new event — show",
    });
    expect(callsTo(fetchMock, historyUrl("ws-bayon"))).toHaveLength(2);
    expect(
      (await items()).map((item) => item.getAttribute("aria-posinset")),
    ).toEqual(["1", "2", "3", "4"]);
    expect((await items())[0]?.textContent).toContain("building → review");

    await user.click(pill);
    expect((await items())[0]?.textContent).toContain("review → done");
    expect(await items()).toHaveLength(5);
    expect(screen.queryByRole("button", { name: /new event/ })).toBe(null);
    expect(callsTo(fetchMock, historyUrl("ws-bayon"))).toHaveLength(2);
  });
});
