import {
  ActivityIcon,
  ClipboardCheckIcon,
  HistoryIcon,
  InboxIcon,
  LayoutDashboardIcon,
  PlayIcon,
  ScrollTextIcon,
  ServerIcon,
  SettingsIcon,
  TicketIcon,
  UsersIcon,
  WalletIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react";
import { VIEW_LABELS } from "@/ide/views";
import {
  AUDIT_HREF,
  EXECUTORS_HREF,
  FLEET_HREF,
  INBOX_HREF,
  PULSES_HREF,
  REVIEWS_HREF,
  RUNNERS_HREF,
  SETTINGS_HREF,
  SPEND_HREF,
  TICKETS_HREF,
  type IdeView,
  type Route,
} from "@/routing";

// What the sidebar and the command palette list, as data: one place names each screen,
// so the two never disagree. The fleet's screens in three groups, a project's views in four.

export type FleetItemKey =
  | "fleet"
  | "tickets"
  | "reviews"
  | "inbox"
  | "pulses"
  | "spend"
  | "runners"
  | "executors"
  | "settings"
  | "audit";

export interface FleetItem {
  readonly key: FleetItemKey;
  readonly label: string;
  readonly href: string;
  readonly icon: LucideIcon;
}

export interface NavGroupOf<T> {
  readonly label: string;
  readonly items: readonly T[];
}

export const FLEET_GROUPS: readonly NavGroupOf<FleetItem>[] = [
  {
    label: "Work",
    items: [
      {
        key: "fleet",
        label: "Fleet",
        href: FLEET_HREF,
        icon: LayoutDashboardIcon,
      },
      {
        key: "tickets",
        label: "Tickets",
        href: TICKETS_HREF,
        icon: TicketIcon,
      },
      {
        key: "reviews",
        label: "Reviews",
        href: REVIEWS_HREF,
        icon: ClipboardCheckIcon,
      },
      { key: "inbox", label: "Inbox", href: INBOX_HREF, icon: InboxIcon },
    ],
  },
  {
    label: "Fleet",
    items: [
      { key: "pulses", label: "Pulses", href: PULSES_HREF, icon: ActivityIcon },
      { key: "spend", label: "Spend", href: SPEND_HREF, icon: WalletIcon },
      { key: "runners", label: "Runners", href: RUNNERS_HREF, icon: PlayIcon },
      {
        key: "executors",
        label: "Executors",
        href: EXECUTORS_HREF,
        icon: ServerIcon,
      },
    ],
  },
  {
    label: "Admin",
    items: [
      {
        key: "settings",
        label: "Settings",
        href: SETTINGS_HREF,
        icon: SettingsIcon,
      },
      { key: "audit", label: "Audit", href: AUDIT_HREF, icon: ScrollTextIcon },
    ],
  },
];

/** What the Projects group's own entries are marked by. */
export type ProjectsKey = "projects" | "newProject";

/**
 * The fleet item a route marks as current: a section owns its sub-pages (a ticket, a pulse, a
 * settings tab). Session and mission screens are records reached by links, and mark nothing; nor do
 * the Projects screens, which mark their own entries (`currentProjectsItem`).
 */
export function currentFleetItem(route: Route): FleetItemKey | null {
  switch (route.name) {
    case "fleet":
    case "tickets":
    case "reviews":
    case "inbox":
    case "pulses":
    case "spend":
    case "runners":
    case "executors":
    case "audit":
      return route.name;
    case "ticket":
      return "tickets";
    case "pulse":
      return "pulses";
    case "general":
    case "roles":
    case "notifications":
      return "settings";
    default:
      return null;
  }
}

export function currentProjectsItem(route: Route): ProjectsKey | null {
  return route.name === "projects" || route.name === "newProject"
    ? route.name
    : null;
}

/** A project's views in the explorer's groups; the Agents view carries the agents under it. */
export const PROJECT_GROUPS: readonly NavGroupOf<IdeView>[] = [
  { label: "Work", items: ["overview", "tickets", "reviews", "inbox"] },
  { label: "Team", items: ["orchestrator", "agents"] },
  { label: "Records", items: ["spend", "history"] },
  { label: "Admin", items: ["settings"] },
];

export const VIEW_ICONS: Readonly<Record<IdeView, LucideIcon>> = {
  overview: LayoutDashboardIcon,
  orchestrator: WorkflowIcon,
  agents: UsersIcon,
  tickets: TicketIcon,
  reviews: ClipboardCheckIcon,
  inbox: InboxIcon,
  spend: WalletIcon,
  history: HistoryIcon,
  settings: SettingsIcon,
};

/** The fleet items, flat, as the palette lists them. */
export const FLEET_ITEMS: readonly FleetItem[] = FLEET_GROUPS.flatMap(
  (group) => group.items,
);

/** A short name for where a route is, for a back link: "Tickets", "Ticket 45", "History". */
export function routeLabel(route: Route): string {
  const fleet = currentFleetItem(route);
  switch (route.name) {
    case "ticket":
      return `Ticket ${route.num}`;
    case "pulse":
      return "Pulse";
    case "session":
      return "Session";
    case "mission":
      return `Mission · ${route.agent}`;
    case "projects":
      return "Projects";
    case "newProject":
      return "New project";
    case "project":
      return VIEW_LABELS[route.view];
    case "notFound":
      return "Back";
    default:
      return FLEET_ITEMS.find((item) => item.key === fleet)?.label ?? "Fleet";
  }
}
