// Light or dark: the operator's pick when there is one, else the system's appearance.
// The pick is a per-viewer convenience, so it lives in this browser's localStorage — the one thing
// here that may, since nothing else depends on it surviving. public/theme-init.js applies the same
// rule before first paint (it cannot import this module); theme-init.test.ts holds the two together.

export type ThemePick = "light" | "dark";
/** "system" is no pick: the stored key is absent. */
export type ThemeChoice = ThemePick | "system";

export const THEME_CHOICES: readonly ThemeChoice[] = [
  "system",
  "light",
  "dark",
];

/** localStorage's key for the pick. */
export const THEME_STORAGE_KEY = "bayon.theme";

/** The media query whose answer "system" follows. */
export const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

/** A value read back from storage, or from a menu: anything unknown is no pick. */
export const parseChoice = (raw: unknown): ThemeChoice =>
  raw === "light" || raw === "dark" ? raw : "system";

/** Whether the page is dark: the pick wins; with none, the system decides. */
export const resolveDark = (
  choice: ThemeChoice,
  systemDark: boolean,
): boolean => (choice === "system" ? systemDark : choice === "dark");

/** The stored choice; storage that is missing, blocked or throwing means "system". */
export function readChoice(
  storage: () => Pick<Storage, "getItem"> | null | undefined,
): ThemeChoice {
  try {
    return parseChoice(storage()?.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

/**
 * Remembers `choice` ("system" forgets the pick). A storage that refuses (private mode, quota,
 * blocked site data) only costs the memory: the choice still applies for this page's life.
 */
export function writeChoice(
  storage: () => Pick<Storage, "setItem" | "removeItem"> | null | undefined,
  choice: ThemeChoice,
): boolean {
  try {
    const store = storage();
    if (store === null || store === undefined) return false;
    if (choice === "system") store.removeItem(THEME_STORAGE_KEY);
    else store.setItem(THEME_STORAGE_KEY, choice);
    return true;
  } catch {
    return false;
  }
}
