import type { MissionVersion } from "@bayon/proto";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatTime } from "@/lib/format";
import { Markdown } from "@/markdown/markdown";

/**
 * Someone saved a newer version while this draft was open (a 409, M1 contract 3). The draft is kept;
 * the newer version is shown, and the operator picks: save the draft on top of it, or load it.
 */
export function MissionConflict({
  base,
  latest,
  onKeep,
  onLoad,
}: {
  readonly base: number;
  readonly latest: MissionVersion;
  readonly onKeep: () => void;
  readonly onLoad: () => void;
}) {
  const started = base === 0 ? "no mission" : `v${base}`;
  return (
    <Alert status="warning">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>
        {`v${latest.version} was saved while you were editing; your draft started from ${started}.`}
      </AlertTitle>
      <AlertDescription className="gap-2 [&_p:not(:last-child)]:mb-0">
        <p className="text-sm">
          <span>{latest.note ?? "(no note)"}</span>
          <span className="text-muted-foreground">{` · ${latest.created_by} · ${formatTime(latest.created_at)}`}</span>
        </p>
        <div className="max-h-64 overflow-auto rounded-lg border bg-card p-3 text-card-foreground">
          <Markdown markdown={latest.rendered_md} />
        </div>
        <p className="text-sm">
          {`Keep my draft saves it as v${latest.version + 1}, replacing the text above. Load v${latest.version} discards the draft.`}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={onKeep}>
            Keep my draft
          </Button>
          <Button size="sm" variant="outline" onClick={onLoad}>
            {`Load v${latest.version}`}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
