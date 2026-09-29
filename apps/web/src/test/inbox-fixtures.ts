import type { InboxItem, InboxPage } from "@bayon/proto";

// Wire-shaped inbox data (DTOs): every value here would pass its proto schema.

const T0 = 1_800_000_000_000;

export const inboxItem = (
  item: Partial<InboxItem> & Pick<InboxItem, "id">,
): InboxItem => ({
  status: "open",
  kind: "question",
  question: `question ${item.id}`,
  context_md: null,
  options: null,
  batch_id: null,
  asked_at: T0,
  expires_at: null,
  answer: null,
  answered_by: null,
  answered_at: null,
  ticket: {
    id: "ticket-812",
    num: 812,
    title: "transfer idempotency",
    status: "build",
  },
  session: { id: "s1", agent: "builder-1", role: "builder", state: "running" },
  proposal: null,
  ...item,
});

/** One page; a `nextCursor` means more follow. */
export const inboxPage = (
  items: readonly InboxItem[],
  nextCursor: string | null = null,
): InboxPage => ({
  items: [...items],
  next_cursor: nextCursor,
  has_more: nextCursor !== null,
});
