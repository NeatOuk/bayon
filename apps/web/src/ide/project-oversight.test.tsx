import type { InboxItem, SpendReport, SpendSummary } from "@bayon/proto";
import { QueryClient } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test } from "vitest";
import {
  evidence,
  gateSummary,
  gateTicket,
  gatesPage,
} from "@/test/gate-fixtures";
import { navigate, renderIde, tabNames } from "@/test/ide-harness";
import { inboxItem, inboxPage } from "@/test/inbox-fixtures";
import { projectView, projectsView } from "@/test/project-fixtures";
import { pushFeed } from "@/test/push-feed";
import { apiError, bodyOf, callsTo, type FetchMock } from "@/test/render";
import {
  alarmedSummary,
  classSpend,
  dailySpend,
  droppedSummary,
  spendSummary,
  ticketSpend,
  tierSpend,
} from "@/test/spend-fixtures";

// One project's Reviews, Inbox and Spend inside its IDE: the fleet screens' own
// components, each asking for `project=`, each link opening a tab beside the view, each live by
// refetching its own query on a frame, since a fleet-wide frame carries no project.

const BAYON = projectView();
const IDE = "#/p/ws-bayon";
const REVIEWS =
  "/api/v1/gates?state=running%2Cfailed&latest=1&limit=100&project=ws-bayon";
const FLEET_QUEUE = "/api/v1/gates?state=running%2Cfailed&latest=1&limit=100";
const inboxUrl = (status: "open" | "answered") =>
  `/api/v1/inbox?status=${status}&project=ws-bayon`;
const spendUrl = (group: SpendReport["group"]) =>
  `/api/v1/spend?group=${group}&project=ws-bayon`;

afterEach(() => {
  window.location.hash = "";
  window.localStorage.clear();
});

const reads = (fetchMock: FetchMock, url: string) =>
  callsTo(fetchMock, url).length;

test("the explorer groups the views: Work, Team, Records, then Project settings", async () => {
  renderIde(`${IDE}/overview`, BAYON);
  const explorer = await screen.findByRole("navigation", { name: "explorer" });
  const views = within(explorer)
    .getAllByRole("link")
    .filter((link) => link.getAttribute("href")?.startsWith(`${IDE}/`))
    .filter((link) => !link.getAttribute("href")?.includes("?open="));
  expect(views.map((link) => link.textContent)).toEqual([
    "Overview",
    "Tickets",
    "Reviews",
    "Inbox",
    "Orchestrator",
    "Agents2",
    "Spend",
    "History",
    "Project settings",
  ]);
  // each group is a list named by its label.
  for (const [group, first] of [
    ["Work", "Overview"],
    ["Team", "Orchestrator"],
    ["Records", "Spend"],
    ["Admin", "Project settings"],
  ] as const)
    expect(
      within(within(explorer).getByRole("list", { name: group }))
        .getAllByRole("link")[0]
        ?.textContent?.startsWith(first),
      group,
    ).toBe(true);
  expect(
    within(explorer).getByRole("link", { name: "Spend" }).getAttribute("href"),
  ).toBe(`${IDE}/spend`);
});

