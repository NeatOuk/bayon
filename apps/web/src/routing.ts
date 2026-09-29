import { MissionSection } from "@bayon/core";
import { useLayoutEffect, useSyncExternalStore } from "react";
import {
  filterParams,
  parseFilterParams,
  type HistoryFilters,
} from "@/ide/history-filters";
import { tabOf, withTab } from "@/lib/hash-tab";
import { replaceHash, subscribeHistory } from "@/lib/history";

// Screens addressed by the URL hash: `#/` is the Fleet, `#/sessions/<id>` a session,
// `#/missions/<agent>` an agent's mission editor (`?section=laws` focuses one section),
// `#/tickets` the board and `#/tickets/<num>` one ticket, `#/projects` the projects and
// `#/projects/new` a new one, `#/inbox` the human requests,
// `#/pulses` the pulses and `#/pulses/<id>` one, `#/spend` the spend ledger, `#/reviews` the
// review queue, `#/runners` the runners and their certification, `#/executors` the executors,
// `#/settings` (or `#/settings/general`) the operator's settings, `#/settings/roles` the role
// bindings, `#/settings/notifications` the notification channels, `#/audit` the audit
// log. `#/p/<project>/<view>` is one project's IDE, with
// `?open=ticket:<num>|session:<id>|agent:<id>|pulse:<id>` its focused editor tab, and on the history
// view its filters beside it (`?kind=ticket,gate&agent=…&ticket=…&from=…&to=…&q=…`); the
// rest are fleet-wide. The Inbox, fleet or project, takes `?ticket=<num>`: one ticket's requests
//, where a ticket's "needs human" badge sends the operator to answer.
//
// A screen with tabs of its own (a session, the Inbox, a project's IDE, whose view or editor tab may
// have them) keeps the open one in a `tab` pair: stripped before the address is matched,
// and carried on the route. On any other screen a `tab` is as unknown as any other pair.
//
// One address per screen: a fleet screen narrowed to a project (`#/tickets?project=X`,
// the same for the inbox, spend and reviews) and the old `#/review` are aliases, parsed as the
// screen they name and rewritten in the address bar (`useCanonicalAddress`). Any other hash is Not
// found, never silently the Fleet.

/**
 * The IDE's views of one project, in the explorer's order. Reviews, Inbox and Spend are the fleet's
 * screens scoped to the project.
 */
export const IDE_VIEWS = [
  "overview",
  "orchestrator",
  "agents",
  "tickets",
  "reviews",
  "inbox",
  "spend",
  "history",
  "settings",
] as const;
export type IdeView = (typeof IDE_VIEWS)[number];

/** An editor tab the IDE opens beside its view: a ticket, a session, an agent or a pulse. */
export type EditorTab =
  | { readonly kind: "ticket"; readonly num: number }
  | { readonly kind: "session"; readonly id: string }
  | { readonly kind: "agent"; readonly id: string }
  | { readonly kind: "pulse"; readonly id: string };

export type Route =
  | { readonly name: "fleet" }
  | {
      readonly name: "session";
      readonly sessionId: string;
      /** The open tab (`?tab=`), when the address names one. */
      readonly tab?: string;
    }
  | {
      readonly name: "mission";
      readonly agent: string;
      readonly section?: MissionSection;
    }
  | { readonly name: "tickets" }
  | { readonly name: "ticket"; readonly num: number }
  | {
      readonly name: "inbox";
      /** One ticket's requests only. */
      readonly ticket?: number;
      readonly tab?: string;
    }
  | { readonly name: "pulses" }
  | { readonly name: "pulse"; readonly pulseId: string }
  | { readonly name: "spend" }
  | { readonly name: "reviews" }
  | { readonly name: "runners" }
  | { readonly name: "executors" }
  | { readonly name: "projects" }
  | { readonly name: "newProject" }
  | { readonly name: "general" }
  | { readonly name: "roles" }
  | { readonly name: "notifications" }
  | { readonly name: "audit" }
  /** A hash no screen answers to, kept to say which. */
  | { readonly name: "notFound"; readonly hash: string }
  | {
      readonly name: "project";
      readonly project: string;
      readonly view: IdeView;
      readonly open?: EditorTab;
      /** The history view's filters, when any is set. */
      readonly filters?: HistoryFilters;
      /** The inbox view's ticket, when it shows one ticket's requests. */
      readonly ticket?: number;
      /** The focused view's or editor tab's own tab (`?tab=`). */
      readonly tab?: string;
    };

