import type { SpendReport } from "@bayon/proto";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { SpendScreen } from "@/spend/spend-screen";
import { pushFeed } from "@/test/push-feed";
import { apiError, renderWithProviders, stubFetch } from "@/test/render";
import {
  alarmedSummary,
  classSpend,
  dailySpend,
  droppedSummary,
  spendSummary,
  ticketSpend,
  tierSpend,
} from "@/test/spend-fixtures";

const spendUrl = (group: SpendReport["group"]) =>
  `/api/v1/spend?group=${group}`;

const byDay = (
  summary = spendSummary(),
  rows = [dailySpend(1, 3.2), dailySpend(0, 14.3)],
): SpendReport => ({ group: "day", summary, rows });

test("the burn shows today, month to date, the projection, the window and the waste; days newest first", async () => {
  stubFetch({ [spendUrl("day")]: byDay() });
  renderWithProviders(<SpendScreen />);
  expect(screen.getByRole("status").textContent).toBe("Loading spend…");
  const burn = await screen.findByRole("region", { name: "burn" });
  for (const figure of [
    "today$14.30",
    "month to date$120.40",
    "projected month$310.20",
    "last 30 days$42.50",
    "$3.80 (8.9%)",
  ])
    expect(burn.textContent).toContain(figure);
  expect(screen.queryByRole("alert")).toBeNull();
  const rows = screen.getAllByRole("row").slice(1);
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringContaining("$14.30"),
    expect.stringContaining("$3.20"),
  ]);
});

test("the alarm banner says how far burn moved against the baseline, in percent and dollars a day", async () => {
  stubFetch({ [spendUrl("day")]: byDay(alarmedSummary(), []) });
  renderWithProviders(<SpendScreen />);
  const alarm = await screen.findByRole("alert");
  expect(alarm.textContent).toContain("Burn alarm: spend rose more than 25%");
  expect(alarm.textContent).toContain(
    "last 24 h: $14.30/day, +258% (+$10.30/day) against the 30-day baseline ($4.00/day)",
  );
  expect(alarm.textContent).not.toContain("last 7 days");
  expect(screen.getByText("No spend in the window.")).toBeTruthy();
});

test("a drop is a calm note, never the alarm", async () => {
  stubFetch({ [spendUrl("day")]: byDay(droppedSummary(), []) });
  renderWithProviders(<SpendScreen />);
  const title = await screen.findByText("Spend fell more than 25%");
  const note = title.closest('[role="status"]');
  if (note === null) throw new Error("the drop note is not a status");
  expect(note.textContent).toContain(
    "last 24 h: $0.00/day, -100% (-$5.90/day) against the 30-day baseline ($5.90/day)",
  );
  expect(note.getAttribute("class")).toContain("bg-info-subtle");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(/Burn alarm/)).toBeNull();
});

test("while the fleet is paused a drop says nothing", async () => {
  stubFetch({ [spendUrl("day")]: byDay(droppedSummary(true), []) });
  renderWithProviders(<SpendScreen />);
  await screen.findByRole("region", { name: "burn" });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByText(/Spend fell/)).toBeNull();
});

test("each grouping is a tab: tickets link to their detail, tiers and run classes show theirs", async () => {
  const summary = spendSummary();
  stubFetch({
    [spendUrl("day")]: byDay(),
    [spendUrl("ticket")]: {
      group: "ticket",
      summary,
      rows: [
        ticketSpend({ num: 812, title: "transfer", status: "code_review" }),
      ],
    },
    [spendUrl("tier")]: {
      group: "tier",
      summary,
      rows: [tierSpend("complex")],
    },
    [spendUrl("class")]: {
      group: "class",
      summary,
      rows: [classSpend("build")],
    },
  });
  const user = userEvent.setup();
  renderWithProviders(<SpendScreen />);
  await user.click(await screen.findByRole("tab", { name: "By ticket" }));
  expect(
    (await screen.findByRole("link", { name: "#812 transfer" })).getAttribute(
      "href",
    ),
  ).toBe("#/tickets/812");
  expect(screen.getByText("71%")).toBeTruthy();
  // The ticket's status in words, not the stored value.
  expect(screen.getByText("Code review")).toBeTruthy();
  await user.click(screen.getByRole("tab", { name: "By tier" }));
  expect(await screen.findByText("$7.90")).toBeTruthy();
  await user.click(screen.getByRole("tab", { name: "By run class" }));
  expect(await screen.findByText("400,000")).toBeTruthy();
});

test("a spend frame replaces the summary, and can raise the alarm", async () => {
  stubFetch({ [spendUrl("day")]: byDay() });
  const { feed, pushSpend } = pushFeed();
  renderWithProviders(<SpendScreen />, { feed });
  await screen.findByRole("region", { name: "burn" });
  expect(screen.queryByRole("alert")).toBeNull();
  pushSpend(alarmedSummary());
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Burn alarm",
  );
});

test("a failed read says so", async () => {
  stubFetch({ [spendUrl("day")]: () => apiError(500, "internal", "db down") });
  renderWithProviders(<SpendScreen />);
  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("Spend is unavailable")).toBeTruthy();
  expect(within(alert).getByText("db down")).toBeTruthy();
});

test("the day and run-class tables carry what context compression saved, an estimate", async () => {
  const summary = spendSummary();
  stubFetch({
    [spendUrl("day")]: byDay(summary, [
      { ...dailySpend(0, 14.3), tokens_saved: 123_456 },
    ]),
    [spendUrl("class")]: {
      group: "class",
      summary,
      rows: [{ ...classSpend("build"), tokens_saved: 98_765 }],
    },
  });
  const user = userEvent.setup();
  renderWithProviders(<SpendScreen />);
  expect(
    await screen.findByRole("columnheader", { name: "saved (est.)" }),
  ).toBeTruthy();
  expect(screen.getByText("123,456")).toBeTruthy();
  await user.click(screen.getByRole("tab", { name: "By run class" }));
  expect(await screen.findByText("98,765")).toBeTruthy();
  expect(
    screen.getByRole("columnheader", { name: "saved (est.)" }),
  ).toBeTruthy();
});
