import type { InboxPage } from "@bayon/proto";

// How many requests are open, at a glance. Pure, so the badge, the tab title and the
// favicon are one calculation tested once. The number is the first page's length, the way the
// Proposals tile and a ticket's Open questions already count: the page the Inbox screen fetches and
// the `inbox` topic keeps live, so nothing new is asked of the server. A full page means "at least
// this many", and says so with a `+`.

export interface InboxCount {
  readonly open: number;
  /** The page did not hold them all: the true number is higher. */
  readonly more: boolean;
}

export const NO_INBOX: InboxCount = { open: 0, more: false };

export const inboxCountOf = (page: InboxPage | undefined): InboxCount =>
  page === undefined
    ? NO_INBOX
    : { open: page.items.length, more: page.has_more };

/** "3", or "50+" when the page was full. */
export const inboxCountLabel = (count: InboxCount): string =>
  `${count.open}${count.more ? "+" : ""}`;

/** What the badge's label reads out, so it is not a bare number to a screen reader. */
export const inboxCountTitle = (count: InboxCount): string =>
  count.open === 0
    ? "nothing waiting in the inbox"
    : `${inboxCountLabel(count)} open in the inbox`;

export const BASE_TITLE = "Bayon";

/** The browser tab: "(3) Bayon" while something waits, plain "Bayon" when nothing does. */
export const titleWithCount = (count: InboxCount): string =>
  count.open === 0 ? BASE_TITLE : `(${inboxCountLabel(count)}) ${BASE_TITLE}`;

/**
 * The favicon's colours, read from the theme's own variables at draw time: an icon is outside the
 * document, so it cannot name a token — the caller resolves them and hands them in, and the mark
 * then follows light and dark like everything else.
 */
export interface FaviconColours {
  readonly ground: string;
  readonly ink: string;
  readonly badge: string;
  readonly badgeInk: string;
}

/**
 * The last resort, for a browser that hands back nothing for a theme variable (a detached document,
 * a test, an old engine). These are not colours but CSS *system* keywords: the platform resolves
 * each from the running colour scheme, so the mark still follows light and dark without this file
 * naming a colour of its own (colours.test.ts refuses one).
 */
export const FALLBACK_FAVICON: FaviconColours = {
  ground: "Canvas",
  ink: "CanvasText",
  badge: "AccentColor",
  badgeInk: "AccentColorText",
};

/** At most two glyphs fit the badge: 10 and up read as "9+". */
const badgeText = (count: InboxCount): string =>
  count.open > 9 ? "9+" : String(count.open);

const svg = (count: InboxCount, c: FaviconColours): string => {
  const badge =
    count.open === 0
      ? ""
      : `<circle cx="22" cy="10" r="10" fill="${c.badge}"/>` +
        `<text x="22" y="14.5" text-anchor="middle" font-family="system-ui,sans-serif"` +
        ` font-size="12" font-weight="700" fill="${c.badgeInk}">${badgeText(count)}</text>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="7" fill="${c.ground}"/>` +
    `<text x="16" y="24" text-anchor="middle" font-family="system-ui,sans-serif"` +
    ` font-size="22" font-weight="700" fill="${c.ink}">B</text>` +
    `${badge}</svg>`
  );
};

/** The favicon as a data URL: the mark, with a badge while something waits. */
export const faviconDataUrl = (
  count: InboxCount,
  colours: FaviconColours = FALLBACK_FAVICON,
): string => `data:image/svg+xml,${encodeURIComponent(svg(count, colours))}`;
