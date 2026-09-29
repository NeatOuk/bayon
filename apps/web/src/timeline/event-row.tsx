import type { EventItem } from "@bayon/proto";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { payloadQuery } from "@/api/queries";
import { QueryError } from "@/components/query-error";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { formatBytes, isError } from "@/timeline/event-view";

// One Timeline row per canonical event (§5.2), rendered by kind (§12.3).

const LABELS: Readonly<Record<EventItem["kind"], string>> = {
  session_init: "init",
  turn_start: "turn",
  turn_end: "turn",
  assistant_text: "text",
  reasoning: "think",
  tool_call: "tool",
  tool_result: "result",
  file_change: "file",
  command: "cmd",
  todo: "todo",
  mcp_call: "mcp",
  approval_request: "ask",
  usage: "usage",
  error: "error",
  terminal: "end",
  runner_native: "native",
};

const CHANGE = { add: "A", modify: "M", delete: "D" } as const;

/** Kinds whose body is prose: read in the text face; the rest (tools, commands, counts) in mono. */
const PROSE: ReadonlySet<EventItem["kind"]> = new Set([
  "assistant_text",
  "reasoning",
  "error",
]);
const PREVIEW_CHARS = 160;

const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour12: false });

const oneLine = (value: unknown): string => {
  const text =
    typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return text.length > PREVIEW_CHARS
    ? `${text.slice(0, PREVIEW_CHARS)}…`
    : text;
};

const tokens = (usage: { tokens_in: number; tokens_out: number }) =>
  `${usage.tokens_in} in · ${usage.tokens_out} out`;

const suffix = (value: string | number | undefined, prefix = " · ") =>
  value === undefined ? "" : `${prefix}${value}`;

