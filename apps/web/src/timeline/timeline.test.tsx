import type { EventItem } from "@bayon/proto";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import {
  command,
  error,
  fileChange,
  reasoning,
  text,
  texts,
  toolCall,
  toolResult,
} from "@/test/fixtures";
import { renderWithProviders, stubFetch } from "@/test/render";
import { TimelineView } from "@/timeline/timeline";

const rows = () => screen.queryAllByTestId("event-row");
const rowIds = () => rows().map((row) => Number(row.dataset.eventId));
const rowById = (id: number): HTMLElement => {
  const row = rows().find((r) => r.dataset.eventId === String(id));
  if (!row) throw new Error(`row ${id} is not rendered`);
  return row;
};
const renderView = (items: readonly EventItem[]) =>
  renderWithProviders(<TimelineView sessionId="s1" items={items} />);

test("10 000 events render fewer than 100 DOM rows", () => {
  renderView(texts(10_000));
  expect(rows().length).toBeGreaterThan(10);
  expect(rows().length).toBeLessThan(100);
  expect(rowIds()[0]).toBe(1);
});

describe("filters", () => {
  const items = [
    text(1),
    toolCall(2),
    toolResult(3, "error", 1),
    fileChange(4, "src/a.ts"),
    error(5, "boom"),
    reasoning(6, "hmm"),
  ];

  test("show the union of the selected kinds, everything when none is", async () => {
    const user = userEvent.setup();
    renderView(items);
    expect(rowIds()).toEqual([1, 2, 3, 4, 5, 6]);
    await user.click(screen.getByRole("button", { name: "Errors" }));
    expect(rowIds()).toEqual([3, 5]);
    await user.click(screen.getByRole("button", { name: "Files" }));
    expect(rowIds()).toEqual([3, 4, 5]);
    await user.click(screen.getByRole("button", { name: "Tools" }));
    expect(rowIds()).toEqual([2, 3, 4, 5]);
    await user.click(screen.getByRole("button", { name: "Text" }));
    expect(rowIds()).toEqual([1, 2, 3, 4, 5, 6]);
    for (const name of ["Errors", "Files", "Tools"])
      await user.click(screen.getByRole("button", { name }));
    expect(rowIds()).toEqual([1, 6]);
    await user.click(screen.getByRole("button", { name: "Text" }));
    expect(rowIds()).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("jump to last error", () => {
  test("brings the last error into the DOM", async () => {
    const user = userEvent.setup();
    const items = texts(10_000).map((event) =>
      event.id === 4_000 || event.id === 9_000
        ? error(event.id, `boom ${event.id}`)
        : event,
    );
    renderView(items);
    expect(screen.queryByText("boom 9000")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: /jump to last error/i }),
    );
    expect(await screen.findByText("boom 9000")).toBeTruthy();
    expect(rows().length).toBeLessThan(100);
  });

  test("is disabled when there is no error", () => {
    renderView(texts(3));
    const jump = screen.getByRole("button", { name: /jump to last error/i });
    expect(jump).toHaveProperty("disabled", true);
  });
});

test("each kind renders its facts; errors are highlighted", () => {
  renderView([
    toolCall(1),
    toolResult(2, "error", 2),
    command(3, 1),
    fileChange(4, "src/payment/transfer.service.ts"),
    error(5, "rate limited"),
    text(6, "The failing case is the idempotency guard"),
  ]);
  expect(rowById(1).textContent).toContain("shell");
  expect(rowById(1).textContent).toContain("pnpm test");
  expect(rowById(2).textContent).toContain("exit 2");
  expect(rowById(3).textContent).toContain("pnpm test");
  expect(rowById(3).textContent).toContain("exit 1");
  expect(rowById(4).textContent).toContain("src/payment/transfer.service.ts");
  expect(rowById(4).textContent).toContain("+18");
  expect(rowById(4).textContent).toContain("-4");
  expect(rowById(5).textContent).toContain("rate limited");
  expect(rowById(6).textContent).toContain("idempotency guard");
  expect(
    [1, 2, 3, 4, 5, 6].filter((id) => rowById(id).dataset.error === "true"),
  ).toEqual([2, 3, 5]);
});

test("reasoning is collapsed until opened", async () => {
  const user = userEvent.setup();
  renderView([reasoning(1, "compare the two approaches")]);
  expect(screen.queryByText("compare the two approaches")).toBeNull();
  await user.click(screen.getByRole("button", { name: /reasoning/i }));
  expect(await screen.findByText("compare the two approaches")).toBeTruthy();
});

test("a truncated payload shows its size and fetches the full text on demand", async () => {
  const user = userEvent.setup();
  const fetchMock = stubFetch({
    "/api/v1/sessions/s1/events/7/payload": "the whole output",
  });
  renderView([
    {
      ...toolResult(7, "ok", 0),
      truncated: true,
      bytes_original: 43_008,
      payload_path: "logs/tool/c7.txt",
    },
  ]);
  expect(rowById(7).textContent).toContain("42.0 KB");
  expect(fetchMock).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: /full text/i }));
  expect(await screen.findByText("the whole output")).toBeTruthy();
});
