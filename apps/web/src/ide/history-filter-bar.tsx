import { TIMELINE_SOURCES, TimelineSource } from "@bayon/core";
import type { ProjectView } from "@bayon/proto";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  NO_FILTERS,
  SOURCE_LABELS,
  applied,
  canonicalSources,
  isDay,
  isFiltered,
  viewerTimeZone,
  type HistoryFilters,
} from "@/ide/history-filters";

// The History view's filter bar: kind chips, the agent, the date range and Clear all
// apply at once; the ticket and the search apply on Enter, together (one search form), so a
// half-typed key never asks the server. Every change is the caller's navigation: the URL holds them.

const ALL_AGENTS = "All agents";

const isSource = (value: unknown): value is TimelineSource =>
  TimelineSource.safeParse(value).success;

/** Where the server's refusal of the filters shows: under the ticket field, or above the list. */
export interface FilterRefusal {
  readonly ticket: string | null;
  readonly other: string | null;
}

export function HistoryFilterBar({
  project,
  filters,
  refusal,
  onChange,
  actions,
}: {
  readonly project: ProjectView;
  readonly filters: HistoryFilters;
  readonly refusal: FilterRefusal;
  readonly onChange: (next: HistoryFilters) => void;
  /** The export menu, beside Clear all. */
  readonly actions: ReactNode;
}) {
  const id = useId();
  const set = (patch: Partial<HistoryFilters>) =>
    onChange({ ...filters, ...patch });
  return (
    <div className="flex shrink-0 flex-col gap-3 border-b p-3">
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          aria-label="Kinds"
          multiple
          variant="outline"
          size="sm"
          className="flex-wrap"
          value={[...filters.sources]}
          onValueChange={(values: readonly unknown[]) =>
            set({ sources: canonicalSources(values.filter(isSource)) })
          }
        >
          {TIMELINE_SOURCES.map((source) => (
            <ToggleGroupItem key={source} value={source}>
              {SOURCE_LABELS[source]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={!isFiltered(filters)}
            onClick={() => onChange(NO_FILTERS)}
          >
            Clear all
          </Button>
          {actions}
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <AgentSelect
          project={project}
          value={filters.agent ?? null}
          onChange={(agent) => set({ agent: agent ?? undefined })}
        />
        <DateRange
          id={id}
          from={filters.from}
          to={filters.to}
          onChange={(from, to) => set({ from, to })}
        />
        <SearchForm
          filters={filters}
          ticketError={refusal.ticket}
          onApply={(ticket, q) => set({ ticket, q })}
        />
      </div>
      <p id={`${id}-zone`} className="text-xs text-muted-foreground">
        {`Days and times are in your timezone, ${viewerTimeZone()}; To includes its whole day.`}
      </p>
      {refusal.other !== null && (
        <p role="alert" className="text-sm text-destructive">
          {refusal.other}
        </p>
      )}
    </div>
  );
}

function AgentSelect({
  project,
  value,
  onChange,
}: {
  readonly project: ProjectView;
  readonly value: string | null;
  readonly onChange: (agent: string | null) => void;
}) {
  const labelId = useId();
  const listed = project.agents.map((agent) => ({
    value: agent.id as string | null,
    label: agent.name,
  }));
  // A link naming an agent the project lacks still names it rather than lie; the server refuses it.
  const items = [
    { value: null, label: ALL_AGENTS },
    ...listed,
    ...(value !== null && !listed.some((item) => item.value === value)
      ? [{ value, label: value }]
      : []),
  ];
  return (
    <div className="flex flex-col gap-1">
      <Label id={labelId} className="text-xs">
        Agent
      </Label>
      <Select
        items={items}
        value={value}
        onValueChange={(next: string | null) => onChange(next)}
      >
        <SelectTrigger aria-labelledby={labelId} size="sm" className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value ?? ""} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * Two native date inputs: days in the viewer's timezone, which the bar's note (`zoneId`) names. A
 * value that is not a calendar day (a five-digit year typed in) is not applied.
 */
function DateRange({
  id,
  from,
  to,
  onChange,
}: {
  readonly id: string;
  readonly from: string | undefined;
  readonly to: string | undefined;
  readonly onChange: (from: string | undefined, to: string | undefined) => void;
}) {
  const zoneId = `${id}-zone`;
  return (
    <div className="flex items-end gap-2">
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-from`} className="text-xs">
          From
        </Label>
        <Input
          id={`${id}-from`}
          type="date"
          className="h-7 w-36"
          aria-describedby={zoneId}
          value={from ?? ""}
          max={to}
          onChange={(event) => {
            const day = event.currentTarget.value;
            if (day === "" || isDay(day)) onChange(applied(day), to);
          }}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-to`} className="text-xs">
          To
        </Label>
        <Input
          id={`${id}-to`}
          type="date"
          className="h-7 w-36"
          aria-describedby={zoneId}
          value={to ?? ""}
          min={from}
          onChange={(event) => {
            const day = event.currentTarget.value;
            if (day === "" || isDay(day)) onChange(from, applied(day));
          }}
        />
      </div>
    </div>
  );
}

/**
 * The ticket and the text search: typed, then applied together on Enter or Search. The drafts follow
 * the applied values when those change from outside (Clear all, back/forward).
 */
function SearchForm({
  filters,
  ticketError,
  onApply,
}: {
  readonly filters: HistoryFilters;
  readonly ticketError: string | null;
  readonly onApply: (ticket: string | undefined, q: string | undefined) => void;
}) {
  const id = useId();
  const appliedTicket = filters.ticket ?? "";
  const appliedQ = filters.q ?? "";
  const [ticket, setTicket] = useState(appliedTicket);
  const [q, setQ] = useState(appliedQ);
  const [seen, setSeen] = useState({ ticket: appliedTicket, q: appliedQ });
  if (seen.ticket !== appliedTicket || seen.q !== appliedQ) {
    setSeen({ ticket: appliedTicket, q: appliedQ });
    setTicket(appliedTicket);
    setQ(appliedQ);
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onApply(applied(ticket), applied(q));
  };
  const errorId = `${id}-ticket-error`;
  return (
    <form
      role="search"
      aria-label="Search the history"
      className="flex flex-wrap items-end gap-2"
      onSubmit={submit}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-ticket`} className="text-xs">
          Ticket
        </Label>
        <Input
          id={`${id}-ticket`}
          className="h-7 w-32"
          placeholder="key, e.g. FRM-12"
          maxLength={64}
          value={ticket}
          aria-invalid={ticketError !== null}
          aria-describedby={ticketError === null ? undefined : errorId}
          onChange={(event) => setTicket(event.currentTarget.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-q`} className="text-xs">
          Search
        </Label>
        <Input
          id={`${id}-q`}
          type="search"
          className="h-7 w-56"
          placeholder="summary or actor, then Enter"
          maxLength={200}
          value={q}
          onChange={(event) => setQ(event.currentTarget.value)}
        />
      </div>
      <Button type="submit" variant="outline" size="sm">
        Search
      </Button>
      {ticketError !== null && (
        <p
          id={errorId}
          role="alert"
          className="basis-full text-sm text-destructive"
        >
          {ticketError}
        </p>
      )}
    </form>
  );
}
