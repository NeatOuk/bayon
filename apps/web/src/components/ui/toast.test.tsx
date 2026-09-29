import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { Toaster, notify } from "@/components/ui/toast";

// Toasts: one Toaster shows what notify says, a success as a status and an error as an
// alert, each dismissable.

test("a success toast is a status with its title and description", async () => {
  render(<Toaster />);
  act(() => {
    notify.success("Budget cap saved", "The fleet's daily cap is now $40.");
  });
  const toast = await screen.findByRole("status", { name: "Budget cap saved" });
  expect(
    within(toast).getByText("The fleet's daily cap is now $40."),
  ).toBeTruthy();
  expect(toast.querySelector("svg")?.getAttribute("class")).toContain(
    "text-success",
  );
  expect(
    screen.getByRole("region", { name: "Notifications" }).contains(toast),
  ).toBe(true);
});

test("an error toast is an alert, and Dismiss closes it", async () => {
  // base-ui hides the close button from assistive tech until the toasts have focus (F6 moves it
  // there), so it is found by its label.
  render(<Toaster />);
  act(() => {
    notify.error("Could not copy");
  });
  const toast = await screen.findByRole("alert", { name: "Could not copy" });
  expect(toast.querySelector("svg")?.getAttribute("class")).toContain(
    "text-danger",
  );
  await userEvent.setup().click(within(toast).getByLabelText("Dismiss"));
  await expect.poll(() => screen.queryByRole("alert")).toBe(null);
});

test("with no Toaster mounted, notify is harmless", () => {
  expect(() => notify.success("nobody listens")).not.toThrow();
});
