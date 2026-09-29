import { useQuery } from "@tanstack/react-query";
import { ArrowUpRightIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { jiraIssueHref } from "@/jira/jira-links";
import { projectsQuery } from "@/projects/projects-api";

// A mirrored ticket's Jira key as a chip linking its issue. The href is built only from a site that
// passes core's `isJiraSite` and a key shaped like an issue key (`jiraIssueHref`); anything else is
// plain text, so neither an issue's author nor a stored source can make the chip a link elsewhere.

/** What the chip reads from a ticket: a card's summary and the full view both carry these. */
export interface MirroredTicket {
  readonly origin: string;
  readonly origin_ref: string | null;
}

/** The mirrored issue's key, or null when the ticket was not mirrored from Jira. */
export const jiraKeyOf = (ticket: MirroredTicket): string | null =>
  ticket.origin === "jira" ? ticket.origin_ref : null;

/**
 * Each project's Jira site by its workspace id, from `GET /projects` (cached; the IDE reads it
 * anyway). A project without a source, or projects not loaded, give null.
 */
export function useJiraSites(): (workspaceId: string | null) => string | null {
  const projects = useQuery(projectsQuery);
  const sites = new Map(
    (projects.data?.projects ?? []).flatMap((project) =>
      project.jira === null ? [] : [[project.id, project.jira.url] as const],
    ),
  );
  return (workspaceId) =>
    workspaceId === null ? null : (sites.get(workspaceId) ?? null);
}

export function JiraKeyChip({
  ticket,
  site,
  className,
}: {
  readonly ticket: MirroredTicket;
  readonly site: string | null;
  readonly className?: string;
}) {
  const key = jiraKeyOf(ticket);
  if (key === null) return null;
  const href = jiraIssueHref(site, key);
  if (href === null)
    return (
      <Badge variant="outline" className={className} title="Mirrored from Jira">
        {key}
      </Badge>
    );
  return (
    <Badge
      variant="outline"
      className={className}
      render={
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          aria-label={`${key} in Jira (opens in a new tab)`}
        />
      }
    >
      {key}
      <ArrowUpRightIcon aria-hidden data-icon="inline-end" />
    </Badge>
  );
}
