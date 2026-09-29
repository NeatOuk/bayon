import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
  type DialogSize,
} from "@/components/ui/dialog";

// Dialog sizes and height: four widths, `sm` the default; never taller than the viewport
// less 2rem, the popup scrolling and its footer sticking to the bottom. Class assertions stand in for
// the layout jsdom cannot do.

const popup = (size?: DialogSize) => {
  render(
    <Dialog open>
      <DialogContent size={size}>
        <DialogTitle>Add executor</DialogTitle>
        <DialogFooter>
          <button type="button">Add</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>,
  );
  return screen.getByRole("dialog");
};

test.each([
  [undefined, "sm:max-w-sm"],
  ["sm", "sm:max-w-sm"],
  ["md", "sm:max-w-lg"],
  ["lg", "sm:max-w-2xl"],
  ["xl", "sm:max-w-4xl"],
] as const)("size %s is %s wide", (size, width) => {
  const dialog = popup(size);
  expect(dialog.className).toContain(width);
  expect(dialog.dataset.size).toBe(size ?? "sm");
});

test("a dialog is at most the viewport less 2rem tall, and scrolls; its footer sticks", () => {
  const dialog = popup("lg");
  expect(dialog.className).toContain("max-h-[calc(100dvh-2rem)]");
  expect(dialog.className).toContain("overflow-y-auto");
  const footer = screen.getByRole("button", { name: "Add" }).parentElement;
  expect(footer?.className).toContain("sticky");
  expect(footer?.className).toContain("bottom-0");
  // Solid: content scrolls under it.
  expect(footer?.className).toContain("bg-muted");
  expect(footer?.className).not.toContain("bg-muted/50");
});
