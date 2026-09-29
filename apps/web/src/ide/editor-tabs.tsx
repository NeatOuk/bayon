import type { ProjectView } from "@bayon/proto";
import { useQuery } from "@tanstack/react-query";
import { XIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { ticketQuery } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { VIEW_TAB, focusAfterClose, shortId, tabKey } from "@/ide/open-tabs";
import { AgentTab } from "@/ide/agent-tab";
import { AgentsView } from "@/ide/agents-view";
import { NO_FILTERS, type HistoryFilters } from "@/ide/history-filters";
import { HistoryView } from "@/ide/history-view";
import { OrchestratorView } from "@/ide/orchestrator-view";
import { OverviewView } from "@/ide/overview";
import { SettingsView } from "@/ide/settings-view";
import { VIEW_LABELS } from "@/ide/views";
import { ReviewQueueScreen } from "@/gates/review-queue-screen";
import { InboxScreen } from "@/inbox/inbox-screen";
import { JiraStrip } from "@/jira/jira-strip";
import { PulseScreen } from "@/pulses/pulse-screen";
import {
  TICKETS_HREF,
  projectHref,
  useRoute,
  type EditorTab,
  type IdeView,
  type RecordLinks,
} from "@/routing";
import { SessionScreen } from "@/session/session-screen";
import { SpendScreen } from "@/spend/spend-screen";
import { TicketBoard, type BoardLinks } from "@/tickets/ticket-board";
import { TicketScreen } from "@/tickets/ticket-screen";

/** The board inside the IDE: a card opens a ticket tab; the picker moves to another project's IDE. */
const boardLinks = (project: string): BoardLinks => ({
  ticket: (num) => projectHref(project, "tickets", { kind: "ticket", num }),
  project: (next) =>
    next === null ? TICKETS_HREF : projectHref(next, "tickets"),
});

/** Inside the IDE a ticket or session link opens its tab beside `view`. */
const recordLinks = (project: string, view: IdeView): RecordLinks => ({
  ticket: (num) => projectHref(project, view, { kind: "ticket", num }),
  session: (id) => projectHref(project, view, { kind: "session", id }),
});

/** Marks a tab's trigger with its value, so focus can find it after a close. */
const TAB_VALUE = "data-tab-value";

/**
 * The IDE's editor area: the view's own tab, always first and never closed, then the
 * opened tickets, sessions, agents and pulses, each with a close button. Picking a tab is navigating to it,
 * so the URL always names what is on screen. Closing one takes its close button with it, so focus
 * moves to the tab that is active after the close, never down to the page.
 */
export function EditorTabs({
  project,
  view,
  open,
  filters,
  tabs,
  onClose,
}: {
  readonly project: ProjectView;
  readonly view: IdeView;
  readonly open: EditorTab | undefined;
  /** The history view's filters: picking a tab keeps them in the URL. */
  readonly filters: HistoryFilters | undefined;
  readonly tabs: readonly EditorTab[];
  readonly onClose: (tab: EditorTab) => void;
}) {
  const keys = tabs.map(tabKey);
  const active =
    open !== undefined && keys.includes(tabKey(open)) ? tabKey(open) : VIEW_TAB;
  const list = useRef<HTMLDivElement>(null);
  const focusNext = useRef<string | null>(null);
  // After the render a close causes, once the trigger to focus is there (it always is: the tab
  // left of the closed one, or the view's, or the active one, none of which the close removes).
  useEffect(() => {
    const target = focusNext.current;
    if (target === null) return;
    const trigger = [
      ...(list.current?.querySelectorAll<HTMLElement>(`[${TAB_VALUE}]`) ?? []),
    ].find((el) => el.getAttribute(TAB_VALUE) === target);
    if (trigger === undefined) return;
    focusNext.current = null;
    trigger.focus();
  });
  const close = (tab: EditorTab) => {
    // The active tab closing hands over to its left neighbour (or the view); any other leaves the
    // active one active.
    const neighbour = focusAfterClose(tabs, tab);
    focusNext.current =
      tabKey(tab) !== active
        ? active
        : neighbour === undefined
          ? VIEW_TAB
          : tabKey(neighbour);
    onClose(tab);
  };
  return (
    <Tabs
      value={active}
      onValueChange={(value, details) => {
        if (details.reason !== "none") return;
        window.location.hash = projectHref(
          project.id,
          view,
          tabs.find((tab) => tabKey(tab) === value),
          filters,
        );
      }}
      className="min-h-0 flex-1 gap-0"
    >
      <TabsList
        ref={list}
        variant="line"
        aria-label="open editors"
        className="w-full shrink-0 justify-start overflow-x-auto overflow-y-hidden rounded-none border-b px-2"
      >
        <TabsTrigger
          value={VIEW_TAB}
          {...{ [TAB_VALUE]: VIEW_TAB }}
          className="flex-none"
        >
          {VIEW_LABELS[view]}
        </TabsTrigger>
        {tabs.map((tab) => (
          <OpenTab
            key={tabKey(tab)}
            tab={tab}
            project={project}
            onClose={() => close(tab)}
          />
        ))}
      </TabsList>
      {/* The view stays mounted (hidden and inert) while another tab is focused, so what it holds —
          an unsaved mission draft — survives a look at a ticket. Opened tabs mount when focused. */}
      <TabsContent
        value={VIEW_TAB}
        keepMounted
        className="flex min-h-0 flex-col overflow-auto"
      >
        <ViewContent
          project={project}
          view={view}
          filters={filters}
          visible={active === VIEW_TAB}
        />
      </TabsContent>
      {tabs.map((tab) => (
        <TabsContent
          key={tabKey(tab)}
          value={tabKey(tab)}
          className="flex min-h-0 flex-col overflow-auto"
        >
          <TabContent
            project={project}
            view={view}
            filters={filters}
            tab={tab}
          />
        </TabsContent>
      ))}
    </Tabs>
  );
}

/** The view's own tab. `visible` is it being the focused tab: the History view polls only then. */
function ViewContent({
  project,
  view,
  filters,
  visible,
}: {
  readonly project: ProjectView;
  readonly view: IdeView;
  readonly filters: HistoryFilters | undefined;
  readonly visible: boolean;
}) {
  switch (view) {
    case "overview":
      return <OverviewView project={project} view={view} />;
    case "orchestrator":
      return <OrchestratorView project={project} view={view} />;
    case "agents":
      return <AgentsView project={project} view={view} />;
    case "tickets":
      return (
        <TicketBoard
          project={project.id}
          links={boardLinks(project.id)}
          banner={<JiraStrip project={project} />}
        />
      );
    case "reviews":
      return (
        <ReviewQueueScreen
          project={project.id}
          links={recordLinks(project.id, view)}
        />
      );
    case "inbox":
      return (
        <ProjectInbox
          project={project.id}
          links={recordLinks(project.id, view)}
        />
      );
    case "spend":
      return (
        <SpendScreen
          project={project.id}
          links={recordLinks(project.id, view)}
        />
      );
    case "settings":
      return <SettingsView project={project} />;
    case "history":
      return (
        <HistoryView
          project={project}
          filters={filters ?? NO_FILTERS}
          visible={visible}
        />
      );
  }
}

/** The project's Inbox, one ticket's requests when the URL names it (`?ticket=<num>`). */
function ProjectInbox({
  project,
  links,
}: {
  readonly project: string;
  readonly links: RecordLinks;
}) {
  const route = useRoute();
  const ticket = route.name === "project" ? route.ticket : undefined;
  return <InboxScreen project={project} links={links} ticket={ticket} />;
}

function TabContent({
  project,
  view,
  filters,
  tab,
}: {
  readonly project: ProjectView;
  readonly view: IdeView;
  readonly filters: HistoryFilters | undefined;
  readonly tab: EditorTab;
}) {
  switch (tab.kind) {
    case "ticket":
      return <TicketScreen num={tab.num} backHref={null} />;
    case "session":
      return <SessionScreen sessionId={tab.id} backHref={null} />;
    case "agent":
      return (
        <AgentTab project={project} view={view} id={tab.id} filters={filters} />
      );
    case "pulse":
      return (
        <PulseScreen
          pulseId={tab.id}
          backHref={null}
          sessionLink={(id) =>
            projectHref(project.id, view, { kind: "session", id }, filters)
          }
        />
      );
  }
}

function OpenTab({
  tab,
  project,
  onClose,
}: {
  readonly tab: EditorTab;
  readonly project: ProjectView;
  readonly onClose: () => void;
}) {
  switch (tab.kind) {
    case "ticket":
      return <TicketTab num={tab.num} onClose={onClose} />;
    case "session":
    case "pulse":
      return (
        <TabHandle
          value={tabKey(tab)}
          label={`${tab.kind} ${shortId(tab.id)}`}
          title={tab.id}
          onClose={onClose}
        />
      );
    case "agent":
      return (
        <TabHandle
          value={tabKey(tab)}
          label={
            project.agents.find((agent) => agent.id === tab.id)?.name ?? tab.id
          }
          title={tab.id}
          onClose={onClose}
        />
      );
  }
}

/** A ticket's tab reads its key from the same cached query its screen loads, `#num` until then. */
function TicketTab({
  num,
  onClose,
}: {
  readonly num: number;
  readonly onClose: () => void;
}) {
  const detail = useQuery(ticketQuery(num));
  return (
    <TabHandle
      value={tabKey({ kind: "ticket", num })}
      label={detail.data?.ticket.key ?? `#${num}`}
      title={detail.data?.ticket.title}
      onClose={onClose}
    />
  );
}

function TabHandle({
  value,
  label,
  title,
  onClose,
}: {
  readonly value: string;
  readonly label: string;
  readonly title: string | undefined;
  readonly onClose: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center">
      <TabsTrigger
        value={value}
        title={title}
        {...{ [TAB_VALUE]: value }}
        className="flex-none pr-1"
      >
        {label}
      </TabsTrigger>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`close ${label}`}
        onClick={onClose}
        className="text-muted-foreground hover:text-foreground"
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  );
}
