import { expect, test } from "vitest";
import {
  BASE_TITLE,
  FALLBACK_FAVICON,
  faviconDataUrl,
  inboxCountLabel,
  inboxCountOf,
  inboxCountTitle,
  NO_INBOX,
  titleWithCount,
} from "@/inbox/inbox-count";
import { inboxItem, inboxPage } from "@/test/inbox-fixtures";

// The open count, and what carries it outside the page: pure, so the badge, the tab
// title and the icon are one calculation.

const items = (n: number) =>
  Array.from({ length: n }, (_, i) => inboxItem({ id: `R${i}` }));

test("the count is the first page's, and a full page says at least", () => {
  expect(inboxCountOf(undefined)).toEqual(NO_INBOX);
  expect(inboxCountOf(inboxPage([]))).toEqual({ open: 0, more: false });
  expect(inboxCountOf(inboxPage(items(3)))).toEqual({ open: 3, more: false });
  expect(inboxCountOf(inboxPage(items(50), "next"))).toEqual({
    open: 50,
    more: true,
  });
});

test("the label, and what a screen reader hears", () => {
  expect(inboxCountLabel({ open: 3, more: false })).toBe("3");
  expect(inboxCountLabel({ open: 50, more: true })).toBe("50+");
  expect(inboxCountTitle(NO_INBOX)).toBe("nothing waiting in the inbox");
  expect(inboxCountTitle({ open: 3, more: false })).toBe("3 open in the inbox");
});

test("the tab title carries the count, and drops it when nothing waits", () => {
  expect(titleWithCount({ open: 3, more: false })).toBe(`(3) ${BASE_TITLE}`);
  expect(titleWithCount({ open: 50, more: true })).toBe(`(50+) ${BASE_TITLE}`);
  expect(titleWithCount(NO_INBOX)).toBe(BASE_TITLE);
});

test("the favicon badges the count, and is a plain mark when nothing waits", () => {
  const plain = decodeURIComponent(faviconDataUrl(NO_INBOX));
  expect(plain.startsWith("data:image/svg+xml,")).toBe(true);
  expect(plain).toContain("<svg");
  expect(plain).not.toContain("<circle");

  const three = decodeURIComponent(faviconDataUrl({ open: 3, more: false }));
  expect(three).toContain("<circle");
  expect(three).toContain(">3</text>");
  // Two glyphs is all the badge holds.
  expect(
    decodeURIComponent(faviconDataUrl({ open: 42, more: false })),
  ).toContain(">9+</text>");
});

test("it draws with the colours it is given, and never a literal of its own", () => {
  const themed = decodeURIComponent(
    faviconDataUrl(
      { open: 1, more: false },
      {
        ground: "oklch(1 0 0)",
        ink: "oklch(0.2 0 0)",
        badge: "oklch(0.6 0.2 30)",
        badgeInk: "oklch(1 0 0)",
      },
    ),
  );
  expect(themed).toContain('fill="oklch(0.6 0.2 30)"');
  expect(themed).not.toContain(FALLBACK_FAVICON.badge);
  // Encoded, so the parentheses and spaces survive a data URL.
  expect(faviconDataUrl({ open: 1, more: false })).not.toContain(" ");
});
