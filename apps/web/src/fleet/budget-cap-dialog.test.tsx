import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { BudgetCapDialog } from "@/fleet/budget-cap-dialog";
import { renderWithProviders, stubFetch } from "@/test/render";

const putCalls = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT");

const putBody = (fetchMock: ReturnType<typeof stubFetch>): unknown => {
  const [, init] = putCalls(fetchMock)[0] ?? [];
  return JSON.parse((init?.body as string | undefined) ?? "null") as unknown;
};

const capInput = () => screen.getByLabelText("Cap (USD)") as HTMLInputElement;

const open = async () => {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Edit cap" }));
  return user;
};

const dialogClosed = () =>
  waitFor(() => expect(screen.queryByText("Daily budget cap")).toBeNull());

test("Save sends the typed amount as the new cap", async () => {
  const fetchMock = stubFetch({
    "/api/v1/settings/budget": { daily_cap_usd: 25 },
  });
  renderWithProviders(<BudgetCapDialog capUsd={null} />);
  const user = await open();
  await user.type(capInput(), "25");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await dialogClosed();
  expect(putCalls(fetchMock)).toHaveLength(1);
  expect(putBody(fetchMock)).toEqual({ daily_cap_usd: 25 });
  // The dialog does not close silently: a toast says what was saved.
  const toast = await screen.findByRole("status", { name: "Budget cap saved" });
  expect(toast.textContent).toContain(
    "The Fleet warns once today's spend passes $25.00.",
  );
});

test("No cap clears an existing cap, ignoring whatever is typed", async () => {
  const fetchMock = stubFetch({
    "/api/v1/settings/budget": { daily_cap_usd: null },
  });
  renderWithProviders(<BudgetCapDialog capUsd={40} />);
  const user = await open();
  expect(capInput().value).toBe("40");
  await user.click(screen.getByRole("button", { name: "No cap" }));
  await dialogClosed();
  expect(putCalls(fetchMock)).toHaveLength(1);
  expect(putBody(fetchMock)).toEqual({ daily_cap_usd: null });
  expect(
    (await screen.findByRole("status", { name: "Budget cap saved" }))
      .textContent,
  ).toContain("No daily cap");
});

test("a negative amount is a validation error and calls nothing", async () => {
  const fetchMock = stubFetch({
    "/api/v1/settings/budget": { daily_cap_usd: 10 },
  });
  renderWithProviders(<BudgetCapDialog capUsd={null} />);
  const user = await open();
  await user.type(capInput(), "-5");
  await user.click(screen.getByRole("button", { name: "Save" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("non-negative");
  expect(putCalls(fetchMock)).toHaveLength(0);
  expect(screen.getByText("Daily budget cap")).toBeDefined();
});

test("an empty amount is a validation error and calls nothing", async () => {
  const fetchMock = stubFetch({
    "/api/v1/settings/budget": { daily_cap_usd: 10 },
  });
  renderWithProviders(<BudgetCapDialog capUsd={null} />);
  await open();
  await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Enter an amount, or choose No cap.");
  expect(putCalls(fetchMock)).toHaveLength(0);
});
