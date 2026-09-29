import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { UserMenu } from "@/app-shell/user-menu";
import { SYSTEM_DARK_QUERY, THEME_STORAGE_KEY } from "@/theme/theme";
import { useTheme } from "@/theme/use-theme";

// The theme control: System / Light / Dark, applied to <html> and remembered; System
// follows the operating system live. It lives in the top bar's user menu.

const original = Object.getOwnPropertyDescriptor(window, "matchMedia");

/** A system appearance the test can flip, firing `change` as a browser does. */
function fakeSystem(dark: boolean) {
  const list = Object.assign(new EventTarget(), {
    matches: dark,
    media: SYSTEM_DARK_QUERY,
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => list,
  });
  return {
    flip(next: boolean) {
      list.matches = next;
      act(() => {
        list.dispatchEvent(
          Object.assign(new Event("change"), { matches: next }),
        );
      });
    },
  };
}

function Harness({
  onLogout = null,
}: {
  readonly onLogout?: (() => void) | null;
}) {
  const theme = useTheme();
  return (
    <UserMenu theme={theme.choice} onTheme={theme.choose} onLogout={onLogout} />
  );
}

const isDark = () => document.documentElement.classList.contains("dark");

async function choose(label: "System" | "Light" | "Dark") {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "User menu" }));
  await user.click(await screen.findByRole("menuitemradio", { name: label }));
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});
afterEach(() => {
  vi.restoreAllMocks();
  if (original !== undefined)
    Object.defineProperty(window, "matchMedia", original);
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

test("with no pick it follows the system, live", () => {
  const system = fakeSystem(true);
  render(<Harness />);
  expect(isDark()).toBe(true);
  expect(screen.getByRole("button", { name: "User menu" }).title).toBe(
    "User menu · theme: System",
  );
  system.flip(false);
  expect(isDark()).toBe(false);
  system.flip(true);
  expect(isDark()).toBe(true);
});

test("a pick applies at once, is remembered, and outlasts a system switch", async () => {
  const system = fakeSystem(false);
  render(<Harness />);
  await choose("Dark");
  expect(isDark()).toBe(true);
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  system.flip(true);
  system.flip(false);
  expect(isDark()).toBe(true);
  await choose("Light");
  expect(isDark()).toBe(false);
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
});

test("the menu marks the current choice; System forgets the pick and hands back to the system", async () => {
  fakeSystem(true);
  localStorage.setItem(THEME_STORAGE_KEY, "light");
  render(<Harness />);
  expect(isDark()).toBe(false);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "User menu" }));
  expect(
    (await screen.findByRole("menuitemradio", { name: "Light" })).getAttribute(
      "aria-checked",
    ),
  ).toBe("true");
  await user.click(screen.getByRole("menuitemradio", { name: "System" }));
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  expect(isDark()).toBe(true);
});

test("no matchMedia and no reachable storage: light, and a pick still applies for the page's life", async () => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: undefined,
  });
  vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
    throw new DOMException("site data blocked", "SecurityError");
  });
  render(<Harness />);
  expect(isDark()).toBe(false);
  await choose("Dark");
  expect(isDark()).toBe(true);
});

test("the user menu holds the theme as a named group, and Log out only behind the edge", async () => {
  const user = userEvent.setup();
  const view = render(<Harness />);
  await user.click(screen.getByRole("button", { name: "User menu" }));
  const group = await screen.findByRole("group", { name: "Theme" });
  expect(
    within(group)
      .getAllByRole("menuitemradio")
      .map((item) => item.textContent),
  ).toEqual(["System", "Light", "Dark"]);
  expect(screen.queryByRole("menuitem", { name: "Log out" })).toBeNull();
  await user.keyboard("{Escape}");
  view.unmount();

  const logout = vi.fn();
  render(<Harness onLogout={logout} />);
  await user.click(screen.getByRole("button", { name: "User menu" }));
  await user.click(await screen.findByRole("menuitem", { name: "Log out" }));
  expect(logout).toHaveBeenCalledOnce();
});
