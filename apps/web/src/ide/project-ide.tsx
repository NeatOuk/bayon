import type { ProjectView } from "@bayon/proto";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Loading } from "@/components/loading";
import { PageContainer } from "@/components/page-container";
import { QueryError } from "@/components/query-error";
import { TextLink } from "@/components/text-link";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { ActivityPanel } from "@/ide/activity-panel";
import { EditorTabs } from "@/ide/editor-tabs";
import type { HistoryFilters } from "@/ide/history-filters";
import { focusAfterClose, tabKey, withTab, withoutTab } from "@/ide/open-tabs";
import { projectsQuery } from "@/projects/projects-api";
import {
  PROJECTS_HREF,
  projectHref,
  type EditorTab,
  type IdeView,
} from "@/routing";

/**
 * One project's IDE, `#/p/<id>/<view>`: editor tabs and a live activity panel; its
 * explorer is the app sidebar's project scope. There is no chat input anywhere: every
 * action is a link, a tab or a button. The app keys it by project, so another project starts with
 * its own tabs.
 */
export function ProjectIde({
  project,
  view,
  open,
  filters,
}: {
  readonly project: string;
  readonly view: IdeView;
  readonly open: EditorTab | undefined;
  /** The history view's filters: every link that keeps the view keeps them. */
  readonly filters?: HistoryFilters | undefined;
}) {
  const projects = useQuery(projectsQuery);
  if (projects.isPending)
    return (
      <PageContainer>
        <Loading label="Loading the project…" />
      </PageContainer>
    );
  if (projects.isError)
    return (
      <PageContainer>
        <QueryError
          title="The projects are unavailable"
          error={projects.error}
          onRetry={() => void projects.refetch()}
        />
      </PageContainer>
    );
  const found = projects.data.projects.find((p) => p.id === project);
  if (found === undefined)
    return (
      <PageContainer>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{`No project ${project}`}</EmptyTitle>
            <EmptyDescription>
              <TextLink inline href={PROJECTS_HREF}>
                Projects
              </TextLink>{" "}
              lists the ones this install has.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </PageContainer>
    );
  return (
    <Workspace project={found} view={view} open={open} filters={filters} />
  );
}

/**
 * Which tabs are open is this component's state; which one is focused is the URL's (`?open=`). A link
 * naming a tab the list lacks (the explorer, a board card, an activity row, a deep link) adds it
 * when `open` changes: React's adjust-state-while-rendering pattern, keyed on the tab so closing the
 * focused tab is not undone before the hash moves on.
 */
function Workspace({
  project,
  view,
  open,
  filters,
}: {
  readonly project: ProjectView;
  readonly view: IdeView;
  readonly open: EditorTab | undefined;
  readonly filters: HistoryFilters | undefined;
}) {
  const openKey = open === undefined ? null : tabKey(open);
  const [tabs, setTabs] = useState<readonly EditorTab[]>(
    open === undefined ? [] : [open],
  );
  const [seenKey, setSeenKey] = useState(openKey);
  if (openKey !== seenKey) {
    setSeenKey(openKey);
    if (open !== undefined) setTabs(withTab(tabs, open));
  }

  const close = (tab: EditorTab) => {
    setTabs(withoutTab(tabs, tab));
    if (tabKey(tab) === openKey)
      window.location.hash = projectHref(
        project.id,
        view,
        focusAfterClose(tabs, tab),
        filters,
      );
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <EditorTabs
        project={project}
        view={view}
        open={open}
        filters={filters}
        tabs={tabs}
        onClose={close}
      />
      <ActivityPanel project={project} view={view} filters={filters} />
    </div>
  );
}
