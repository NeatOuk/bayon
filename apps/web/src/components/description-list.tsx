import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Terms and their values: one grid for every facts list, instead of seven variants. Terms
// take their widest width, values the rest and wrap; `mono` for machine keys and values.

/** One term and its value; the pair sits in a `contents` div, which a `dl` allows. */
export function DescriptionItem({
  term,
  mono = false,
  children,
}: {
  readonly term: ReactNode;
  readonly mono?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="contents">
      <dt className={cn("text-muted-foreground", mono && "font-mono")}>
        {term}
      </dt>
      <dd className={cn("min-w-0 break-words", mono && "font-mono break-all")}>
        {children}
      </dd>
    </div>
  );
}

/** `items` as `[term, value]` pairs (a string term is its key), and/or DescriptionItem children. */
export function DescriptionList({
  items = [],
  mono = false,
  className,
  children,
  ...props
}: React.ComponentProps<"dl"> & {
  readonly items?: readonly (readonly [term: string, value: ReactNode])[];
  readonly mono?: boolean;
}) {
  return (
    <dl
      data-slot="description-list"
      className={cn(
        "grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm",
        className,
      )}
      {...props}
    >
      {items.map(([term, value]) => (
        <DescriptionItem key={term} term={term} mono={mono}>
          {value}
        </DescriptionItem>
      ))}
      {children}
    </dl>
  );
}
