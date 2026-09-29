import type { AuditEntryView, AuditPage } from "@bayon/proto";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { AuditScreen } from "@/audit/audit-screen";
import { callsTo, renderWithProviders, stubFetch } from "@/test/render";

const entry = (
  id: number,
  action: string,
  o: Partial<AuditEntryView> = {},
): AuditEntryView => ({
  id,
  ts: 1_700_000_000_000 + id,
  actor: "operator",
  action,
  target_kind: "setting",
  target_id: "fleet.paused",
  payload: { via: "rest" },
  ...o,
});

const page = (
  items: AuditEntryView[],
  next: number | null = null,
): AuditPage => ({ items, next_cursor: next, has_more: next !== null });

const rows = () =>
  within(screen.getByRole("table", { name: "audit log" }))
    .getAllByRole("row")
    .slice(1);

test("newest first; Load older asks for the rows before the last one", async () => {
  const fetchMock = stubFetch({
    "/api/v1/audit?limit=50": page(
      [
        entry(7, "fleet.resume"),
        entry(6, "settings.put", { payload: { from: 5000, to: 2000 } }),
      ],
      6,
    ),
    "/api/v1/audit?limit=50&before=6": page([entry(5, "fleet.pause")]),
  });
  renderWithProviders(<AuditScreen />);
  expect(await screen.findByRole("table", { name: "audit log" })).toBeTruthy();
  expect(rows().map((r) => r.getAttribute("aria-label"))).toEqual([
    "audit 7",
    "audit 6",
  ]);
  expect(rows()[1]?.textContent).toContain('{"from":5000,"to":2000}');
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Load older" }));
  await waitFor(() => expect(rows()).toHaveLength(3));
  expect(callsTo(fetchMock, "/api/v1/audit?limit=50&before=6")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
});

test("the filters go to the server as they were typed, a trailing * as a prefix", async () => {
  const fetchMock = stubFetch({
    "/api/v1/audit?limit=50": page([entry(1, "mcp.human_ask")]),
    "/api/v1/audit?limit=50&actor=operator&action=fleet.*": page([
      entry(2, "fleet.pause"),
    ]),
  });
  renderWithProviders(<AuditScreen />);
  await screen.findByRole("table", { name: "audit log" });
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Actor"), "operator");
  await user.type(screen.getByLabelText("Action"), "fleet.*");
  await user.click(screen.getByRole("button", { name: "Filter" }));
  await waitFor(() =>
    expect(rows().map((r) => r.getAttribute("aria-label"))).toEqual([
      "audit 2",
    ]),
  );
  expect(
    callsTo(fetchMock, "/api/v1/audit?limit=50&actor=operator&action=fleet.*"),
  ).toHaveLength(1);
});

test("a * inside a filter is refused before any request", async () => {
  const fetchMock = stubFetch({ "/api/v1/audit?limit=50": page([]) });
  renderWithProviders(<AuditScreen />);
  expect(await screen.findByText("No audit rows")).toBeTruthy();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Actor"), "sess*ion");
  await user.click(screen.getByRole("button", { name: "Filter" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "only a trailing * is allowed",
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("a filter that matches nothing offers to clear it, and clearing reads the whole log again", async () => {
  const fetchMock = stubFetch({
    "/api/v1/audit?limit=50": page([entry(1, "settings.put")]),
    "/api/v1/audit?limit=50&actor=nobody": page([]),
  });
  renderWithProviders(<AuditScreen />);
  const user = userEvent.setup();
  await screen.findByRole("table", { name: "audit log" });
  await user.type(screen.getByLabelText("Actor"), "nobody");
  await user.click(screen.getByRole("button", { name: "Filter" }));
  expect(await screen.findByText("No audit rows")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Clear the filters" }));
  expect(await screen.findByRole("table", { name: "audit log" })).toBeTruthy();
  expect((screen.getByLabelText("Actor") as HTMLInputElement).value).toBe("");
  expect(callsTo(fetchMock, "/api/v1/audit?limit=50").length).toBeGreaterThan(
    0,
  );
});
