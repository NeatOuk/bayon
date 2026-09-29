import { STAFF_APPROVAL_KIND } from "@bayon/core";
import type { InboxItem, InboxTicket } from "@bayon/proto";
import { humanize } from "@/components/status";

// How the Inbox reads its requests: grouped by the ticket they are about, the group
// with the newest question first and each group's newest first, so near-duplicates on one ticket
// sit together instead of scattered down the page.

export interface InboxGroup {
  /** The ticket's id, or "" for the requests about none. */
  readonly key: string;
  readonly ticket: InboxTicket | null;
  /** Newest first. */
  readonly items: readonly InboxItem[];
}

const newestFirst = (a: InboxItem, b: InboxItem): number =>
  b.asked_at - a.asked_at;

/** The requests by ticket: the group asked most recently first, each group newest first. */
export function groupByTicket(items: readonly InboxItem[]): InboxGroup[] {
  const groups = new Map<
    string,
    { ticket: InboxTicket | null; items: InboxItem[] }
  >();
  for (const item of items) {
    const key = item.ticket?.id ?? "";
    const group = groups.get(key) ?? { ticket: item.ticket, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups]
    .map(([key, group]) => ({
      key,
      ticket: group.ticket,
      items: group.items.toSorted(newestFirst),
    }))
    .toSorted(
      (a, b) => (b.items[0]?.asked_at ?? 0) - (a.items[0]?.asked_at ?? 0),
    );
}

const RECOMMENDATION = /^Recommendation:\s*(\S[\s\S]*)$/;

/**
 * A human_ask's recommendation (the API stores it as the context's one line, "Recommendation: …"),
 * or null when the context is anything else: that stays markdown.
 */
export const recommendationOf = (contextMd: string | null): string | null =>
  contextMd === null
    ? null
    : (RECOMMENDATION.exec(contextMd.trim())?.[1] ?? null);

const KIND_LABELS: Readonly<Record<string, string>> = {
  [STAFF_APPROVAL_KIND]: "Staffing proposal",
};

/** A request's kind as a badge reads it: "Decision", "Staffing proposal". */
export const kindLabel = (kind: string): string =>
  KIND_LABELS[kind] ?? humanize(kind);
