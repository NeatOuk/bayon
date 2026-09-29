import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { NARROW_QUERY } from "@/app-shell/use-narrow";
import { navigate, renderIde } from "@/test/ide-harness";
import { projectView } from "@/test/project-fixtures";

// Below `lg`: no sidebar column; a menu button in the top bar opens the same sidebar as
// a modal sheet — focus held inside, Esc closes it, and any navigation closes it.

const BAYON = projectView();
const original = Object.getOwnPropertyDescriptor(window, "matchMedia");

/** A window whose width the test sets, answering the narrow query and firing `change` as it moves. */
function fakeWidth(narrow: boolean) {
  const list = Object.assign(new EventTarget(), {
    matches: narrow,
    media: NARROW_QUERY,
  });
  const other = Object.assign(new EventTarget(), { matches: false });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (media: string) => (media === NARROW_QUERY ? list : other),
  });
  return {
    resize(next: boolean) {
      list.matches = next;
      act(() => {
        list.dispatchEvent(new Event("change"));
      });
    },
  };
}

beforeEach(() => {
  fakeWidth(true);
});
afterEach(() => {
  if (original !== undefined)
    Object.defineProperty(window, "matchMedia", original);
  window.location.hash = "";
});

const menuButton = () => screen.getByRole("button", { name: "Navigation" });

test("narrow: no sidebar column, a menu button instead; it opens the sidebar in a modal sheet", async () => {
  renderIde("#/", BAYON);
  expect(screen.queryByRole("navigation", { name: "main" })).toBeNull();
  const user = userEvent.setup();
  await user.click(menuButton());
  const sheet = await screen.findByRole("dialog", { name: "Navigation" });
  // Modal: the page behind it is out of reach, the top bar included.
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "User menu" })).toBeNull(),
  );
  const nav = within(sheet).getByRole("navigation", { name: "main" });
  expect(within(nav).getByRole("link", { name: "Fleet" })).toBeTruthy();
  // Focus is inside the sheet, and Tab keeps it there.
  await waitFor(() =>
    expect(sheet.contains(document.activeElement)).toBe(true),
  );
  for (let i = 0; i < 25; i++) await user.tab();
  expect(sheet.contains(document.activeElement)).toBe(true);
});

test("Esc closes the sheet and focus returns to the menu button", async () => {
  renderIde("#/", BAYON);
  const user = userEvent.setup();
  await user.click(menuButton());
  await screen.findByRole("dialog", { name: "Navigation" });
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(menuButton()));
});

test("a pick in the sheet navigates and closes it; so does any other navigation", async () => {
  renderIde("#/", BAYON);
  const user = userEvent.setup();
  await user.click(menuButton());
  const sheet = await screen.findByRole("dialog", { name: "Navigation" });
  await user.click(within(sheet).getByRole("link", { name: "Runners" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(window.location.hash).toBe("#/runners");

  await user.click(menuButton());
  await screen.findByRole("dialog", { name: "Navigation" });
  navigate("#/audit");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("inside a project the sheet holds its explorer; widening the window brings the column back", async () => {
  const width = fakeWidth(true);
  renderIde("#/p/ws-bayon/overview", BAYON);
  const user = userEvent.setup();
  await user.click(menuButton());
  const sheet = await screen.findByRole("dialog", { name: "Navigation" });
  expect(
    await within(sheet).findByRole("navigation", { name: "explorer" }),
  ).toBeTruthy();
  width.resize(false);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.queryByRole("button", { name: "Navigation" })).toBeNull();
  expect(
    await screen.findByRole("navigation", { name: "explorer" }),
  ).toBeTruthy();
});
