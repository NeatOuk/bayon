import { useQuery } from "@tanstack/react-query";
import { projectsQuery } from "@/projects/projects-api";
import { runnersQuery } from "@/runners/runners-api";
import { roleBindingsQuery } from "@/settings/roles-api";
import { settingsQuery } from "@/settings/settings-api";
import { readiness, type NotReady } from "@/fleet/readiness";

/**
 * The install's not-ready rows (readiness.ts) from the four reads it needs. Empty until all four
 * have answered, and when one cannot be read: an unreadable screen says so on its own page, and a
 * row guessed from half the facts would name the wrong action.
 */
export function useReadiness(): readonly NotReady[] {
  const projects = useQuery(projectsQuery);
  const runners = useQuery(runnersQuery);
  const bindings = useQuery(roleBindingsQuery);
  const settings = useQuery(settingsQuery);
  if (
    projects.data === undefined ||
    runners.data === undefined ||
    bindings.data === undefined ||
    settings.data === undefined
  )
    return [];
  return readiness(
    projects.data.projects,
    runners.data.runners,
    bindings.data.items,
    // Unset is admission's default, on (§4 M4 settings): only an explicit off lifts the rows.
    { requireCertified: settings.data.require_certified !== false },
  );
}
