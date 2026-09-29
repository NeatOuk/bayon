import type { ProjectView } from "@bayon/proto";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { NavGroup, NavItem } from "@/app-shell/nav-list";
import { PROJECT_GROUPS, VIEW_ICONS } from "@/app-shell/nav-model";
import { FOCUS_RING } from "@/components/text-link";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  inboxCountLabel,
  inboxCountTitle,
  type InboxCount,
} from "@/inbox/inbox-count";
import type { HistoryFilters } from "@/ide/history-filters";
import { VIEW_LABELS } from "@/ide/views";
import { cn } from "@/lib/utils";
import { projectHref, type EditorTab, type IdeView } from "@/routing";
import { agentLine } from "@/lib/format";

/**
 * A project's explorer, the app sidebar's project scope since an earlier change: its views in
 * groups as links, the current one marked, and its agents under Agents; an agent opens as a tab.
 * Links, so the keyboard, middle-click and back/forward all work as anywhere else. `onNavigate`
 * lets the narrow sheet close after a pick.
 */
export function Explorer({
  project,
  view,
  open,
  filters,
  inbox,
  onNavigate,
}: {
  readonly project: ProjectView;
  readonly view: IdeView;
  readonly open: EditorTab | undefined;
  /** The history view's filters: an agent opened beside it keeps them. */
  readonly filters: HistoryFilters | undefined;
  /** What waits on the operator in this project. */
  readonly inbox: InboxCount;
  readonly onNavigate?: (() => void) | undefined;
}) {
  const [agentsOpen, setAgentsOpen] = useState(true);
  return (
    <nav aria-label="explorer" className="flex flex-col gap-3">
      {PROJECT_GROUPS.map((group) => (
        <NavGroup key={group.label} label={group.label}>
          {group.items.map((entry) => {
            const link = (
              <NavItem
                href={projectHref(project.id, entry)}
                current={entry === view && open?.kind !== "agent"}
                icon={VIEW_ICONS[entry]}
                label={VIEW_LABELS[entry]}
                end={<ViewCount view={entry} project={project} inbox={inbox} />}
                onNavigate={onNavigate}
              />
            );
            if (entry !== "agents")
              return (
                <li key={entry} className="flex">
                  {link}
                </li>
              );
            return (
              <li key={entry}>
                <Collapsible open={agentsOpen} onOpenChange={setAgentsOpen}>
                  <div className="flex items-center gap-0.5">
                    {link}
                    <CollapsibleTrigger
                      aria-label="the project's agents"
                      className={cn(
                        FOCUS_RING,
                        "group rounded-md p-1.5 text-muted-foreground hover:bg-accent focus-visible:-outline-offset-2",
                      )}
                    >
                      <ChevronRightIcon className="size-4 transition-transform group-data-panel-open:rotate-90" />
                    </CollapsibleTrigger>
                  </div>
                  <CollapsibleContent>
                    <AgentList
                      project={project}
                      view={view}
                      open={open}
                      filters={filters}
                      onNavigate={onNavigate}
                    />
                  </CollapsibleContent>
                </Collapsible>
              </li>
            );
          })}
        </NavGroup>
      ))}
    </nav>
  );
}

/** A view's count at the row's end: the agents, and what waits in the inbox. */
function ViewCount({
  view,
  project,
  inbox,
}: {
  readonly view: IdeView;
  readonly project: ProjectView;
  readonly inbox: InboxCount;
}) {
  if (view === "agents")
    return (
      <span
        aria-label={`${project.agents.length} agents`}
        className="text-xs text-muted-foreground tabular-nums"
      >
        {project.agents.length}
      </span>
    );
  if (view === "inbox" && inbox.open > 0)
    return (
      <Badge aria-label={inboxCountTitle(inbox)}>
        {inboxCountLabel(inbox)}
      </Badge>
    );
  return null;
}

function AgentList({
  project,
  view,
  open,
  filters,
  onNavigate,
}: {
  readonly project: ProjectView;
  readonly view: IdeView;
  readonly open: EditorTab | undefined;
  readonly filters: HistoryFilters | undefined;
  readonly onNavigate: (() => void) | undefined;
}) {
  if (project.agents.length === 0)
    return (
      <p className="py-1 pl-8 text-xs text-muted-foreground">No agents yet</p>
    );
  return (
    <ul aria-label="agents" className="flex flex-col gap-0.5 py-0.5 pl-6">
      {project.agents.map((agent) => (
        <li key={agent.id} className="flex">
          <NavItem
            href={projectHref(
              project.id,
              view,
              { kind: "agent", id: agent.id },
              filters,
            )}
            current={open?.kind === "agent" && open.id === agent.id}
            className="h-auto py-1"
            label={
              <span
                className={cn(
                  "flex min-w-0 flex-col",
                  !agent.enabled && "text-muted-foreground",
                )}
              >
                <span className="truncate">{agent.name}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {`${agentLine(agent)}${agent.enabled ? "" : " · disabled"}`}
                </span>
              </span>
            }
            onNavigate={onNavigate}
          />
        </li>
      ))}
    </ul>
  );
}
