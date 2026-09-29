import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import {
  readChoice,
  resolveDark,
  SYSTEM_DARK_QUERY,
  writeChoice,
  type ThemeChoice,
} from "@/theme/theme";

export interface Theme {
  /** What the operator picked; "system" until they pick. */
  readonly choice: ThemeChoice;
  /** Whether the page is dark now. */
  readonly dark: boolean;
  /** Applies and remembers a choice; "system" forgets the pick. */
  readonly choose: (choice: ThemeChoice) => void;
}

/** localStorage, or null where reading the property itself throws (blocked site data). */
const storage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const systemQuery = (): MediaQueryList | null =>
  typeof window.matchMedia === "function"
    ? window.matchMedia(SYSTEM_DARK_QUERY)
    : null;

/**
 * The page's theme. Starts from what public/theme-init.js already applied before first
 * paint — the same pick-else-system rule, read from the same place — so mounting changes nothing
 * visible. While there is no pick it follows the system live (a macOS appearance switch, or its
 * sunset schedule). `.dark` lands in a layout effect: before paint, and before any effect that
 * reads the tokens back (the favicon).
 */
export function useTheme(): Theme {
  const [choice, setChoice] = useState<ThemeChoice>(() => readChoice(storage));
  const [systemDark, setSystemDark] = useState(
    () => systemQuery()?.matches ?? false,
  );

  useEffect(() => {
    const query = systemQuery();
    if (query === null) return;
    const follow = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, []);

  const dark = resolveDark(choice, systemDark);
  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  const choose = useCallback((next: ThemeChoice) => {
    writeChoice(storage, next);
    setChoice(next);
  }, []);

  return { choice, dark, choose };
}
