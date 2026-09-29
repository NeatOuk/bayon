import type { Fleet, FleetRow } from "@bayon/proto";
import { useFleet } from "@/fleet/use-fleet";

// One project's live sessions. The `fleet` topic stays one fleet-wide snapshot, as the
// header's pause switch reads it; the IDE keeps the rows whose project (the session's workspace,
// else its agent's) is this one. Same cache, same subscription shape, no second request.

/** The rows of `fleet` in `project`, in the fleet's order. */
export const projectSessions = (
  fleet: Fleet | undefined,
  project: string,
): readonly FleetRow[] =>
  fleet?.sessions.filter((row) => row.workspace_id === project) ?? [];

/** Live sessions by agent name (unique fleet-wide: a fleet row names its agent by it). */
export function sessionsByAgent(
  rows: readonly FleetRow[],
): ReadonlyMap<string, readonly FleetRow[]> {
  return rows.reduce(
    (byAgent, row) =>
      new Map(byAgent).set(row.agent, [...(byAgent.get(row.agent) ?? []), row]),
    new Map<string, readonly FleetRow[]>(),
  );
}

/** The project's live sessions by agent, live from the `fleet` topic; empty until the first read. */
export function useProjectFleet(project: string) {
  const fleet = useFleet();
  return {
    fleet,
    byAgent: sessionsByAgent(projectSessions(fleet.data, project)),
  };
}
