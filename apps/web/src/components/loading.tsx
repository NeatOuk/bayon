import { LoaderCircle } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// What a screen or panel shows while its query loads: one polite status line, the same
// small spinner and wording everywhere, and optionally skeleton lines holding the content's place.

const LINE_WIDTHS = ["w-3/4", "w-full", "w-5/6", "w-2/3"] as const;

export function Loading({
  label,
  lines = 0,
  className,
}: {
  /** What is loading, as a sentence: "Loading the board…". */
  readonly label: string;
  /** Skeleton lines under the label, for a list or a panel about to fill. */
  readonly lines?: number;
  readonly className?: string;
}) {
  return (
    <div data-slot="loading" className={cn("flex flex-col gap-2", className)}>
      <p
        role="status"
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <LoaderCircle
          aria-hidden="true"
          className="size-4 shrink-0 animate-spin"
        />
        {label}
      </p>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          className={cn("h-4", LINE_WIDTHS[i % LINE_WIDTHS.length])}
        />
      ))}
    </div>
  );
}
