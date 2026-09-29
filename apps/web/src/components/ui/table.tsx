import * as React from "react";

import { cn } from "@/lib/utils";

// How a table's wrapper scrolls. It must scroll sideways on a narrow screen, and
// `overflow-x: auto` makes it a scroller on both axes, so a header can only ever stick inside it.
//   x    (the default) sideways only, as tall as its rows: a panel's table, one part of a screen.
//        Its header cannot stick to the page; the page scrolls it away like the rest.
//   fill a page's one table (Audit, Spend, Reviews), in a flex column (PageContainer `fill`): it
//        takes at most the height the column leaves under what sits above and below it (a filter
//        form, Load older), and scrolls there under its sticky header. It shrinks and never grows,
//        so a short table stays its own height; 6rem is its floor, a header and a row or two.
const SCROLL = {
  x: "overflow-x-auto",
  fill: "min-h-24 flex-initial overflow-auto",
} as const;

export type TableScroll = keyof typeof SCROLL;

function Table({
  className,
  scroll = "x",
  ...props
}: React.ComponentProps<"table"> & { readonly scroll?: TableScroll }) {
  return (
    <div
      data-slot="table-container"
      data-scroll={scroll}
      className={cn(
        "relative w-full rounded-lg border shadow-sm",
        SCROLL[scroll],
      )}
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("sticky top-0 z-10 [&_tr]:border-b", className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className,
      )}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-accent has-aria-expanded:bg-accent data-[state=selected]:bg-accent",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        // The inset hairline: a collapsed border stays behind when its row scrolls under a stuck header.
        "h-10 bg-muted px-2 text-left align-middle font-head font-medium whitespace-nowrap text-foreground shadow-[inset_0_-1px_0_var(--color-border)] [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
};
