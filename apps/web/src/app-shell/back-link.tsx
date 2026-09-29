import type { ProjectView } from "@bayon/proto";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore, type MouseEvent } from "react";
import { routeLabel } from "@/app-shell/nav-model";
import { TextLink } from "@/components/text-link";
import { previousHash, startTrail, subscribeHistory } from "@/lib/history";
import { projectsQuery } from "@/projects/projects-api";
import { FLEET_HREF, parseRoute, projectHref } from "@/routing";

// Back links that go back: to the screen the operator came from, not a hard-coded
// parent, as lib/history.ts's trail knows it. An entry reached from outside the app (a pasted link,
// a reload, a notification) has no known predecessor, and the link offers the screen's parent.

/** Keeps the trail while the shell is up; installed once, by the shell. */
export function useHistoryTrail(): void {
  useEffect(() => startTrail(), []);
}

/** The address of the in-app entry before this one, or null when it is not known to be ours. */
export function usePreviousHash(): string | null {
  return useSyncExternalStore(subscribeHistory, previousHash);
}

const modified = (event: MouseEvent): boolean =>
  event.button !== 0 ||
  event.metaKey ||
  event.ctrlKey ||
  event.shiftKey ||
  event.altKey;

/**
 * "← <where you came from>": a plain click goes back in history, so the stack does not grow and the
 * screen comes back as it was left; its href is that screen's address, for a middle-click. With no
 * in-app predecessor it is "← <parent>", a plain link.
 */
export function BackLink({ parent }: { readonly parent: string }) {
  const came = usePreviousHash();
  const href = came === null ? parent : came === "" ? FLEET_HREF : came;
  return (
    <TextLink
      href={href}
      className="w-fit text-sm"
      onClick={(event) => {
        if (came === null || modified(event)) return;
        event.preventDefault();
        window.history.back();
      }}
    >
      {`← ${routeLabel(parseRoute(href))}`}
    </TextLink>
  );
}

/** An agent's home: its tab in its project's Agents view, or the Fleet for one with no project. */
export function agentHome(
  projects: readonly ProjectView[],
  agentName: string,
): string {
  for (const project of projects) {
    const agent = project.agents.find((a) => a.name === agentName);
    if (agent !== undefined)
      return projectHref(project.id, "agents", { kind: "agent", id: agent.id });
  }
  return FLEET_HREF;
}

/** A back link whose parent is an agent's home (the mission editor's). */
export function AgentBackLink({ agent }: { readonly agent: string }) {
  const projects = useQuery(projectsQuery);
  return <BackLink parent={agentHome(projects.data?.projects ?? [], agent)} />;
}
