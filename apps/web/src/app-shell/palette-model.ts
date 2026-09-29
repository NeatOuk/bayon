import type { ProjectView } from "@bayon/proto";
import { z } from "zod";
import { FLEET_ITEMS, PROJECT_GROUPS } from "@/app-shell/nav-model";
import { VIEW_LABELS } from "@/ide/views";
import {
  NEW_PROJECT_HREF,
  NOTIFICATIONS_HREF,
  PROJECTS_HREF,
  ROLES_HREF,
  projectHref,
} from "@/routing";

// What the command palette offers and how a query narrows it. Pure, so the filtering,
// the ticket references and the stored Recent list are tested without a browser.

export const PaletteItem = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** The address it opens: a hash path, never anything a click could run. */
  href: z.string().startsWith("#/"),
  /** Beside the label: where it lives ("bayon · builder"), or the group it came from in Recent. */
  hint: z.string().optional(),
});
export type PaletteItem = z.infer<typeof PaletteItem>;

/** A type, not an interface: base-ui's Group is an index-signature shape an interface cannot meet. */
export type PaletteGroup = {
  /** The group's heading. */
  readonly value: string;
  readonly items: readonly PaletteItem[];
};

export interface PaletteSources {
  /** Every project this install has (`GET /projects`, the switcher's query). */
  readonly projects: readonly ProjectView[];
  /** The project on show, whose views get a group of their own; null across the fleet. */
  readonly current: ProjectView | null;
  /** Where "open ticket N" goes from here: its screen, or a tab beside the IDE's view. */
  readonly ticketHref: (num: number) => string;
  /** The last picks, newest first. */
  readonly recent: readonly PaletteItem[];
}

const SCREENS: readonly PaletteItem[] = [
  ...FLEET_ITEMS.map((item) => ({
    id: `screen:${item.key}`,
    label: item.label,
    href: item.href,
  })),
  {
    id: "screen:notifications",
    label: "Settings · Notifications",
    href: NOTIFICATIONS_HREF,
  },
  { id: "screen:roles", label: "Settings · Roles", href: ROLES_HREF },
  { id: "screen:projects", label: "Projects", href: PROJECTS_HREF },
  { id: "screen:new-project", label: "New project", href: NEW_PROJECT_HREF },
];

/**
 * The ticket a query names: `#45`, `45`, or a key such as `FRM-45` (any prefix of the shape a key
 * prefix may take, any case — the prefix is a setting the GUI does not hold). Else null.
 */
export function ticketNumOf(query: string): number | null {
  const match = /^(?:#|[a-z][a-z0-9]{0,9}-)?([1-9][0-9]{0,14})$/i.exec(
    query.trim(),
  );
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** Every word of the query, in the item's words: its label, its hint, its group's heading. */
const matches = (
  item: PaletteItem,
  group: string,
  words: readonly string[],
) => {
  const haystack = `${item.label} ${item.hint ?? ""} ${group}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
};

const projectViews = (project: ProjectView): PaletteItem[] =>
  PROJECT_GROUPS.flatMap((group) => group.items).map((view) => ({
    id: `view:${project.id}:${view}`,
    label: VIEW_LABELS[view],
    hint: project.name,
    href: projectHref(project.id, view),
  }));

const projectItems = (projects: readonly ProjectView[]): PaletteItem[] =>
  projects.map((project) => ({
    id: `project:${project.id}`,
    label: project.name,
    hint: project.paused ? "paused" : `${project.open_tickets} open tickets`,
    href: projectHref(project.id),
  }));

const agentItems = (projects: readonly ProjectView[]): PaletteItem[] =>
  projects.flatMap((project) =>
    project.agents.map((agent) => ({
      id: `agent:${agent.id}`,
      label: agent.name,
      hint: `${project.name} · ${agent.kind}${agent.enabled ? "" : " · disabled"}`,
      href: projectHref(project.id, "agents", { kind: "agent", id: agent.id }),
    })),
  );

/**
 * The palette's groups for `query`: a ticket the query names first, then (with no query) the recent
 * picks, the screens, the current project's views, the projects and their agents — each narrowed to
 * the items holding every word of the query, empty groups left out.
 */
export function paletteGroups(
  query: string,
  sources: PaletteSources,
): readonly PaletteGroup[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const num = ticketNumOf(query);
  const candidates: readonly PaletteGroup[] = [
    ...(words.length === 0 ? [{ value: "Recent", items: sources.recent }] : []),
    { value: "Screens", items: SCREENS },
    ...(sources.current === null
      ? []
      : [
          { value: sources.current.name, items: projectViews(sources.current) },
        ]),
    { value: "Projects", items: projectItems(sources.projects) },
    { value: "Agents", items: agentItems(sources.projects) },
  ];
  const narrowed = candidates
    .map((group) => ({
      value: group.value,
      items: group.items.filter((item) => matches(item, group.value, words)),
    }))
    .filter((group) => group.items.length > 0);
  if (num === null) return narrowed;
  const ticket: PaletteGroup = {
    value: "Ticket",
    items: [
      {
        id: `ticket:${num}`,
        label: `Open ticket ${num}`,
        href: sources.ticketHref(num),
      },
    ],
  };
  return [ticket, ...narrowed];
}

/** How many picks Recent keeps. */
export const RECENT_LIMIT = 5;

/** localStorage's key for Recent: a per-viewer convenience, fine to lose. */
export const RECENT_KEY = "bayon.palette.recent";

/** Recent from what storage held: anything that is not a list of items is none. */
export function parseRecent(raw: string | null): readonly PaletteItem[] {
  if (raw === null) return [];
  try {
    const parsed = z.array(PaletteItem).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

/** Recent with `item` first, once, and at most RECENT_LIMIT long; its hint the group it came from. */
export function withRecent(
  recent: readonly PaletteItem[],
  item: PaletteItem,
  group: string,
): readonly PaletteItem[] {
  const picked: PaletteItem = {
    id: item.id,
    label: item.label,
    href: item.href,
    hint: group === "Recent" ? item.hint : (item.hint ?? group),
  };
  return [picked, ...recent.filter((r) => r.id !== item.id)].slice(
    0,
    RECENT_LIMIT,
  );
}

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

/** The shortcut as this platform writes it. */
export const SHORTCUT_LABEL = IS_MAC ? "⌘K" : "Ctrl K";