describe("Reviews", () => {
  const FAILED = gateSummary(
    {
      id: "g1",
      kind: "code_review",
      state: "failed",
      reason: "blocking_findings",
      session_id: "S-rev",
      evidence: evidence(),
    },
    gateTicket(812, { title: "transfer idempotency" }),
  );

  test("asks for the project's gates, never the fleet's; a ticket and a reviewer session open as tabs", async () => {
    const fetchMock = renderIde(`${IDE}/reviews`, BAYON, {
      [REVIEWS]: gatesPage([FAILED]),
    });
    expect(
      await screen.findByRole("heading", { name: "Reviews" }),
    ).toBeTruthy();
    const failed = await screen.findByRole("region", { name: "failed" });
    expect(reads(fetchMock, FLEET_QUEUE)).toBe(0);
    const user = userEvent.setup();
    await user.click(
      within(failed).getByRole("link", {
        name: "FRM-812 transfer idempotency",
      }),
    );
    expect(window.location.hash).toBe(`${IDE}/reviews?open=ticket:812`);
    await waitFor(() => expect(tabNames()).toEqual(["Reviews", "#812"]));

    await user.click(screen.getByRole("tab", { name: "Reviews" }));
    await user.click(
      within(screen.getByRole("region", { name: "failed" })).getByRole("link", {
        name: "reviewer session",
      }),
    );
    expect(window.location.hash).toBe(`${IDE}/reviews?open=session:S-rev`);
    await waitFor(() =>
      expect(tabNames()).toEqual(["Reviews", "#812", "session S-rev"]),
    );
  });

  test("rerun and waive post as on the fleet's queue, and refetch the project's", async () => {
    let reran = false;
    const RUN = "/api/v1/gates/g1/run";
    const WAIVE = "/api/v1/gates/g2/waive";
    const fetchMock = renderIde(`${IDE}/reviews`, BAYON, {
      [REVIEWS]: () =>
        gatesPage(
          reran
            ? [gateSummary({ id: "g2", kind: "code_review", attempt: 2 })]
            : [FAILED],
        ),
      [RUN]: () => {
        reran = true;
        return {
          gate_id: "g2",
          attempt: 2,
          command_id: "cmd-1",
          session_id: "S-2",
        };
      },
      [WAIVE]: () => apiError(409, "conflict", "gate g2 is passed"),
    });
    const user = userEvent.setup();
    const failed = await screen.findByRole("region", { name: "failed" });
    await user.click(within(failed).getByRole("button", { name: "Rerun" }));
    const running = screen.getByRole("region", { name: "running" });
    expect(await within(running).findByText("code_review #2")).toBeTruthy();
    expect(callsTo(fetchMock, RUN, "POST")).toHaveLength(1);
    expect(reads(fetchMock, REVIEWS)).toBeGreaterThanOrEqual(2);

    await user.click(within(running).getByRole("button", { name: "Waive" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Reason"), "flaky reviewer");
    await user.click(
      within(dialog).getByRole("button", { name: "Waive gate" }),
    );
    await waitFor(() =>
      expect(bodyOf(fetchMock, WAIVE, "POST")).toEqual({
        reason: "flaky reviewer",
      }),
    );
    expect(
      await screen.findByText(/code_review #2 changed before your write/),
    ).toBeTruthy();
  });

  test("a gates frame refetches the project's queue; its fleet-wide rows are never shown", async () => {
    let page = gatesPage([]);
    const { feed, pushGates } = pushFeed();
    const fetchMock = renderIde(
      `${IDE}/reviews`,
      BAYON,
      { [REVIEWS]: () => page },
      feed,
    );
    expect(await screen.findByText("Nothing to review")).toBeTruthy();
    page = gatesPage([FAILED]);
    pushGates(
      gatesPage([
        gateSummary(
          { id: "g-other", kind: "plan_review", state: "failed" },
          gateTicket(99, { title: "another project's" }),
        ),
      ]),
    );
    expect(
      await screen.findByRole("link", { name: "FRM-812 transfer idempotency" }),
    ).toBeTruthy();
    expect(screen.queryByText(/another project's/)).toBeNull();
    expect(reads(fetchMock, REVIEWS)).toBe(2);
    expect(reads(fetchMock, FLEET_QUEUE)).toBe(0);
  });
});

describe("Inbox", () => {
  const ASKED: InboxItem = inboxItem({
    id: "R1",
    question: "Which branch?",
    options: ["main", "next"],
  });
  const answerUrl = "/api/v1/inbox/R1/answer";

  test("asks for the project's open and answered requests; a ticket and a session open as tabs", async () => {
    const fetchMock = renderIde(`${IDE}/inbox`, BAYON, {
      [inboxUrl("open")]: inboxPage([ASKED]),
      [inboxUrl("answered")]: inboxPage([
        inboxItem({
          id: "R0",
          question: "Ship it?",
          status: "answered",
          answer: "yes",
          answered_by: "operator",
        }),
      ]),
    });
    const open = await screen.findByRole("region", { name: "open requests" });
    expect(within(open).getByText("Which branch?")).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Answered" }));
    expect(await screen.findByText("Answer: yes")).toBeTruthy();
    // The view's tab is the address's, rewritten in place.
    expect(window.location.hash).toBe(`${IDE}/inbox?tab=answered`);
    expect(reads(fetchMock, inboxUrl("answered"))).toBe(1);
    expect(reads(fetchMock, "/api/v1/inbox?status=open")).toBe(0);

    await user.click(screen.getByRole("tab", { name: "Open" }));
    await user.click(
      within(
        await screen.findByRole("region", { name: "open requests" }),
      ).getByRole("link", { name: "#812" }),
    );
    expect(window.location.hash).toBe(`${IDE}/inbox?open=ticket:812`);
    await waitFor(() => expect(tabNames()).toEqual(["Inbox", "#812"]));
    await user.click(screen.getByRole("tab", { name: "Inbox" }));
    await user.click(
      within(
        await screen.findByRole("region", { name: "open requests" }),
      ).getByRole("link", { name: "builder-1" }),
    );
    expect(window.location.hash).toBe(`${IDE}/inbox?open=session:s1`);
  });

  test("an answer posts; a retryable 409 keeps the dialog open with the server's reason", async () => {
    let tries = 0;
    let open = [ASKED];
    const fetchMock = renderIde(`${IDE}/inbox`, BAYON, {
      [inboxUrl("open")]: () => inboxPage(open),
      [inboxUrl("answered")]: inboxPage([]),
      [answerUrl]: () => {
        tries += 1;
        if (tries === 1)
          return Response.json(
            {
              error: {
                class: "conflict",
                message: "the agent is busy",
                retryable: true,
              },
            },
            { status: 409 },
          );
        open = [];
        return { ...ASKED, status: "answered", answer: "main" };
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Answer" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "main" }));
    await user.click(within(dialog).getByRole("button", { name: "Send" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "the agent is busy",
    );
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(screen.queryByText("Already answered")).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(bodyOf(fetchMock, answerUrl, "POST")).toEqual({ answer: "main" });
    expect(await screen.findByText("Nothing needs you")).toBeTruthy();
  });

  test("an inbox frame refetches the project's lists, never showing its fleet-wide rows", async () => {
    let open: InboxItem[] = [];
    const { feed, pushInbox } = pushFeed();
    const fetchMock = renderIde(
      `${IDE}/inbox`,
      BAYON,
      {
        [inboxUrl("open")]: () => inboxPage(open),
        [inboxUrl("answered")]: inboxPage([]),
      },
      feed,
    );
    expect(await screen.findByText("Nothing needs you")).toBeTruthy();
    open = [ASKED];
    pushInbox(
      inboxPage([inboxItem({ id: "R-other", question: "Someone else's?" })]),
    );
    expect(await screen.findByText("Which branch?")).toBeTruthy();
    expect(screen.queryByText("Someone else's?")).toBeNull();
    expect(reads(fetchMock, inboxUrl("open"))).toBe(2);
  });
});

describe("Spend", () => {
  const report = (
    group: SpendReport["group"],
    summary: SpendSummary = spendSummary(),
  ): SpendReport => {
    switch (group) {
      case "day":
        return { group, summary, rows: [dailySpend(0, 14.3)] };
      case "ticket":
        return {
          group,
          summary,
          rows: [ticketSpend({ num: 812, title: "transfer" })],
        };
      case "tier":
        return { group, summary, rows: [tierSpend("complex")] };
      case "class":
        return { group, summary, rows: [classSpend("build")] };
    }
  };

  test("asks for the project's report: the headline, this project's burn and alarm, each grouping; a ticket opens as a tab", async () => {
    const raised = alarmedSummary();
    // Up yesterday, down over the week: each move in percent and in dollars a day.
    const moved: SpendSummary = {
      ...raised,
      alarm: {
        ...raised.alarm,
        last_7d: {
          daily_usd: 2,
          baseline_daily_usd: 4,
          change_pct: -50,
          alarm: false,
          drop: true,
        },
        dropped: true,
      },
    };
    const fetchMock = renderIde(`${IDE}/spend`, BAYON, {
      [spendUrl("day")]: report("day", moved),
      [spendUrl("ticket")]: report("ticket"),
      [spendUrl("tier")]: report("tier"),
      [spendUrl("class")]: report("class"),
    });
    expect(
      await screen.findByText(
        "This project: $14.30 today · $42.50 over the last 30 days",
      ),
    ).toBeTruthy();
    const burn = screen.getByRole("region", { name: "this project's burn" });
    expect(burn.textContent).toContain("Burn · this project");
    expect(burn.textContent).toContain("month to date$120.40");
    // The rise is the alarm; the fall beside it is a calm note, never red.
    const alarm = screen.getByRole("alert").textContent;
    expect(alarm).toContain(
      "Burn alarm: this project's spend rose more than 25%",
    );
    expect(alarm).toContain(
      "last 24 h: $14.30/day, +258% (+$10.30/day) against the 30-day baseline ($4.00/day)",
    );
    expect(alarm).not.toContain("last 7 days");
    const note = screen
      .getByText("This project's spend fell more than 25%")
      .closest('[role="status"]')?.textContent;
    expect(note).toContain(
      "last 7 days: $2.00/day, -50% (-$2.00/day) against the 30-day baseline ($4.00/day)",
    );
    expect(reads(fetchMock, "/api/v1/spend?group=day")).toBe(0);

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "By tier" }));
    expect(await screen.findByText("$7.90")).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "By run class" }));
    expect(await screen.findByText("400,000")).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "By ticket" }));
    await user.click(
      await screen.findByRole("link", { name: "#812 transfer" }),
    );
    expect(window.location.hash).toBe(`${IDE}/spend?open=ticket:812`);
    await waitFor(() => expect(tabNames()).toEqual(["Spend", "#812"]));
  });

  test("a drop in the project is a calm note, never the alarm", async () => {
    renderIde(`${IDE}/spend`, BAYON, {
      [spendUrl("day")]: report("day", droppedSummary()),
    });
    const title = await screen.findByText(
      "This project's spend fell more than 25%",
    );
    expect(title.closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("while the project is paused its drop says nothing", async () => {
    renderIde(`${IDE}/spend`, BAYON, {
      [spendUrl("day")]: report("day", droppedSummary(true)),
    });
    expect(
      await screen.findByRole("region", { name: "this project's burn" }),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/spend fell/)).toBeNull();
  });

  test("pausing the project refetches its Spend: whether a drop is reported rides on the pause", async () => {
    // Never stale on its own, so only an invalidation makes Spend read again when it remounts.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    let paused = false;
    const PAUSE = "/api/v1/projects/ws-bayon/pause";
    const fetchMock = renderIde(
      `${IDE}/spend`,
      BAYON,
      {
        [spendUrl("day")]: () => report("day", droppedSummary(paused)),
        "/api/v1/projects": () => projectsView({ ...BAYON, paused }),
        [PAUSE]: () => {
          paused = true;
          return { project: "ws-bayon", paused: true, changed: true };
        },
      },
      undefined,
      queryClient,
    );
    expect(
      await screen.findByText("This project's spend fell more than 25%"),
    ).toBeTruthy();
    const orchestrator = async () => {
      await navigate(`${IDE}/orchestrator`);
      return within(
        await screen.findByRole("region", { name: "controls" }),
      ).getByRole("group", { name: "Pause project" });
    };
    // Away and back with nothing written: the cached report, no read.
    await orchestrator();
    await navigate(`${IDE}/spend`);
    await screen.findByText("This project's spend fell more than 25%");
    expect(reads(fetchMock, spendUrl("day"))).toBe(1);

    const user = userEvent.setup();
    await user.click(
      within(await orchestrator()).getByRole("switch", {
        name: "Pause project",
      }),
    );
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Pause project",
      }),
    );
    await waitFor(() =>
      expect(callsTo(fetchMock, PAUSE, "POST")).toHaveLength(1),
    );
    await navigate(`${IDE}/spend`);
    await waitFor(() => expect(reads(fetchMock, spendUrl("day"))).toBe(2));
    await waitFor(() => expect(screen.queryByText(/spend fell/)).toBeNull());
  });

  test("a spend frame refetches when the fleet's money moved, not when only the clock did, and its figures are never shown", async () => {
    let served = 0;
    const { feed, pushSpend } = pushFeed();
    const fetchMock = renderIde(
      `${IDE}/spend`,
      BAYON,
      {
        [spendUrl("day")]: () => {
          served += 1;
          return report(
            "day",
            spendSummary({
              burn: {
                today_usd: served,
                month_to_date_usd: 1,
                projected_month_usd: 1,
              },
            }),
          );
        },
      },
      feed,
    );
    const headline = (today: number) =>
      screen.findByText(
        `This project: $${today.toFixed(2)} today · $42.50 over the last 30 days`,
      );
    expect(await headline(1)).toBeTruthy();

    const fleet = spendSummary({ total_usd: 999 });
    pushSpend(fleet);
    expect(await headline(2)).toBeTruthy();
    // The clock moved, the money did not: nothing to refetch.
    pushSpend({
      ...fleet,
      window: { from: fleet.window.from + 1_000, to: fleet.window.to + 1_000 },
      burn: { ...fleet.burn, projected_month_usd: 311 },
    });
    pushSpend({ ...fleet, total_usd: 1_000 });
    expect(await headline(3)).toBeTruthy();
    expect(reads(fetchMock, spendUrl("day"))).toBe(3);
    expect(screen.queryByText(/\$999\.00|\$1000\.00/)).toBeNull();
  });
});
