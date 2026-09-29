import type { LucideIcon } from "lucide-react";
import { useId, type ReactNode } from "react";
import { FOCUS_RING } from "@/components/text-link";
import { cn } from "@/lib/utils";

// The sidebar's parts, shared by the fleet's navigation and a project's explorer so the
// two scopes are one product: small group labels, 32px rows, an icon, the label, a count at the end.

/**
 * A row (after FOCUS_RING, whose offset it pulls inside: the sidebar scrolls, and would clip a ring
 * drawn outside the row). The current one is `aria-current="page"` and looks it: the selected
 * surface, medium weight and a primary bar on its left edge — never the hover fill, which only the
 * other rows take.
 */
export const navItemClass = (current: boolean): string =>
  cn(
    "relative flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-sm focus-visible:-outline-offset-2",
    current
      ? "bg-selected font-medium text-selected-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-primary"
      : "text-foreground hover:bg-accent hover:text-accent-foreground",
  );

export function NavItem({
  href,
  current,
  icon: Icon,
  label,
  end,
  onNavigate,
  className,
}: {
  readonly href: string;
  readonly current: boolean;
  readonly icon?: LucideIcon;
  /** The row's words; a string is truncated to the row. */
  readonly label: ReactNode;
  /** A count or a state at the row's end. */
  readonly end?: ReactNode;
  readonly onNavigate?: (() => void) | undefined;
  readonly className?: string;
}) {
  return (
    <a
      href={href}
      aria-current={current ? "page" : undefined}
      className={cn(FOCUS_RING, navItemClass(current), className)}
      onClick={onNavigate}
    >
      {Icon !== undefined && (
        <Icon
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0",
            current ? "text-primary" : "text-muted-foreground",
          )}
        />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {end}
    </a>
  );
}

/**
 * A group: its label names the list for assistive tech ("Work, list, 4 items") without adding to
 * the page's heading outline, which stays the screen's own. `title` replaces the plain label's
 * content (the Projects group's is a link) and must read the same.
 */
export function NavGroup({
  label,
  title,
  children,
}: {
  readonly label: string;
  readonly title?: ReactNode;
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-0.5">
      <div
        id={id}
        className="flex h-7 items-center px-2 text-xs font-medium text-muted-foreground"
      >
        {title ?? label}
      </div>
      <ul aria-labelledby={id} className="flex flex-col gap-0.5">
        {children}
      </ul>
    </div>
  );
}