export interface EventRowProps {
  readonly sessionId: string;
  readonly event: EventItem;
  /** Reasoning only: whether its text is shown. */
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function EventRow({
  sessionId,
  event,
  open,
  onOpenChange,
}: EventRowProps) {
  const failed = isError(event);
  return (
    <div
      data-testid="event-row"
      data-event-id={event.id}
      data-error={failed || undefined}
      className={cn(
        "flex items-start gap-3 border-b px-4 py-2 text-xs",
        // A failure reads on the danger tone's soft surface, its badge in the tone: marked, not shouted.
        failed && "bg-danger-subtle text-foreground",
      )}
    >
      <span className="w-16 shrink-0 pt-0.5 font-mono text-muted-foreground tabular-nums">
        {clock(event.ts)}
      </span>
      <StatusBadge
        entity="event"
        state={failed ? "error" : "ok"}
        label={LABELS[event.kind]}
        className="mt-px w-20 shrink-0 justify-start"
      />
      <div
        className={cn(
          "min-w-0 flex-1 space-y-1 break-words",
          PROSE.has(event.kind)
            ? "text-sm leading-relaxed"
            : "pt-0.5 font-mono",
        )}
      >
        <EventBody event={event} open={open} onOpenChange={onOpenChange} />
        {event.truncated && (
          <TruncatedPayload sessionId={sessionId} event={event} />
        )}
      </div>
    </div>
  );
}

function EventBody({
  event,
  open,
  onOpenChange,
}: Omit<EventRowProps, "sessionId">) {
  switch (event.kind) {
    case "assistant_text":
      return <p className="whitespace-pre-wrap">{event.text}</p>;
    case "reasoning":
      return (
        <Collapsible open={open} onOpenChange={onOpenChange}>
          <CollapsibleTrigger className="cursor-pointer hover:underline">
            {`${open ? "▾" : "▸"} reasoning · ${event.text.length} chars`}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <p className="whitespace-pre-wrap opacity-80">{event.text}</p>
          </CollapsibleContent>
        </Collapsible>
      );
    case "tool_call":
      return (
        <p>
          <strong>{event.tool_name}</strong> {oneLine(event.payload.input)}
        </p>
      );
    case "tool_result":
      return (
        <>
          <p>
            <strong>{event.tool_name ?? "result"}</strong>
            {` → ${event.status}`}
            {suffix(event.exit_code, " · exit ")}
            {suffix(event.payload.output_path)}
          </p>
          {event.payload.head !== undefined && (
            <pre className="whitespace-pre-wrap opacity-80">
              {event.payload.head}
            </pre>
          )}
        </>
      );
    case "command":
      return (
        <p>
          <strong>{event.payload.argv.join(" ")}</strong>
          {suffix(event.exit_code, " → exit ")}
          {suffix(
            event.payload.duration_ms === undefined
              ? undefined
              : `${(event.payload.duration_ms / 1000).toFixed(1)}s`,
          )}
          {suffix(event.payload.output_path)}
        </p>
      );
    case "file_change":
      return (
        <p>
          {`${CHANGE[event.payload.change]} ${event.payload.repo === undefined ? "" : `${event.payload.repo}:`}${event.payload.path} `}
          <span className="text-success">{`+${event.payload.lines_added ?? 0}`}</span>{" "}
          <span className="text-danger">{`-${event.payload.lines_removed ?? 0}`}</span>
        </p>
      );
    case "error":
      return (
        <p>
          <strong>{event.payload.class}</strong>{" "}
          <span>{event.payload.message}</span>
        </p>
      );
    case "terminal":
      return (
        <p>
          {`run ${event.payload.outcome}`}
          {suffix(event.payload.error?.message)}
          {suffix(event.payload.cost_usd?.toFixed(2), " · $")}
        </p>
      );
    case "turn_start":
      return <p>turn start</p>;
    case "turn_end":
      return (
        <p>
          turn end
          {suffix(event.payload.stop_reason)}
          {suffix(event.payload.usage && tokens(event.payload.usage))}
        </p>
      );
    case "usage":
      return (
        <p>
          {tokens(event.payload.usage)}
          {suffix(event.payload.cost_usd?.toFixed(4), " · $")}
        </p>
      );
    case "todo": {
      const done = event.payload.items.filter((i) => i.status === "completed");
      const now = event.payload.items.find((i) => i.status === "in_progress");
      return (
        <p>
          {`${done.length}/${event.payload.items.length} done`}
          {suffix(now?.text, " · now: ")}
        </p>
      );
    }
    case "mcp_call":
      return (
        <p>
          <strong>{`${event.payload.server}.${event.tool_name}`}</strong>
          {suffix(event.payload.args_digest)}
        </p>
      );
    case "approval_request":
      return (
        <p>
          {"approve "}
          <strong>{event.tool_name}</strong>
          {suffix(event.payload.risk, " · risk ")}
          {` ${oneLine(event.payload.input)}`}
        </p>
      );
    case "session_init":
      return (
        <p>
          {`session ${event.payload.runner_session_id}`}
          {suffix(event.payload.model)}
          {suffix(event.payload.cwd)}
        </p>
      );
    case "runner_native":
      return (
        <p>
          {event.runner_type}
          {suffix(event.payload.issues?.join("; "))}
        </p>
      );
  }
}

/** §8.5: a capped row says how big the original was and fetches the rest on demand. */
function TruncatedPayload({
  sessionId,
  event,
}: {
  readonly sessionId: string;
  readonly event: EventItem;
}) {
  const [wanted, setWanted] = useState(false);
  const full = useQuery({
    ...payloadQuery(sessionId, event.id),
    enabled: wanted,
  });
  return (
    <div className="space-y-1">
      <p className="opacity-80">
        {"truncated"}
        {suffix(
          event.bytes_original === undefined
            ? undefined
            : formatBytes(event.bytes_original),
        )}
        {suffix(event.payload_path, " → ")}{" "}
        {full.data === undefined && (
          <Button
            variant="link"
            size="xs"
            disabled={full.isFetching}
            onClick={() => setWanted(true)}
          >
            {full.isFetching ? "Loading…" : "Load full text"}
          </Button>
        )}
      </p>
      {full.isError && (
        <QueryError
          title="The full text is unavailable"
          error={full.error}
          onRetry={() => void full.refetch()}
        />
      )}
      {full.data !== undefined && (
        <pre className="max-h-96 overflow-auto rounded-lg border bg-card p-2 whitespace-pre-wrap text-card-foreground">
          {full.data}
        </pre>
      )}
    </div>
  );
}
