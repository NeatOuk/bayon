import type { ProjectView } from "@bayon/proto";
import { useQuery } from "@tanstack/react-query";
import { Loading } from "@/components/loading";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { StatusBadge } from "@/components/status-badge";
import { TextLink } from "@/components/text-link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { projectsQuery } from "@/projects/projects-api";
import { NEW_PROJECT_HREF, ticketsHref } from "@/routing";
import { Panel } from "@/tickets/panel";
import { agentLine } from "@/lib/format";

/** Projects (§12.3): each workspace with its repos, agents and a link to its tickets. */
export function ProjectsScreen() {
  const projects = useQuery(projectsQuery);
  return (
    <PageContainer>
      <PageHeader
        title="Projects"
        actions={
          <a href={NEW_PROJECT_HREF} className={buttonVariants({ size: "sm" })}>
            New project
          </a>
        }
      />
      {projects.isPending && (
        <Loading label="Loading the projects…" lines={3} />
      )}
      {projects.isError && (
        <QueryError
          title="The projects are unavailable"
          error={projects.error}
          onRetry={() => void projects.refetch()}
        />
      )}
      {projects.data !== undefined &&
        (projects.data.projects.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No projects yet</EmptyTitle>
              <EmptyDescription>
                New project sets one up from a repo url or a folder on this
                machine.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <a
                href={NEW_PROJECT_HREF}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Set up the first project
              </a>
            </EmptyContent>
          </Empty>
        ) : (
          <div className="grid gap-4 2xl:grid-cols-2">
            {projects.data.projects.map((project) => (
              <ProjectPanel key={project.id} project={project} />
            ))}
          </div>
        ))}
    </PageContainer>
  );
}

const kindOf = (project: ProjectView): string => {
  const subs = project.repos.filter((r) => r.submodule_path !== null).length;
  if (subs > 0) return `${subs} submodule${subs === 1 ? "" : "s"}`;
  return project.repos.length > 1
    ? `${project.repos.length} repos`
    : "one repo";
};

function ProjectPanel({ project }: { readonly project: ProjectView }) {
  return (
    <Panel label={`project ${project.name}`} title={project.name}>
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="outline">{kindOf(project)}</Badge>
        <TextLink href={ticketsHref(project.id)}>
          {`${project.open_tickets} open ticket${project.open_tickets === 1 ? "" : "s"}`}
        </TextLink>
      </p>
      <ul aria-label="repos" className="flex flex-col gap-1 text-sm">
        {project.repos.map((repo) => (
          <li key={repo.id} className="flex flex-wrap items-baseline gap-2">
            <span className="font-mono">{repo.submodule_path ?? repo.id}</span>
            <span className="font-mono text-xs text-muted-foreground">
              {`${repo.default_base_branch} · ${repo.origin_url ?? "no origin"}`}
            </span>
          </li>
        ))}
      </ul>
      {project.agents.length > 0 && (
        <ul aria-label="agents" className="flex flex-wrap gap-1">
          {project.agents.map((agent) => (
            <li key={agent.id} className="flex items-center gap-1">
              <Badge variant="outline">{agentLine(agent)}</Badge>
              {!agent.enabled && (
                <StatusBadge entity="enabled" state="disabled" />
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
