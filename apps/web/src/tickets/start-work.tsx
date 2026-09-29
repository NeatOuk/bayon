import type { TicketDetail } from "@bayon/proto";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Play } from "lucide-react";
import {
  TICKETS_KEY,
  staffTicket,
  ticketQuery,
  transitionTicket,
} from "@/api/queries";
import { useIdempotencyKey } from "@/api/use-idempotency-key";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ui/toast";
import { plainError } from "@/tickets/refusal-text";

// "Start work": the one step from a new ticket to a builder on it. It is the operator's
// own two doors in order, never a door of its own — from backlog, `POST /tickets/:num/transition`
// to prioritized (the `prioritize` law), then `POST /tickets/:num/staff` as a builder (staffing's
// rules, and its prioritized → staffed move) — so every law is still the server's to judge. A
// refusal from either shows in plain words; after a refused staffing the ticket stays prioritized,
// where the next step offers Start work again (and the orchestrator's unstaffed_ready arm sees it).

export function StartWorkButton({
  detail,
  label,
}: {
  readonly detail: TicketDetail;
  readonly label: string;
}) {
  const { ticket } = detail;
  const queryClient = useQueryClient();
  // One key per attempt, kept across a retry: a staffing that landed after its response
  // was lost must not queue a second spawn.
  const idempotency = useIdempotencyKey();
  const start = useMutation({
    mutationFn: async () => {
      if (ticket.status === "backlog")
        await transitionTicket(ticket.num, ticket.version, {
          to: "prioritized",
        });
      return staffTicket(ticket.num, "builder", idempotency.current());
    },
    onSuccess: () => {
      idempotency.settle();
      notify.success(`Starting work on ${ticket.key}`);
    },
    // Either way the ticket may have moved (prioritized, then refused a staffing): read it again.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: ticketQuery(ticket.num).queryKey,
        }),
        queryClient.invalidateQueries({ queryKey: TICKETS_KEY }),
      ]),
  });
  return (
    <>
      <Button
        size="sm"
        disabled={start.isPending}
        onClick={() => start.mutate()}
      >
        <Play aria-hidden="true" />
        {label}
      </Button>
      {start.error !== null && (
        <span role="alert" className="text-destructive">
          {plainError(start.error)}
        </span>
      )}
    </>
  );
}
