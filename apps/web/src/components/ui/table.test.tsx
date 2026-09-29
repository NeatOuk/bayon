import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { PageContainer } from "@/components/page-container";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  type TableScroll,
} from "@/components/ui/table";

// How a table scrolls: by default sideways only and as tall as its rows, so a panel's
// table never scrolls inside a scrolling page; a page's one table opts in to fill the space its page
// leaves, scrolling there under a sticky header.

function renderTable(scroll?: TableScroll) {
  render(
    <Table aria-label="audit log" {...(scroll === undefined ? {} : { scroll })}>
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>now</TableCell>
        </TableRow>
      </TableBody>
    </Table>,
  );
  const table = screen.getByRole("table", { name: "audit log" });
  return { table, wrapper: table.parentElement as HTMLElement };
}

const classes = (el: Element | null | undefined): string[] =>
  (el?.className ?? "").split(/\s+/);

test("by default a table scrolls sideways only, with no height bound of its own", () => {
  const { wrapper } = renderTable();
  expect(wrapper.dataset.slot).toBe("table-container");
  expect(wrapper.dataset.scroll).toBe("x");
  expect(classes(wrapper)).toContain("overflow-x-auto");
  expect(classes(wrapper)).not.toContain("overflow-auto");
  expect(wrapper.className).not.toMatch(/\bmax-h-|\bflex-1\b|\bflex-initial\b/);
});

test("a filling table takes at most the space its column leaves, and scrolls there", () => {
  const { wrapper } = renderTable("fill");
  expect(wrapper.dataset.scroll).toBe("fill");
  // Shrinks to the space left, never grows past its rows, and keeps a floor.
  expect(classes(wrapper)).toEqual(
    expect.arrayContaining(["overflow-auto", "flex-initial", "min-h-24"]),
  );
  expect(wrapper.className).not.toMatch(/\bmax-h-/);
});

test("the header row sticks within the table's scroller, on a solid surface with its hairline", () => {
  const { table } = renderTable("fill");
  const head = table.querySelector("thead");
  expect(classes(head)).toEqual(expect.arrayContaining(["sticky", "top-0"]));
  const cell = screen.getByRole("columnheader", { name: "When" });
  expect(classes(cell)).toContain("bg-muted");
  expect(cell.className).toContain(
    "shadow-[inset_0_-1px_0_var(--color-border)]",
  );
});

test("a filling page is a flex column as tall as its space, with a floor", () => {
  render(
    <>
      <PageContainer data-testid="plain" />
      <PageContainer data-testid="filling" fill />
    </>,
  );
  const plain = screen.getByTestId("plain");
  const filling = screen.getByTestId("filling");
  expect(plain.dataset.fill).toBeUndefined();
  expect(classes(plain)).not.toContain("flex-1");
  expect(filling.dataset.fill).toBe("true");
  expect(classes(filling)).toEqual(
    expect.arrayContaining(["flex", "flex-col", "flex-1", "min-h-128"]),
  );
});
