import { expect, test, vi } from "vitest";
import {
  parseChoice,
  readChoice,
  resolveDark,
  THEME_STORAGE_KEY,
  writeChoice,
} from "@/theme/theme";

// The pick-else-system rule, and storage that may refuse at any step.

test("a pick wins over the system; with none, the system decides", () => {
  expect(resolveDark("system", true)).toBe(true);
  expect(resolveDark("system", false)).toBe(false);
  expect(resolveDark("light", true)).toBe(false);
  expect(resolveDark("light", false)).toBe(false);
  expect(resolveDark("dark", false)).toBe(true);
  expect(resolveDark("dark", true)).toBe(true);
});

test("only light and dark are picks; anything else stored is no pick", () => {
  expect(parseChoice("light")).toBe("light");
  expect(parseChoice("dark")).toBe("dark");
  for (const raw of [null, undefined, "", "system", "DARK", 1, {}]) {
    expect(parseChoice(raw)).toBe("system");
  }
});

const memory = (): Storage => {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    key: (i) => [...items.keys()][i] ?? null,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
};

test("a pick is written under the key and read back; System forgets it", () => {
  const store = memory();
  expect(readChoice(() => store)).toBe("system");
  expect(writeChoice(() => store, "dark")).toBe(true);
  expect(store.getItem(THEME_STORAGE_KEY)).toBe("dark");
  expect(readChoice(() => store)).toBe("dark");
  writeChoice(() => store, "system");
  expect(store.getItem(THEME_STORAGE_KEY)).toBeNull();
  expect(readChoice(() => store)).toBe("system");
});

test("storage that is missing or throws means System, and a failed write is only forgotten", () => {
  const refusing = {
    getItem: vi.fn(() => {
      throw new DOMException("blocked", "SecurityError");
    }),
    setItem: vi.fn(() => {
      throw new DOMException("full", "QuotaExceededError");
    }),
    removeItem: vi.fn(),
  };
  expect(readChoice(() => refusing)).toBe("system");
  expect(writeChoice(() => refusing, "light")).toBe(false);
  expect(readChoice(() => null)).toBe("system");
  expect(writeChoice(() => null, "light")).toBe(false);
  const unreachable = () => {
    throw new DOMException("no site data", "SecurityError");
  };
  expect(readChoice(unreachable)).toBe("system");
  expect(writeChoice(unreachable, "dark")).toBe(false);
});
