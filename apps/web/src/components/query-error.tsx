import { CircleX, RotateCcw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// A query that failed: what is unavailable, the server's own words for why, and a way to
// ask again — the query's refetch — instead of a bare sentence and a reload.

export function QueryError({
  title,
  error,
  onRetry,
  className,
}: {
  /** What could not be read, as a sentence: "The inbox is unavailable". */
  readonly title: string;
  readonly error: Error;
  /** The query's refetch; omitted where asking again cannot help. */
  readonly onRetry?: () => unknown;
  readonly className?: string;
}) {
  return (
    <Alert status="error" className={cn("max-w-3xl", className)}>
      <CircleX aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{error.message}</p>
        {onRetry !== undefined && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void onRetry()}
          >
            <RotateCcw aria-hidden="true" />
            Retry
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
