import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { PageContainer } from "@/components/page-container";

// Every screen's frame: one page padding and one gap for all of them; the
// width a screen reads best at.

const frame = () =>
  screen.getByText("body").closest<HTMLElement>("[data-slot=page-container]");

test.each([
  ["full", null],
  ["wide", "max-w-6xl"],
  ["prose", "max-w-3xl"],
] as const)("%s: the one padding and gap, and its cap", (size, cap) => {
  render(<PageContainer size={size}>body</PageContainer>);
  const el = frame();
  expect(el?.dataset.size).toBe(size);
  for (const part of ["p-4", "md:p-6", "gap-5"])
    expect(el?.className.split(" ")).toContain(part);
  if (cap === null) expect(el?.className).not.toMatch(/max-w-|mx-auto/);
  else {
    expect(el?.className).toContain(cap);
    expect(el?.className).toContain("mx-auto");
  }
});

test("fill makes it the height it has, with a floor", () => {
  render(<PageContainer fill>body</PageContainer>);
  expect(frame()?.dataset.fill).toBe("true");
  expect(frame()?.className).toMatch(/\bflex-1\b/);
  expect(frame()?.className).toMatch(/\bmin-h-128\b/);
});
