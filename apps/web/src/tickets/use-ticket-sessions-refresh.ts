import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { ticketQuery } from "@/api/queries";
import { useFleet } from "@/fleet/use-fleet";

// A ticket's detail follows its sessions. The detail — next step, refusals, economics —
// is refetched on `tickets` and `gates` frames, but a session starting, taking a turn or going idle
// writes neither: the page read at "Staff" kept saying "no session holds it" while the fleet showed
// the session. The fleet is live, so a change in this ticket's rows there refetches the detail; REST
// stays the one source of what the page says.

/** This ticket's live sessions as the fleet shows them: what changes the detail. */
export const sessionsSignature = (
  sessions: readonly {
    readonly id: string;
    readonly ticket: number | null;
    readonly state: string;
    readonly turns: number;
  }[],
  num: number,
): string =>
  sessions
    .filter((s) => s.ticket === num)
    .map((s) => `${s.id}:${s.state}:${s.turns}`)
    .sort()
    .join(",");

/** Refetches ticket `num`'s detail whenever its sessions in the fleet change. */
export function useTicketSessionsRefresh(num: number): void {
  const fleet = useFleet();
  const queryClient = useQueryClient();
  const signature =
    fleet.data === undefined
      ? undefined
      : sessionsSignature(fleet.data.sessions, num);
  const seen = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (signature === undefined) return;
    const before = seen.current;
    seen.current = signature;
    // The fleet's first answer is the baseline: the detail was read at mount, so only a change
    // after it is news, and the page never reads the detail twice on opening.
    if (before === undefined || before === signature) return;
    void queryClient.invalidateQueries({
      queryKey: ticketQuery(num).queryKey,
      exact: true,
    });
  }, [signature, num, queryClient]);
}
