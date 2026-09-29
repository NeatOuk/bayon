import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { BudgetStat } from "@/fleet/budget-bar";
import { renderWithProviders } from "@/test/render";

const bar = () => screen.getByRole("progressbar");
const card = () => screen.getByRole("group", { name: "Today's spend" });

test("with a cap, the stat shows the spend, the cap and the share of it spent", () => {
  renderWithProviders(<BudgetStat spentUsd={10} capUsd={40} />);
  expect(card().textContent).toContain("$10.00 of $40.00");
  expect(card().textContent).toContain("25% of the daily cap");
  expect(bar().getAttribute("aria-valuenow")).toBe("25");
});

test("over the cap, the bar is full and in the danger tone", () => {
  renderWithProviders(<BudgetStat spentUsd={50} capUsd={40} />);
  expect(bar().getAttribute("aria-valuenow")).toBe("100");
  expect(card().textContent).toContain("Over the daily cap");
  expect(bar().className).toContain("bg-danger");
});

test("without a cap there is spend and no bar", () => {
  renderWithProviders(<BudgetStat spentUsd={1.6} capUsd={null} />);
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(card().textContent).toContain("$1.60");
  expect(card().textContent).toContain("No daily cap");
});

test("carries the edit control, so the cap can be changed from the stat", () => {
  renderWithProviders(<BudgetStat spentUsd={0} capUsd={null} />);
  expect(screen.getByRole("button", { name: "Edit cap" })).toBeDefined();
});
