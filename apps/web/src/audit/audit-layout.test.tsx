import type { AuditEntryView, AuditPage } from "@bayon/proto";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { AuditScreen } from "@/audit/audit-screen";
import { renderWithProviders, stubFetch } from "@/test/render";

// The Audit page's frame: a filling page — its filter form above and Load older below —
// in which only the table's region scrolls, so the page never scrolls as well.

const entry = (id: number): AuditEntryView => ({
  id,
  ts: 1_700_000_000_000 + id,
  actor: "operator",
  action: "settings.put",
  target_kind: "setting",
  target_id: "fleet.paused",
  payload: { via: "rest" },
});

const page: AuditPage = {
  items: [entry(2), entry(1)],
  next_cursor: 1,
  has_more: true,
};

const scrolls = (el: Element): boolean =>
  /(^|\s)overflow-(auto|y-auto|scroll)(\s|$)/.test(el.className);

test("the form, the table and Load older share one filling page; only the table's region scrolls", async () => {
  stubFetch({ "/api/v1/audit?limit=50": page });
  renderWithProviders(<AuditScreen />);
  const table = await screen.findByRole("table", { name: "audit log" });
  const region = table.parentElement as HTMLElement;
  const pageEl = region.closest<HTMLElement>('[data-slot="page-container"]');
  expect(pageEl?.dataset.fill).toBe("true");
  expect(region.dataset.scroll).toBe("fill");
  expect(scrolls(region)).toBe(true);
  expect(region.className).toMatch(/\bflex-initial\b/);
  expect(region.className).toMatch(/\bmin-h-24\b/);

  // The form and Load older are the page's own children, beside the table's region, not in it.
  const form = screen.getByRole("form", { name: "audit filters" });
  const older = screen.getByRole("button", { name: "Load older" });
  for (const part of [form, older, region])
    expect(part.parentElement).toBe(pageEl);
  expect(region.contains(form) || region.contains(older)).toBe(false);

  // Nothing between the page and the table scrolls but the table's region.
  const scrollers = [pageEl, ...(pageEl?.querySelectorAll("*") ?? [])].filter(
    (el): el is Element => el !== null && scrolls(el),
  );
  expect(scrollers).toEqual([region]);
});