const SESSION = /^#\/sessions\/([^/?]+)$/;
const MISSION = /^#\/missions\/([^/?]+)(?:\?section=([^&]*))?$/;
const TICKET_NUM = "[1-9][0-9]{0,14}";
const TICKET = new RegExp(`^#/tickets/(${TICKET_NUM})$`);
const PROJECT = /^#\/p\/([^/?]+)(?:\/([a-z]+))?(?:\?(.*))?$/;
const OPEN = /^(ticket|session|agent|pulse):(.+)$/;
/** A fleet screen with a query: `#/tickets?project=X` and the like (aliases). */
const FLEET_QUERY = /^#\/(tickets|inbox|spend|reviews?)\?(.+)$/;
const PULSE = /^#\/pulses\/([^/?]+)$/;
const INBOX_TICKET = new RegExp(`^#/inbox\\?ticket=(${TICKET_NUM})$`);
const FLEET: Route = { name: "fleet" };

export const FLEET_HREF = "#/";
export const TICKETS_HREF = "#/tickets";
export const INBOX_HREF = "#/inbox";
export const PULSES_HREF = "#/pulses";
export const SPEND_HREF = "#/spend";
export const REVIEWS_HREF = "#/reviews";
export const RUNNERS_HREF = "#/runners";
export const EXECUTORS_HREF = "#/executors";
export const PROJECTS_HREF = "#/projects";
export const NEW_PROJECT_HREF = `${PROJECTS_HREF}/new`;
export const SETTINGS_HREF = "#/settings";
export const GENERAL_HREF = `${SETTINGS_HREF}/general`;
export const ROLES_HREF = `${SETTINGS_HREF}/roles`;
export const NOTIFICATIONS_HREF = `${SETTINGS_HREF}/notifications`;
export const AUDIT_HREF = "#/audit";

/** The screens a bare hash names. */
const STATIC: Readonly<Record<string, Route>> = {
  [TICKETS_HREF]: { name: "tickets" },
  [INBOX_HREF]: { name: "inbox" },
  [PULSES_HREF]: { name: "pulses" },
  [SPEND_HREF]: { name: "spend" },
  [REVIEWS_HREF]: { name: "reviews" },
  [RUNNERS_HREF]: { name: "runners" },
  [EXECUTORS_HREF]: { name: "executors" },
  [PROJECTS_HREF]: { name: "projects" },
  [NEW_PROJECT_HREF]: { name: "newProject" },
  [SETTINGS_HREF]: { name: "general" },
  [GENERAL_HREF]: { name: "general" },
  [ROLES_HREF]: { name: "roles" },
  [NOTIFICATIONS_HREF]: { name: "notifications" },
  [AUDIT_HREF]: { name: "audit" },
};

