import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { navigate, renderIde } from "@/test/ide-harness";
import { projectView } from "@/test/project-fixtures";

// One address per screen: an alias opens the screen it names and is rewritten in the
// address bar in place, so back still returns to where it was followed from; an address no screen
// answers to is Not found, never the Fleet.

const BAYON = projectView();

afterEach(() => {
  window.location.hash = "";
});

const current = () =>
  within(screen.getByRole("navigation", { name: "explorer" })).getByRole(
    "link",
    { current: "page" },
  ).textContent;

test.each([
  ["#/tickets?project=ws-bayon", "#/p/ws-bayon/tickets", "Tickets"],
  ["#/inbox?project=ws-bayon", "#/p/ws-bayon/inbox", "Inbox"],
  [
    "#/inbox?project=ws-bayon&ticket=82",
    "#/p/ws-bayon/inbox?ticket=82",
    "Inbox",
  ],
  ["#/spend?project=ws-bayon", "#/p/ws-bayon/spend", "Spend"],
  ["#/reviews?project=ws-bayon", "#/p/ws-bayon/reviews", "Reviews"],
])(
  "%j opens the project's view and becomes %j, with no history entry of its own",
  async (alias, canonical, view) => {
    renderIde("#/", BAYON);
    const before = window.history.length;
    navigate(alias);
    await waitFor(() => expect(window.location.hash).toBe(canonical));
    // The alias's own entry was replaced, not followed by another.
    expect(window.history.length).toBe(before + 1);
    expect(
      await screen.findByRole("navigation", { name: "explorer" }),
    ).toBeTruthy();
    expect(current()).toMatch(new RegExp(`^${view}`));
  },
);

test("an alias opened directly is rewritten too; the old review queue address is Reviews", async () => {
  renderIde("#/review", BAYON);
  await waitFor(() => expect(window.location.hash).toBe("#/reviews"));
  expect(
    within(screen.getByRole("navigation", { name: "main" }))
      .getByRole("link", { name: "Reviews" })
      .getAttribute("aria-current"),
  ).toBe("page");
});

test("an address no screen answers to is Not found, with the way to the Fleet", async () => {
  renderIde("#/", BAYON);
  for (const hash of ["#/somewhere", "#/tickets/0", "#/p/ws-bayon/bogus"]) {
    navigate(hash);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Not found" }),
    ).toBeTruthy();
    expect(screen.getByText(hash)).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Go to the Fleet" })
        .getAttribute("href"),
    ).toBe("#/");
    expect(screen.queryByText(/no live sessions/i)).toBeNull();
  }
  navigate("#/");
  expect(await screen.findByText(/no live sessions/i)).toBeTruthy();
});
