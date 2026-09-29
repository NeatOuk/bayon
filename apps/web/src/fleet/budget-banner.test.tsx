import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { BudgetBanner } from "@/fleet/budget-banner";
import { budgetView } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render";

// §13.4's warn on the Fleet: nothing until a budget reaches its own warn_pct, then one line per
// budget, and a different headline once one is actually at its cap.

const banner = () => screen.queryByLabelText("budget alert");
const text = () => banner()?.textContent ?? "";

test("no banner at all while every budget is under its warn threshold", () => {
  renderWithProviders(
    <BudgetBanner budgets={[budgetView({ spent_usd: 69 })]} />,
  );
  expect(banner()).toBeNull();
});

test("no banner when there are no budgets", () => {
  renderWithProviders(<BudgetBanner budgets={[]} />);
  expect(banner()).toBeNull();
});

test("at the warn threshold it warns, naming the scope, period and spend", () => {
  renderWithProviders(
    <BudgetBanner budgets={[budgetView({ spent_usd: 70 })]} />,
  );
  expect(text()).toContain("close to its cap");
  expect(text()).toContain("the fleet · day · $70.00 of $100.00 (70%)");
});

test("each budget uses its own warn_pct, not a constant", () => {
  // 60 % spent: past a budget that warns at 50, short of one that warns at 90.
  renderWithProviders(
    <BudgetBanner
      budgets={[
        budgetView({ id: "b-warns", warn_pct: 50, spent_usd: 60 }),
        budgetView({ id: "b-quiet", warn_pct: 90, spent_usd: 60 }),
      ]}
    />,
  );
  expect(screen.getAllByText(/the fleet · day/)).toHaveLength(1);
});

test("a budget at its cap says spawns are queued, and sorts above a mere warning", () => {
  renderWithProviders(
    <BudgetBanner
      budgets={[
        budgetView({ id: "b-warn", spent_usd: 75 }),
        budgetView({
          id: "b-spent",
          scope: "agent",
          scope_ref: "builder-1",
          spent_usd: 100,
        }),
      ]}
    />,
  );
  expect(text()).toContain("new sessions are queued");
  const lines = screen.getAllByText(/ · day · /);
  // The fullest budget first: the breached agent one, then the fleet's warning.
  expect(lines[0]?.textContent).toContain("builder-1");
  expect(lines[1]?.textContent).toContain("the fleet");
});

test("a warn-only budget at its cap says so without claiming anything is queued", () => {
  renderWithProviders(
    <BudgetBanner
      budgets={[budgetView({ on_breach: "warn", spent_usd: 100 })]}
    />,
  );
  expect(text()).toContain("A budget is spent");
  expect(text()).not.toContain("queued");
});

test("a token cap counts too, and is reported in tokens", () => {
  renderWithProviders(
    <BudgetBanner
      budgets={[
        budgetView({ cap_usd: null, cap_tokens: 1000, spent_tokens: 800 }),
      ]}
    />,
  );
  expect(text()).toContain("the fleet · day · 800 of 1000 tokens (80%)");
});
