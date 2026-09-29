import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// A screen's title and a section's: one h1 per screen, at one size, and section headings
// at a set style per level, so the outline a screen reader walks is the one the eye sees.

export type HeadingLevel = "h2" | "h3" | "h4";

const SECTION_CLASS: Readonly<Record<HeadingLevel, string>> = {
  h2: "text-base leading-snug font-semibold",
  h3: "text-sm leading-snug font-semibold",
  h4: "text-sm leading-snug font-medium",
};

/**
 * The screen's one h1, a 12px meta row under it (badges, ids, facts) and its actions to the right.
 * `title` may hold more than text (an id, a key); it is still the heading's whole name.
 */
export function PageHeader({
  title,
  meta,
  actions,
  className,
}: {
  readonly title: ReactNode;
  readonly meta?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      data-slot="page-header"
      className={cn(
        "flex flex-wrap items-start justify-between gap-x-4 gap-y-2",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="font-head text-xl leading-tight font-semibold break-words">
          {title}
        </h1>
        {meta !== undefined && (
          <div
            data-slot="page-meta"
            className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
          >
            {meta}
          </div>
        )}
      </div>
      {actions !== undefined && (
        <div
          data-slot="page-actions"
          className="flex flex-wrap items-center gap-2"
        >
          {actions}
        </div>
      )}
    </div>
  );
}

/** A section's heading, at the level its place in the outline needs; one style per level. */
export function SectionTitle({
  as: Tag = "h2",
  className,
  ...props
}: React.ComponentProps<"h2"> & { readonly as?: HeadingLevel }) {
  return (
    <Tag
      data-slot="section-title"
      className={cn("font-head", SECTION_CLASS[Tag], className)}
      {...props}
    />
  );
}
