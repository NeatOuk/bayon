import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { inboxQuery } from "@/inbox/inbox-api";
import {
  FALLBACK_FAVICON,
  faviconDataUrl,
  inboxCountOf,
  titleWithCount,
  type FaviconColours,
  type InboxCount,
} from "@/inbox/inbox-count";
import { useInboxFeed } from "@/inbox/use-inbox-feed";

// The open count, and the two places outside the page that carry it: the tab's title
// and its icon. Both are document-wide, so one hook owns them — called once, in the shell.

/**
 * How many requests are open: the fleet's, or one project's. A read only — it rides the very query
 * the Inbox screen uses, so two readers of one scope are one request — and `useInboxCountFeed`
 * keeps that query live while the Inbox screen is not there to do it.
 */
export function useInboxCount(project?: string): InboxCount {
  const page = useInfiniteQuery(inboxQuery("open", project));
  return inboxCountOf(page.data?.pages[0]);
}

/**
 * Keeps the count live from the `inbox` topic while the Inbox screen is closed. When it is open it
 * subscribes for itself, and subscribing twice would make one frame two refetches, so this stands
 * down.
 */
export function useInboxCountFeed(
  project: string | undefined,
  inboxOpen: boolean,
): void {
  useInboxFeed(project, !inboxOpen);
}

const TOKEN: Readonly<Record<keyof FaviconColours, string>> = {
  ground: "--card",
  ink: "--muted-foreground",
  badge: "--primary",
  badgeInk: "--primary-foreground",
};

/** The theme's own colours, as the icon can use them; a token the browser cannot resolve falls back. */
function faviconColours(): FaviconColours {
  const style = globalThis.getComputedStyle?.(document.documentElement);
  const of = (name: keyof FaviconColours): string =>
    style?.getPropertyValue(TOKEN[name]).trim() || FALLBACK_FAVICON[name];
  return {
    ground: of("ground"),
    ink: of("ink"),
    badge: of("badge"),
    badgeInk: of("badgeInk"),
  };
}

/** The one `link[rel="icon"]`, made on first use: index.html ships none. */
function iconLink(): HTMLLinkElement {
  const found =
    document.head.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (found !== null) return found;
  const link = document.createElement("link");
  link.rel = "icon";
  document.head.append(link);
  return link;
}

/** The tab's title and icon follow the count; `dark` redraws the icon when the theme flips. */
export function useInboxBadge(count: InboxCount, dark: boolean): void {
  // The count is a fresh object each render, so the effects watch its two fields, not its identity.
  const { open, more } = count;
  useEffect(() => {
    document.title = titleWithCount({ open, more });
  }, [open, more]);
  useEffect(() => {
    iconLink().href = faviconDataUrl({ open, more }, faviconColours());
  }, [open, more, dark]);
}
