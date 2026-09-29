import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { useHistoryTrail } from "@/app-shell/back-link";
import { CommandPalette } from "@/app-shell/command-palette";
import { NotFound } from "@/app-shell/not-found";
import { AppSidebar, SidebarSheet } from "@/app-shell/sidebar";
import { SkipLink } from "@/app-shell/skip-link";
import { TopBar } from "@/app-shell/top-bar";
import { useNarrow } from "@/app-shell/use-narrow";
import { useOverlays } from "@/app-shell/use-overlays";
import { Toaster } from "@/components/ui/toast";
import { FeedProvider, type Feed } from "@/feed/feed";
import { FleetScreen } from "@/fleet/fleet-screen";
import { ReviewQueueScreen } from "@/gates/review-queue-screen";
import { ProjectIde } from "@/ide/project-ide";
import { InboxScreen } from "@/inbox/inbox-screen";
import {
  useInboxBadge,
  useInboxCount,
  useInboxCountFeed,
} from "@/inbox/use-inbox-count";
import { MissionScreen } from "@/missions/mission-screen";
import { PulseScreen } from "@/pulses/pulse-screen";
import { PulsesScreen } from "@/pulses/pulses-screen";
import { ExecutorsScreen } from "@/executors/executors-screen";
import { AuditScreen } from "@/audit/audit-screen";
import { NewProjectScreen } from "@/projects/new-project-screen";
import { ProjectsScreen } from "@/projects/projects-screen";
import { useCanonicalAddress, useHash, useRoute, type Route } from "@/routing";
import { RunnersScreen } from "@/runners/runners-screen";
import { SessionScreen } from "@/session/session-screen";
import { SettingsScreen } from "@/settings/settings-screen";
import { SpendScreen } from "@/spend/spend-screen";
import { TicketBoard } from "@/tickets/ticket-board";
import { TicketScreen } from "@/tickets/ticket-screen";
import { useTheme } from "@/theme/use-theme";

function Screen({ route }: { readonly route: Route }) {
  switch (route.name) {
    case "session":
      return (
        <SessionScreen key={route.sessionId} sessionId={route.sessionId} />
      );
    case "mission":
      return (
        <MissionScreen
          key={route.agent}
          agent={route.agent}
          section={route.section}
        />
      );
    case "tickets":
      return <TicketBoard project={null} />;
    case "ticket":
      return <TicketScreen key={route.num} num={route.num} />;
    case "inbox":
      return <InboxScreen ticket={route.ticket} />;
    case "pulses":
      return <PulsesScreen />;
    case "pulse":
      return <PulseScreen key={route.pulseId} pulseId={route.pulseId} />;
    case "spend":
      return <SpendScreen />;
    case "reviews":
      return <ReviewQueueScreen />;
    case "runners":
      return <RunnersScreen />;
    case "executors":
      return <ExecutorsScreen />;
    case "general":
      return <SettingsScreen tab="general" />;
    case "roles":
      return <SettingsScreen tab="roles" />;
    case "notifications":
      return <SettingsScreen tab="notifications" />;
    case "audit":
      return <AuditScreen />;
    case "projects":
      return <ProjectsScreen />;
    case "newProject":
      return <NewProjectScreen />;
    case "project":
      return (
        <ProjectIde
          key={route.project}
          project={route.project}
          view={route.view}
          open={route.open}
          filters={route.filters}
        />
      );
    case "fleet":
      return <FleetScreen />;
    case "notFound":
      return <NotFound hash={route.hash} />;
  }
}

/**
 * The shell: top bar, sidebar, and the screen the hash names — one project's IDE (`#/p/…`) or a
 * fleet-wide screen. `onLogout` only behind the production edge.
 */
export function App({
  feed,
  queryClient,
  onLogout = null,
}: {
  readonly feed: Feed;
  readonly queryClient: QueryClient;
  readonly onLogout?: (() => void) | null;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <FeedProvider feed={feed}>
        <Shell onLogout={onLogout} />
      </FeedProvider>
      <Toaster />
    </QueryClientProvider>
  );
}

/** Whether the screen on show is the Inbox itself, fleet-wide or a project's. */
const showsInbox = (route: Route): boolean =>
  route.name === "inbox" ||
  (route.name === "project" && route.view === "inbox");

/**
 * Inside the providers, so the sidebar's inbox count and the tab's title and icon can ride the very
 * query the Inbox screen uses. The count is scoped to what the operator is looking at:
 * one project's inside its IDE, the fleet's everywhere else — so a project route asks for one
 * project's requests and nothing else.
 *
 * The frame: a slim top bar over one sidebar and the screen. Below `lg` the sidebar is
 * a sheet the top bar opens, closed again by any navigation. ⌘K opens the command palette.
 */
function Shell({ onLogout }: { readonly onLogout: (() => void) | null }) {
  const hash = useHash();
  const route = useRoute();
  useCanonicalAddress();
  useHistoryTrail();
  const theme = useTheme();
  const narrow = useNarrow();
  const scope = route.name === "project" ? route.project : undefined;
  useInboxCountFeed(scope, showsInbox(route));
  const inbox = useInboxCount(scope);
  useInboxBadge(inbox, theme.dark);

  const { menu, palette } = useOverlays(hash);
  const main = useRef<HTMLElement>(null);

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <SkipLink target={main} />
      <TopBar
        route={route}
        narrow={narrow}
        menu={menu.handle}
        palette={palette.handle}
        theme={theme.choice}
        onTheme={theme.choose}
        onLogout={onLogout}
      />
      <div className="flex min-h-0 flex-1">
        {!narrow && (
          <aside className="flex w-60 shrink-0 flex-col overflow-y-auto border-r bg-card p-2 text-card-foreground">
            <AppSidebar route={route} inbox={inbox} />
          </aside>
        )}
        <main
          ref={main}
          tabIndex={-1}
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto outline-none"
        >
          <Screen route={route} />
        </main>
      </div>
      {narrow && <SidebarSheet {...menu} route={route} inbox={inbox} />}
      <CommandPalette {...palette} route={route} />
    </div>
  );
}
