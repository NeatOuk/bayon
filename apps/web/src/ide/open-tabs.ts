import type { TimelineEntry } from "@bayon/proto";
import type { EditorTab } from "@/routing";

// The IDE's open editor tabs: which are open is the IDE's state; which one is focused is
// the URL's (`?open=`). These are the pure moves on that list.

/** A tab's identity: its Tabs value and React key. The view's own tab is "view", never one of these. */
export const tabKey = (tab: EditorTab): string =>
  tab.kind === "ticket" ? `ticket:${tab.num}` : `${tab.kind}:${tab.id}`;

export const VIEW_TAB = "view";

const sameTab = (a: EditorTab, b: EditorTab): boolean =>
  tabKey(a) === tabKey(b);

/** `tabs` with `tab` opened at the end, or unchanged when it already is open. */
export const withTab = (
  tabs: readonly EditorTab[],
  tab: EditorTab,
): readonly EditorTab[] =>
  tabs.some((open) => sameTab(open, tab)) ? tabs : [...tabs, tab];

/** `tabs` without `tab`. */
export const withoutTab = (
  tabs: readonly EditorTab[],
  tab: EditorTab,
): readonly EditorTab[] => tabs.filter((open) => !sameTab(open, tab));

/**
 * What takes focus when the focused `closed` tab closes: the tab to its left in the strip. The view's
 * tab is always first, so the leftmost opened tab hands focus back to the view (undefined).
 */
export function focusAfterClose(
  tabs: readonly EditorTab[],
  closed: EditorTab,
): EditorTab | undefined {
  const at = tabs.findIndex((open) => sameTab(open, closed));
  return at > 0 ? tabs[at - 1] : undefined;
}

/** A long id's tail: ULIDs made close together share their head, never their tail. */
export const shortId = (id: string): string =>
  id.length <= 10 ? id : `…${id.slice(-6)}`;

/** A ticket's number from its key: `settings.tickets.key_prefix` ends in `-`, the number follows. */
export function ticketNumOf(key: string): number | null {
  const num = /-([1-9][0-9]{0,14})$/.exec(key)?.[1];
  return num === undefined ? null : Number(num);
}

/**
 * The tab a history row opens: a session row its session, a pulse row its pulse (its key is the
 * pulse's id); any other its ticket, else its session. A row naming neither opens nothing.
 */
export function tabOf(
  entry: Pick<TimelineEntry, "source" | "key" | "ticket_key" | "session_id">,
): EditorTab | null {
  if (entry.source === "pulse") return { kind: "pulse", id: entry.key };
  const session: EditorTab | null =
    entry.session_id === null
      ? null
      : { kind: "session", id: entry.session_id };
  if (entry.source === "session" && session !== null) return session;
  const num = entry.ticket_key === null ? null : ticketNumOf(entry.ticket_key);
  return num === null ? session : { kind: "ticket", num };
}
