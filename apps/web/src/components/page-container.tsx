import { cn } from "@/lib/utils";

// A screen's frame inside the shell's scrolling main: its padding and vertical rhythm,
// full width by default. Every screen's root is one, so every screen has the one page
// padding — 16px on a narrow screen, 24px from md up — and the one gap between its parts. `wide`
// caps a screen of cards and forms read top to bottom (the Inbox, Settings, a pulse) at a width its
// two-column sections still fit in; `prose` caps the measure for a screen read like a document (a
// form, a mission, New project), both centred in the space the sidebar leaves. `fill` makes it exactly
// as tall as the space it has, a flex column in which a `<Table scroll="fill">` takes what is left
// and scrolls itself, so the page does not scroll as well. 32rem is its floor: on a very short
// window the page scrolls instead of squeezing the table to nothing.

const SIZE = {
  full: "",
  wide: "mx-auto max-w-6xl",
  prose: "mx-auto max-w-3xl",
} as const;

/**
 * The page padding, for a part that bleeds to the page's edges (the board's sideways scroller) and
 * must undo it: `-mx-*` of the same, then `px-*` again inside.
 */
export const PAGE_BLEED = "-mx-4 px-4 md:-mx-6 md:px-6";

export type PageSize = keyof typeof SIZE;

export function PageContainer({
  size = "full",
  fill = false,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  readonly size?: PageSize;
  readonly fill?: boolean;
}) {
  return (
    <div
      data-slot="page-container"
      data-size={size}
      data-fill={fill || undefined}
      className={cn(
        "flex w-full flex-col gap-5 p-4 md:p-6",
        SIZE[size],
        fill && "min-h-128 flex-1",
        className,
      )}
      {...props}
    />
  );
}
