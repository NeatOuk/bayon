import type { IdeView } from "@/routing";

// What the IDE's views are called. Overview and Agents are `overview.tsx` and
// `agents-view.tsx`, Orchestrator `orchestrator-view.tsx`, History
// `history-view.tsx`; Reviews, Inbox and Spend are the fleet's screens with the project
//; Project settings is `settings-view.tsx`, where a project is configured —
// named apart from the operator's fleet-wide Settings.

export const VIEW_LABELS: Readonly<Record<IdeView, string>> = {
  overview: "Overview",
  orchestrator: "Orchestrator",
  agents: "Agents",
  tickets: "Tickets",
  reviews: "Reviews",
  inbox: "Inbox",
  spend: "Spend",
  history: "History",
  settings: "Project settings",
};
