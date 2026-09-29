import { useQuery } from "@tanstack/react-query";
import { StatusBadge } from "@/components/status-badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { projectsQuery } from "@/projects/projects-api";
import { cn } from "@/lib/utils";
import { projectHref } from "@/routing";

const ALL_PROJECTS = "All projects";

/**
 * The top bar's project switcher: `GET /projects` by name, plus All projects. A project
 * opens its IDE on Overview; All projects is the Fleet and the fleet-wide screens.
 */
export function ProjectSwitcher({
  value,
  className,
}: {
  readonly value: string | null;
  readonly className?: string;
}) {
  const projects = useQuery(projectsQuery);
  const listed = (projects.data?.projects ?? []).map((p) => ({
    value: p.id as string | null,
    label: p.name,
  }));
  // A route to a project the list lacks (not loaded yet, or gone) still names it rather than lie.
  const items = [
    { value: null, label: ALL_PROJECTS },
    ...listed,
    ...(value !== null && !listed.some((item) => item.value === value)
      ? [{ value, label: value }]
      : []),
  ];
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next: string | null) => {
        window.location.hash = next === null ? "#/" : projectHref(next);
      }}
    >
      <SelectTrigger
        aria-label="Switch project"
        className={cn("w-44", className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value ?? ""} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Whether the open project is paused, read-only: its control is the Orchestrator view's. */
export function ProjectStateBadge({ project }: { readonly project: string }) {
  const projects = useQuery(projectsQuery);
  const found = projects.data?.projects.find((p) => p.id === project);
  if (found === undefined) return null;
  return (
    <StatusBadge
      entity="pause"
      state={found.paused ? "paused" : "running"}
      label={found.paused ? "Project paused" : "Project running"}
    />
  );
}
