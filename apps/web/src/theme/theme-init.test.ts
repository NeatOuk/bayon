import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import html from "../../index.html?raw";
import script from "../../public/theme-init.js?raw";
import {
  resolveDark,
  SYSTEM_DARK_QUERY,
  THEME_CHOICES,
  THEME_STORAGE_KEY,
  type ThemeChoice,
} from "@/theme/theme";

// The pre-paint script: public/theme-init.js, run here as the browser runs it, before
// the app exists. It cannot import theme.ts, so these tests hold the two to one rule.

const original = Object.getOwnPropertyDescriptor(window, "matchMedia");

/** The system's appearance as matchMedia answers it. */
function systemIs(dark: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query === SYSTEM_DARK_QUERY && dark,
      media: query,
    }),
  });
}

const run = (): boolean => {
  new Function(script)();
  return document.documentElement.classList.contains("dark");
};

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

describe("the pre-paint script", () => {
  test("with no pick, a dark system gets .dark and a light one does not", () => {
    systemIs(true);
    expect(run()).toBe(true);
    systemIs(false);
    expect(run()).toBe(false);
  });

  test("a remembered light pick beats a dark system, and dark beats light", () => {
    systemIs(true);
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    expect(run()).toBe(false);
    systemIs(false);
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    expect(run()).toBe(true);
  });

  test("storage that throws falls back to the system", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    systemIs(true);
    expect(run()).toBe(true);
    systemIs(false);
    expect(run()).toBe(false);
  });

  test("a browser without matchMedia is light unless the pick says dark", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: undefined,
    });
    expect(run()).toBe(false);
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    expect(run()).toBe(true);
  });

  test("agrees with the app's own rule for every choice and system", () => {
    expect(script).toContain(`"${THEME_STORAGE_KEY}"`);
    expect(script).toContain(`"${SYSTEM_DARK_QUERY}"`);
    for (const choice of THEME_CHOICES) {
      for (const systemDark of [true, false]) {
        localStorage.clear();
        if (choice !== "system")
          localStorage.setItem(THEME_STORAGE_KEY, choice);
        systemIs(systemDark);
        expect([choice, systemDark, run()]).toEqual([
          choice,
          systemDark,
          resolveDark(choice as ThemeChoice, systemDark),
        ]);
      }
    }
  });
});

describe("index.html", () => {
  const page = new DOMParser().parseFromString(html, "text/html");

  test("runs the script first in <head>, classic and blocking, before any style or module: no flash", () => {
    const loads = [
      ...page.head.querySelectorAll("script, link[rel=stylesheet], style"),
    ];
    const first = loads[0];
    expect(first?.tagName).toBe("SCRIPT");
    expect(first?.getAttribute("src")).toBe("/theme-init.js");
    for (const attribute of ["type", "async", "defer"]) {
      expect(first?.hasAttribute(attribute)).toBe(false);
    }
  });

  test("tells the browser both schemes are supported, so the canvas matches before CSS", () => {
    expect(
      page.head
        .querySelector('meta[name="color-scheme"]')
        ?.getAttribute("content"),
    ).toBe("light dark");
  });
});
