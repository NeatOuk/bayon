import { TimelinePage, type TimelineExportFormat } from "@bayon/proto";
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiRequestError, downloadFile, getJson } from "@/api/http";
import { buttonVariants } from "@/components/ui/button";
import { notify } from "@/components/ui/toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { historyExportPath, historyPagePath } from "@/ide/history-api";
import type { HistoryFilters } from "@/ide/history-filters";

// The History view's export: every row the current filters match, as JSONL or CSV
// (`GET /projects/:id/timeline/export`). The browser downloads it straight to disk, so
// the page never holds it; a one-row read of the same filters first turns an expired login, a gone
// project or a refused filter into a message here instead of a saved error body.

type ExportState =
  | { readonly kind: "idle" }
  | { readonly kind: "exporting"; readonly format: TimelineExportFormat }
  | { readonly kind: "failed"; readonly message: string };

const FORMATS: readonly (readonly [TimelineExportFormat, string])[] = [
  ["jsonl", "Export JSONL"],
  ["csv", "Export CSV"],
];

const reasonOf = (error: unknown): string =>
  error instanceof ApiRequestError
    ? error.error.message
    : error instanceof Error
      ? error.message
      : String(error);

export function HistoryExport({
  project,
  filters,
  disabled,
}: {
  readonly project: string;
  readonly filters: HistoryFilters;
  readonly disabled: boolean;
}) {
  const [state, setState] = useState<ExportState>({ kind: "idle" });
  // Leaving the view cancels a check in flight: no download for a screen the reader has left.
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);
  const run = async (format: TimelineExportFormat) => {
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    setState({ kind: "exporting", format });
    try {
      await getJson(
        historyPagePath(project, filters, 1, null),
        TimelinePage,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      downloadFile(historyExportPath(project, filters, format));
      setState({ kind: "idle" });
      notify.success(`${format.toUpperCase()} download started`);
    } catch (error) {
      if (!controller.signal.aborted)
        setState({ kind: "failed", message: reasonOf(error) });
    }
  };
  return (
    <div className="flex items-center gap-2">
      <span role="status" className="text-xs text-muted-foreground">
        {state.kind === "exporting" ? "Exporting…" : ""}
      </span>
      {state.kind === "failed" && (
        <span role="alert" className="text-xs text-destructive">
          {`Export failed: ${state.message}`}
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled || state.kind === "exporting"}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Export
          <ChevronDownIcon className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" aria-label="export the history">
          {FORMATS.map(([format, label]) => (
            <DropdownMenuItem key={format} onClick={() => void run(format)}>
              {label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
