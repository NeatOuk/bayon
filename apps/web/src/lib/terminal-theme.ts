import type { ITheme } from "@xterm/xterm";

// The terminals' colours (the Watch pane; the takeover terminal): xterm.js
// wants concrete colours, and the one place colours live is theme.css. So each slot names a theme
// token and the value is read from the page at runtime — light or dark, whichever `.dark` currently
// selects — never written here.

/** A theme token's current value (`--<name>`), or "" where the page defines none. */
export type ReadToken = (name: string) => string;

export const cssToken: ReadToken = (name) =>
  getComputedStyle(document.documentElement)
    .getPropertyValue(`--${name}`)
    .trim();

/** Which token paints each terminal slot. */
export type TerminalSlots = Partial<Record<keyof ITheme, string>>;

/**
 * The Watch pane's slots: a card-coloured, invisible cursor (nothing is typed there), and the
 * ANSI colours watch-lines.ts writes mapped onto the status tones — red is danger, green success.
 */
export const WATCH_SLOTS = {
  background: "card",
  foreground: "card-foreground",
  cursor: "card",
  cursorAccent: "card",
  selectionBackground: "accent",
  selectionForeground: "accent-foreground",
  red: "danger",
  brightRed: "danger",
  green: "success",
  brightGreen: "success",
  yellow: "warning",
  brightYellow: "warning",
  blue: "primary",
  brightBlue: "primary",
  cyan: "info",
  brightCyan: "info",
  brightBlack: "muted-foreground",
} as const satisfies TerminalSlots;

/** The takeover terminal: the same palette with a cursor the operator can see. */
export const TAKEOVER_SLOTS = {
  ...WATCH_SLOTS,
  cursor: "foreground",
} as const satisfies TerminalSlots;

/** The terminal theme from the tokens; a slot whose token is unset keeps xterm's own default. */
export function terminalTheme(
  slots: TerminalSlots = WATCH_SLOTS,
  read: ReadToken = cssToken,
): ITheme {
  return Object.fromEntries(
    Object.entries(slots).flatMap(([slot, token]) => {
      const value = read(token);
      return value === "" ? [] : [[slot, value]];
    }),
  );
}

/**
 * Keeps `term` in the page's theme: the theme control flips `.dark` on <html>, after which the same
 * token names hold the other palette. Returns the unsubscribe.
 */
export function followTheme(
  term: { options: { theme?: ITheme } },
  slots: TerminalSlots = WATCH_SLOTS,
): () => void {
  const recolour = new MutationObserver(() => {
    term.options.theme = terminalTheme(slots);
  });
  recolour.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => recolour.disconnect();
}
