import type { ProjectView } from "@bayon/proto";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  FolderIcon,
  PauseCircleIcon,
  PlusIcon,
} from "lucide-react";
import { NavGroup, NavItem } from "@/app-shell/nav-list";
import {
  FLEET_GROUPS,
  currentFleetItem,
  currentProjectsItem,
} from "@/app-shell/nav-model";
import { Loading } from "@/components/loading";
import { FOCUS_RING } from "@/components/text-link";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  type SheetHandle,
} from "@/components/ui/sheet";
import { Explorer } from "@/ide/explorer";
import { ProjectStateBadge } from "@/ide/project-switcher";
import {
  inboxCountLabel,
  inboxCountTitle,
  type InboxCount,
} from "@/inbox/inbox-count";
import { cn } from "@/lib/utils";
import { projectsQuery } from "@/projects/projects-api";
import {
  FLEET_HREF,
  NEW_PROJECT_HREF,
  PROJECTS_HREF,
  projectHref,
  type Route,
} from "@/routing";

/**
 * The app's one navigation, the same shape in both scopes: outside a project, the
 * fleet's screens in groups and the projects; inside one, that project's explorer with the way back
 * to all of them. `inbox` is the open count of the scope on show. `onNavigate` lets the narrow
 * sheet close after a pick.
 */
export function AppSidebar({
  route,
  inbox,
  onNavigate,
}: {
  readonly route: Route;
  readonly inbox: InboxCount;
  readonly onNavigate?: (() => void) | undefined;
}) {
  if (route.name === "project")
    return <ProjectScope route={route} inbox={inbox} onNavigate={onNavigate} />;
  return <FleetScope route={route} inbox={inbox} onNavigate={onNavigate} />;
}

function FleetScope({
  route,
  inbox,
  onNavigate,
}: {
  readonly route: Route;
  readonly inbox: InboxCount;
  readonly onNavigate: (() => void) | undefined;
}) {
  const current = currentFleetItem(route);
  return (
    <nav aria-label="main" className="flex flex-col gap-3">
      {FLEET_GROUPS.map((group) => (
        <NavGroup key={group.label} label={group.label}>
          {group.items.map((item) => (
            <li key={item.key} className="flex">
              <NavItem
                href={item.href}
                current={item.key === current}
                icon={item.icon}
                label={item.label}
                end={
                  item.key === "inbox" && inbox.open > 0 ? (
                    <Badge aria-label={inboxCountTitle(inbox)}>
                      {inboxCountLabel(inbox)}
                    </Badge>
                  ) : undefined
                }
                onNavigate={onNavigate}
              />
            </li>
          ))}
        </NavGroup>
      ))}
      <ProjectsGroup route={route} onNavigate={onNavigate} />
    </nav>
  );
}

/** The projects, each opening its IDE; the group's label is the Projects screen's link. */
function ProjectsGroup({
  route,
  onNavigate,
}: {
  readonly route: Route;
  readonly onNavigate: (() => void) | undefined;
}) {
  const projects = useQuery(projectsQuery);
  const current = currentProjectsItem(route);
  return (
    <NavGroup
      label="Projects"
      title={
        <a
          href={PROJECTS_HREF}
          aria-current={current === "projects" ? "page" : undefined}
          className={cn(
            FOCUS_RING,
            "rounded-xs hover:text-foreground hover:underline aria-[current=page]:text-foreground aria-[current=page]:underline",
          )}
          onClick={onNavigate}
        >
          Projects
        </a>
      }
    >
      {projects.isPending && (
        <li>
          <Loading label="Loading the projects…" className="px-2" />
        </li>
      )}
      {projects.isError && (
        <li className="px-2 text-xs text-muted-foreground">
          The projects are unavailable.
        </li>
      )}
      {projects.data?.projects.map((project) => (
        <li key={project.id} className="flex">
          <NavItem
            href={projectHref(project.id)}
            current={false}
            icon={FolderIcon}
            label={project.name}
            end={<ProjectFacts project={project} />}
            onNavigate={onNavigate}
          />
        </li>
      ))}
      <li className="flex">
        <NavItem
          href={NEW_PROJECT_HREF}
          current={current === "newProject"}
          icon={PlusIcon}
          label="New project"
          onNavigate={onNavigate}
        />
      </li>
    </NavGroup>
  );
}

/** A project's row end: paused, and how many tickets are open. */
function ProjectFacts({ project }: { readonly project: ProjectView }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {project.paused && (
        <PauseCircleIcon
          role="img"
          aria-label="paused"
          className="size-3.5 text-warning"
        />
      )}
      {project.open_tickets > 0 && (
        <span
          aria-label={`${project.open_tickets} open tickets`}
          className="text-xs text-muted-foreground tabular-nums"
        >
          {project.open_tickets}
        </span>
      )}
    </span>
  );
}

/** Inside a project: the way back to all of them, its name and state, then its explorer. */
function ProjectScope({
  route,
  inbox,
  onNavigate,
}: {
  readonly route: Extract<Route, { readonly name: "project" }>;
  readonly inbox: InboxCount;
  readonly onNavigate: (() => void) | undefined;
}) {
  const projects = useQuery(projectsQuery);
  const found = projects.data?.projects.find((p) => p.id === route.project);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <div className="flex">
          <NavItem
            href={FLEET_HREF}
            current={false}
            icon={ArrowLeftIcon}
            label="All projects"
            onNavigate={onNavigate}
          />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-2 pt-1">
          <span className="min-w-0 truncate font-head font-semibold">
            {found?.name ?? route.project}
          </span>
          <ProjectStateBadge project={route.project} />
        </div>
      </div>
      {found !== undefined ? (
        <Explorer
          project={found}
          view={route.view}
          open={route.open}
          filters={route.filters}
          inbox={inbox}
          onNavigate={onNavigate}
        />
      ) : projects.isPending ? (
        <Loading label="Loading the explorer…" className="px-2" />
      ) : (
        <p className="px-2 text-xs text-muted-foreground">
          This install has no such project.
        </p>
      )}
    </div>
  );
}

/**
 * Below `lg`: the same sidebar in a sheet from the left edge, opened by the top bar's menu button
 * (`handle`); a pick in it closes it.
 */
export function SidebarSheet({
  open,
  onOpenChange,
  handle,
  route,
  inbox,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly handle: SheetHandle;
  readonly route: Route;
  readonly inbox: InboxCount;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} handle={handle}>
      <SheetContent side="left">
        <SheetHeader>
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <p
            aria-hidden="true"
            className="font-head text-base font-semibold tracking-wide"
          >
            BAYON
          </p>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-2 pt-0">
          <AppSidebar
            route={route}
            inbox={inbox}
            onNavigate={() => onOpenChange(false)}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
