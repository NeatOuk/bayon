import type { TicketDetail } from "@bayon/proto";
import { useQueries } from "@tanstack/react-query";
import { sessionQuery } from "@/api/queries";
import { Loading } from "@/components/loading";
import { buttonVariants } from "@/components/ui/button";
import { missionHref } from "@/routing";
import { Panel } from "@/tickets/panel";
import { ticketSessionIds } from "@/tickets/ticket-model";

/**
 * §12.3 "add a law" from the ticket view: laws are written in reaction to what an agent did here, so
 * each agent behind the ticket's sessions gets a link to its mission, laws focused.
 */
export function AddALaw({ detail }: { readonly detail: TicketDetail }) {
  const ids = ticketSessionIds(detail);
  const sessions = useQueries({ queries: ids.map((id) => sessionQuery(id)) });
  const agents = [
    ...new Set(
      sessions.flatMap((session) =>
        session.data === undefined ? [] : [session.data.agent_name],
      ),
    ),
  ];
  const pending = sessions.some((session) => session.isPending);
  return (
    <Panel label="add a law" title="Add a law">
      {ids.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No agent has worked this ticket yet, so there is no mission to add a
          law to.
        </p>
      )}
      {pending && <Loading label="Finding the agents…" />}
      {!pending && ids.length > 0 && agents.length === 0 && (
        <p className="text-sm text-muted-foreground">
          The sessions on this ticket could not be read.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {agents.map((agent) => (
          <a
            key={agent}
            href={missionHref(agent, "laws")}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            {`add a law · ${agent}`}
          </a>
        ))}
      </div>
    </Panel>
  );
}