/** A path segment, or null for a malformed %-escape. */
function decode(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** A malformed address of a known screen is as unknown as any other: null, and so Not found. */
function parseMission(match: RegExpExecArray): Route | null {
  const agent = decode(match[1] ?? "");
  if (agent === null) return null;
  if (match[2] === undefined) return { name: "mission", agent };
  const section = MissionSection.safeParse(match[2]);
  return section.success
    ? { name: "mission", agent, section: section.data }
    : null;
}

/** `#/<screen>/<id>` with the id decoded, or null when the hash is not that screen's. */
function idIn(pattern: RegExp, hash: string): string | null {
  const raw = pattern.exec(hash)?.[1];
  return raw === undefined ? null : decode(raw);
}

const isIdeView = (view: string): view is IdeView =>
  (IDE_VIEWS as readonly string[]).includes(view);

/** `?open=<kind>:<ref>`: a ticket by number; a session, an agent or a pulse by its decoded id. */
function parseOpen(kind: string, raw: string): EditorTab | null {
  if (kind === "ticket")
    return new RegExp(`^${TICKET_NUM}$`).test(raw)
      ? { kind, num: Number(raw) }
      : null;
  const id = decode(raw);
  if (id === null) return null;
  switch (kind) {
    case "session":
    case "pulse":
      return { kind, id };
    default:
      return { kind: "agent", id };
  }
}

/** `a=1&b=2` into its raw pairs; null when one lacks a name or `=`, or a name repeats. */
function queryPairs(raw: string): ReadonlyMap<string, string> | null {
  const pairs = new Map<string, string>();
  for (const part of raw.split("&")) {
    const at = part.indexOf("=");
    const name = part.slice(0, at);
    if (at <= 0 || pairs.has(name)) return null;
    pairs.set(name, part.slice(at + 1));
  }
  return pairs;
}

/** The history view's filters from the pairs besides `open`, decoded; null when one is malformed. */
function parseFilters(
  pairs: readonly (readonly [string, string])[],
): HistoryFilters | null {
  const decoded = new Map<string, string>();
  for (const [name, raw] of pairs) {
    const value = decode(raw);
    if (value === null) return null;
    decoded.set(name, value);
  }
  return parseFilterParams(decoded);
}

/** The inbox view's `ticket=<num>` when it is the only pair besides `open`; else undefined. */
function inboxTicket(
  view: IdeView,
  rest: readonly (readonly [string, string])[],
): number | undefined {
  const [only, ...more] = rest;
  if (view !== "inbox" || only === undefined || more.length > 0)
    return undefined;
  const [name, raw] = only;
  return name === "ticket" && new RegExp(`^${TICKET_NUM}$`).test(raw)
    ? Number(raw)
    : undefined;
}

/**
 * `#/p/<project>/<view>?<pairs>`: `open` names the focused tab on any view; the filters are the
 * history view's alone, and `ticket` the inbox view's. An unknown name, a repeated one or a
 * malformed value is null: Not found.
 */
function parseProject(match: RegExpExecArray): Route | null {
  const project = decode(match[1] ?? "");
  const view = match[2] ?? "overview";
  if (project === null || !isIdeView(view)) return null;
  if (match[3] === undefined) return { name: "project", project, view };
  const pairs = queryPairs(match[3]);
  if (pairs === null) return null;
  const openRaw = pairs.get("open");
  const openMatch = openRaw === undefined ? undefined : OPEN.exec(openRaw);
  const open =
    openMatch === undefined
      ? undefined
      : openMatch === null
        ? null
        : parseOpen(openMatch[1] ?? "", openMatch[2] ?? "");
  if (open === null) return null;
  const rest = [...pairs].filter(([name]) => name !== "open");
  const ticket = inboxTicket(view, rest);
  if (ticket !== undefined) {
    return {
      name: "project",
      project,
      view,
      ...(open === undefined ? {} : { open }),
      ticket,
    };
  }
  const filters =
    rest.length === 0
      ? undefined
      : view === "history"
        ? parseFilters(rest)
        : null;
  if (filters === null) return null;
  return {
    name: "project",
    project,
    view,
    ...(open === undefined ? {} : { open }),
    ...(filters === undefined ? {} : { filters }),
  };
}

/** The IDE view a fleet screen's alias names. */
const ALIAS_VIEW: Readonly<Record<string, IdeView>> = {
  tickets: "tickets",
  inbox: "inbox",
  spend: "spend",
  review: "reviews",
  reviews: "reviews",
};

/**
 * The canonical address for an alias, or null when `hash` is none: a fleet screen narrowed to one
 * project is that project's view (`#/tickets?project=X` → `#/p/X/tickets`; the inbox keeps its
 * `ticket`), and the review queue's old `#/review` is `#/reviews`.
 */
export function resolveAlias(hash: string): string | null {
  if (hash === "#/review") return REVIEWS_HREF;
  const match = FLEET_QUERY.exec(hash);
  if (match === null) return null;
  const view = ALIAS_VIEW[match[1] ?? ""];
  const pairs = queryPairs(match[2] ?? "");
  const raw = pairs?.get("project");
  const project = raw === undefined ? null : decode(raw);
  if (
    view === undefined ||
    pairs === null ||
    project === null ||
    project === ""
  )
    return null;
  const rest = [...pairs].filter(([name]) => name !== "project");
  if (rest.length === 0) return projectHref(project, view);
  const [only] = rest;
  return view === "inbox" &&
    rest.length === 1 &&
    only?.[0] === "ticket" &&
    new RegExp(`^${TICKET_NUM}$`).test(only[1])
    ? inboxHref(project, Number(only[1]))
    : null;
}

/** The screen at a known address, or null. */
function parseKnown(hash: string): Route | null {
  const known = STATIC[hash];
  if (known !== undefined) return known;
  const ide = PROJECT.exec(hash);
  if (ide !== null) return parseProject(ide);
  const inbox = INBOX_TICKET.exec(hash)?.[1];
  if (inbox !== undefined) return { name: "inbox", ticket: Number(inbox) };
  const ticket = TICKET.exec(hash)?.[1];
  if (ticket !== undefined) return { name: "ticket", num: Number(ticket) };
  const mission = MISSION.exec(hash);
  if (mission !== null) return parseMission(mission);
  const pulseId = idIn(PULSE, hash);
  if (pulseId !== null) return { name: "pulse", pulseId };
  const sessionId = idIn(SESSION, hash);
  return sessionId === null ? null : { name: "session", sessionId };
}

/** The screen an address without a `tab` names. */
function parseAddress(hash: string): Route {
  const address = resolveAlias(hash) ?? hash;
  if (address === "" || address === FLEET_HREF) return FLEET;
  return parseKnown(address) ?? { name: "notFound", hash };
}

/** `route` carrying `tab`, when it is a screen with tabs of its own; else null. */
function tabbed(route: Route, tab: string): Route | null {
  switch (route.name) {
    case "session":
    case "inbox":
    case "project":
      return { ...route, tab };
    default:
      return null;
  }
}

/**
 * The screen `hash` names: an alias as its canonical screen; no hash is the Fleet; else Not found.
 * A `tab` pair is taken off first and carried on the route, for a screen with tabs of its own.
 */
export function parseRoute(hash: string): Route {
  const tab = tabOf(hash);
  if (tab === null) return parseAddress(hash);
  return (
    tabbed(parseAddress(withTab(hash, null)), tab) ?? {
      name: "notFound",
      hash,
    }
  );
}

export const sessionHref = (sessionId: string): string =>
  `#/sessions/${encodeURIComponent(sessionId)}`;

export const missionHref = (agent: string, section?: MissionSection): string =>
  `#/missions/${encodeURIComponent(agent)}${section === undefined ? "" : `?section=${section}`}`;

export const ticketHref = (num: number): string => `${TICKETS_HREF}/${num}`;

/**
 * Where a screen's links to a ticket or a session go: their own screens across the
 * fleet; inside a project's IDE, a tab beside the view.
 */
export interface RecordLinks {
  readonly ticket: (num: number) => string;
  readonly session: (sessionId: string) => string;
}

export const FLEET_RECORD_LINKS: RecordLinks = {
  ticket: ticketHref,
  session: sessionHref,
};

/** The board, or one project's: its IDE's Tickets view, the one address for it. */
export const ticketsHref = (project?: string | null): string =>
  project === undefined || project === null
    ? TICKETS_HREF
    : projectHref(project, "tickets");

/**
 * Where a ticket's "needs human" goes: its project's Inbox, or the fleet's for a ticket
 * with no project, showing that ticket's requests, each with its Answer button.
 */
export const inboxHref = (project: string | null, ticket: number): string =>
  project === null
    ? `${INBOX_HREF}?ticket=${ticket}`
    : `${projectHref(project, "inbox")}?ticket=${ticket}`;

export const pulseHref = (pulseId: string): string =>
  `${PULSES_HREF}/${encodeURIComponent(pulseId)}`;

const openRef = (tab: EditorTab): string =>
  tab.kind === "ticket"
    ? `ticket:${tab.num}`
    : `${tab.kind}:${encodeURIComponent(tab.id)}`;

/**
 * One project's IDE on `view`, with `open` its focused tab (none: the view's own tab). `filters` are
 * the history view's: on another view they are left out, as are unset ones.
 */
export function projectHref(
  project: string,
  view: IdeView = "overview",
  open?: EditorTab,
  filters?: HistoryFilters,
): string {
  const params = [
    ...(view === "history" && filters !== undefined
      ? filterParams(filters)
      : []),
    ...(open === undefined ? [] : [`open=${openRef(open)}`]),
  ];
  const query = params.length === 0 ? "" : `?${params.join("&")}`;
  return `#/p/${encodeURIComponent(project)}/${view}${query}`;
}

/** A navigation (hashchange), or the address rewritten in place (lib/history's replaceHash). */
const subscribe = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  const unsubscribe = subscribeHistory(onChange);
  return () => {
    window.removeEventListener("hashchange", onChange);
    unsubscribe();
  };
};

/** The address's hash, live. */
export function useHash(): string {
  return useSyncExternalStore(subscribe, () => window.location.hash);
}

export function useRoute(): Route {
  return parseRoute(useHash());
}

/**
 * Rewrites an alias in the address bar as its canonical address, in place: no history entry is
 * added and no `hashchange` fires (the screen already parsed the alias as the screen it names), so
 * back returns to wherever the alias was followed from. The trail learns the canonical address, so
 * a later back link names it (lib/history's replaceHash).
 */
export function useCanonicalAddress(): void {
  const hash = useHash();
  useLayoutEffect(() => {
    const canonical = resolveAlias(hash);
    if (canonical !== null) replaceHash(canonical);
  }, [hash]);
}
