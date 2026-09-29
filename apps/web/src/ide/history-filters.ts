import { TIMELINE_SOURCES, TimelineSource } from "@bayon/core";

// The History view's filters: what the filter bar holds, how the URL carries it, and the
// timeline query it asks (`GET /projects/:id/timeline`). Pure: the router, the view, the
// live head and the export all read them here.

/** The kind chips, one per timeline source, labelled as the bar shows them. */
export const SOURCE_LABELS: Readonly<Record<TimelineSource, string>> = {
  audit: "Audit",
  ticket: "Tickets",
  session: "Sessions",
  pulse: "Pulses",
  gate: "Gates",
  finding: "Findings",
  handoff: "Hand-offs",
  human_request: "Requests",
};

/**
 * What the History view is filtered by. `sources` empty means every source. `from` and `to` are the
 * date inputs' own `YYYY-MM-DD`, days in the viewer's timezone, `to` inclusive.
 */
export interface HistoryFilters {
  readonly sources: readonly TimelineSource[];
  readonly agent?: string;
  readonly ticket?: string;
  readonly from?: string;
  readonly to?: string;
  readonly q?: string;
}

export const NO_FILTERS: HistoryFilters = { sources: [] };

/** True when any filter is set. */
export const isFiltered = (f: HistoryFilters): boolean =>
  f.sources.length > 0 ||
  [f.agent, f.ticket, f.from, f.to, f.q].some((value) => value !== undefined);

/** `sources` without repeats, in the API's order, so one filter has one URL and one query key. */
export const canonicalSources = (
  sources: readonly TimelineSource[],
): readonly TimelineSource[] =>
  TIMELINE_SOURCES.filter((source) => sources.includes(source));

/** A filter's value as applied: trimmed, and absent when empty. */
export const applied = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

/** The URL's names for the filters, in the order a link writes them. */
export const FILTER_PARAMS = [
  "kind",
  "agent",
  "ticket",
  "from",
  "to",
  "q",
] as const;
type FilterParam = (typeof FILTER_PARAMS)[number];

export const isFilterParam = (name: string): name is FilterParam =>
  (FILTER_PARAMS as readonly string[]).includes(name);

const DAY = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/** Local midnight of `day` (`YYYY-MM-DD`), or null when it is not a calendar day. */
function localMidnight(day: string): Date | null {
  const match = DAY.exec(day);
  if (match === null) return null;
  const [year, month, date] = match.slice(1).map(Number) as [
    number,
    number,
    number,
  ];
  // setFullYear, not the Date constructor: that maps years 0–99 onto 1900–1999.
  const at = new Date(0);
  at.setFullYear(year, month - 1, date);
  at.setHours(0, 0, 0, 0);
  return at.getFullYear() === year &&
    at.getMonth() === month - 1 &&
    at.getDate() === date
    ? at
    : null;
}

export const isDay = (day: string): boolean => localMidnight(day) !== null;

/**
 * Epoch ms where `day` starts in the viewer's timezone; with `inclusive`, where the next day starts,
 * so a `to` of that day keeps its last millisecond. Days are dates, not 24 h: a DST day is 23 or 25.
 */
export function dayBoundMs(day: string, inclusive = false): number {
  const at = localMidnight(day);
  if (at === null) throw new Error(`not a day: ${day}`);
  if (inclusive) at.setDate(at.getDate() + 1);
  return at.getTime();
}

/** The viewer's timezone, as the bar names it. */
export const viewerTimeZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The filters as the URL's `name=value` pairs, values encoded; none when unfiltered. */
export function filterParams(f: HistoryFilters): readonly string[] {
  const kind = canonicalSources(f.sources);
  const values: readonly (readonly [FilterParam, string | undefined])[] = [
    ["agent", f.agent],
    ["ticket", f.ticket],
    ["from", f.from],
    ["to", f.to],
    ["q", f.q],
  ];
  return [
    // Source names are [a-z_]: the list reads as written.
    ...(kind.length === 0 ? [] : [`kind=${kind.join(",")}`]),
    ...values.flatMap(([name, value]) =>
      value === undefined ? [] : [`${name}=${encodeURIComponent(value)}`],
    ),
  ];
}

const isSource = (value: string): value is TimelineSource =>
  TimelineSource.safeParse(value).success;

/**
 * The filters from the URL's decoded pairs, or null when one is malformed: an unknown name, an empty
 * value, an unknown source, or a date that is not a calendar day.
 */
export function parseFilterParams(
  pairs: ReadonlyMap<string, string>,
): HistoryFilters | null {
  let filters: HistoryFilters = NO_FILTERS;
  for (const [name, value] of pairs) {
    if (!isFilterParam(name) || value === "") return null;
    if (name === "kind") {
      const sources = value.split(",");
      if (!sources.every(isSource)) return null;
      filters = { ...filters, sources: canonicalSources(sources) };
    } else if ((name === "from" || name === "to") && !isDay(value)) {
      return null;
    } else {
      filters = { ...filters, [name]: value };
    }
  }
  return filters;
}

/**
 * The filters as the timeline's query parameters (never `limit` or `cursor`), encoded, in a fixed
 * order: a chip asks for its whole source (`ticket.*`), the dates their local-day bounds in ms.
 */
export function timelineParams(f: HistoryFilters): readonly string[] {
  const kind = canonicalSources(f.sources);
  const text = (name: string, value: string | undefined): readonly string[] =>
    value === undefined ? [] : [`${name}=${encodeURIComponent(value)}`];
  return [
    ...(kind.length === 0
      ? []
      : [`kind=${kind.map((source) => `${source}.*`).join(",")}`]),
    ...text("agent", f.agent),
    ...text("ticket", f.ticket),
    ...(f.from === undefined ? [] : [`from=${dayBoundMs(f.from)}`]),
    ...(f.to === undefined ? [] : [`to=${dayBoundMs(f.to, true)}`]),
    ...text("q", f.q),
  ];
}
