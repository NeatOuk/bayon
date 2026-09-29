import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * One titled part of a screen: a named region (for assistive tech and tests) around a card whose
 * title is a real heading — h2 under the screen's h1, or `level` 3 for a panel inside another.
 * `fill` lets it shrink in a filling page (PageContainer `fill`), so a `<Table scroll="fill">` in
 * it scrolls within the space the page leaves it.
 */
export function Panel({
  label,
  title,
  level = 2,
  fill = false,
  children,
}: {
  readonly label: string;
  readonly title: string;
  readonly level?: 2 | 3 | 4;
  readonly fill?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={label} className={cn(fill && "flex min-h-0 flex-col")}>
      <Card size="sm" className={cn(fill && "min-h-0")}>
        <CardHeader>
          <CardTitle as={`h${level}`} className="font-head">
            {title}
          </CardTitle>
        </CardHeader>
        <CardContent className={cn("flex flex-col gap-2", fill && "min-h-0")}>
          {children}
        </CardContent>
      </Card>
    </section>
  );
}
