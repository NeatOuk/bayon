import { STAFFABLE_STATUSES, type TicketStatus } from "@bayon/core";
import type { TicketView, TransitionOption } from "@bayon/proto";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useId, useState } from "react";
import {
  TICKETS_KEY,
  patchTicket,
  staffTicket,
  ticketQuery,
} from "@/api/queries";
import { useIdempotencyKey } from "@/api/use-idempotency-key";
import { SectionTitle } from "@/components/page-header";
import { labelOf } from "@/components/status";
import { TextLink } from "@/components/text-link";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { notify } from "@/components/ui/toast";
import { useFleet } from "@/fleet/use-fleet";
import { sessionHref } from "@/routing";
import { Panel } from "@/tickets/panel";
import { notesFor, refusalText } from "@/tickets/ticket-model";
import { useTicketMove } from "@/tickets/use-ticket-move";

/** The moves that stop a ticket or set it aside: kept apart from the flow's, and confirmed. */
const STOP_MOVES: Readonly<Partial<Record<TicketStatus, string>>> = {
  blocked: "Block",
  parked: "Park",
  rejected: "Reject",
};

/** A move's button: "Move to QA harness", or a stop move's verb ("Park"). */
export const moveLabel = (to: TicketStatus): string =>
  STOP_MOVES[to] ?? `Move to ${labelOf("ticket", to)}`;

/**
 * The moves the laws list for the operator (`transitions`, from core allowedTransitions): an allowed
 * one is a button named for where it goes, the rule under it; a refused one is disabled beside the
 * rule that refuses it. The moves that stop the ticket (block, park, reject) stand apart and ask
 * first. The server decides again on submit, so a 422 shows its rule too; a 409
 * refetches the ticket.
 */
export function TicketActions({
  ticket,
  transitions,
  suggested = null,
}: {
  readonly ticket: TicketView;
  readonly transitions: readonly TransitionOption[];
  /** The move the next step names: the one primary button; the others are secondary. */
  readonly suggested?: TicketStatus | null;
}) {
  const move = useTicketMove(ticket);
  const onward = transitions.filter((o) => STOP_MOVES[o.to] === undefined);
  const stops = transitions.filter((o) => STOP_MOVES[o.to] !== undefined);
  return (
    <Panel label="actions" title="Actions">
      {transitions.length === 0 ? (
        <p className="text-sm text-muted-foreground">{`No move leaves ${labelOf("ticket", ticket.status)}.`}</p>
      ) : (
        <>
          {onward.length > 0 && (
            <ul aria-label="moves" className="flex flex-col gap-3">
              {onward.map((option) => (
                <MoveRow
                  key={option.to}
                  ticket={ticket}
                  option={option}
                  primary={option.to === suggested}
                  pending={move.pending}
                  onMove={() => move.choose(option)}
                />
              ))}
            </ul>
          )}
          {stops.length > 0 && (
            <div className="flex flex-col gap-2 border-t pt-3">
              <SectionTitle as="h3" className="text-xs text-muted-foreground">
                Stop or set aside
              </SectionTitle>
              <ul aria-label="stop moves" className="flex flex-col gap-3">
                {stops.map((option) => (
                  <StopRow
                    key={option.to}
                    ticket={ticket}
                    option={option}
                    pending={move.pending}
                    onMove={() => move.choose(option)}
                  />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <div className="flex flex-wrap items-start gap-2 border-t pt-3">
        <Button
          size="sm"
          variant="outline"
          disabled={move.pending}
          onClick={() => move.flag(!ticket.needs_human)}
        >
          {ticket.needs_human ? "Clear needs human" : "Flag needs human"}
        </Button>
        {(STAFFABLE_STATUSES as readonly TicketStatus[]).includes(
          ticket.status,
        ) && <StaffBuilderButton ticket={ticket} />}
      </div>
      {move.ui}
    </Panel>
  );
}

/** One onward move: the button, and under it the rule that allows it or the refusal. */
function MoveRow({
  ticket,
  option,
  primary,
  pending,
  onMove,
}: {
  readonly ticket: TicketView;
  readonly option: TransitionOption;
  readonly primary: boolean;
  readonly pending: boolean;
  readonly onMove: () => void;
}) {
  const noteId = useId();
  return (
    <li className="flex flex-col gap-1">
      <Button
        className="w-full justify-start"
        variant={
          !option.allowed ? "outline" : primary ? "default" : "secondary"
        }
        disabled={!option.allowed || pending}
        aria-describedby={noteId}
        title={option.rule}
        onClick={onMove}
      >
        <ArrowRight aria-hidden="true" />
        {moveLabel(option.to)}
      </Button>
      <OptionNote id={noteId} option={option} />
      {wantsPlanPath(option) && <PlanPathField ticket={ticket} />}
    </li>
  );
}

/**
 * A stop move (block, park, reject). One that needs notes asks for them first — its notes dialog is
 * the confirmation; one that needs none is confirmed here, since it takes the ticket out of the flow.
 */
function StopRow({
  ticket,
  option,
  pending,
  onMove,
}: {
  readonly ticket: TicketView;
  readonly option: TransitionOption;
  readonly pending: boolean;
  readonly onMove: () => void;
}) {
  const noteId = useId();
  const [asking, setAsking] = useState(false);
  const verb = moveLabel(option.to);
  const needsNotes = notesFor(option).length > 0;
  return (
    <li className="flex flex-col gap-1">
      <Button
        className="w-full justify-start"
        variant={option.to === "rejected" ? "destructive" : "outline"}
        disabled={!option.allowed || pending}
        aria-describedby={noteId}
        title={option.rule}
        onClick={() => (needsNotes ? onMove() : setAsking(true))}
      >
        {verb}
      </Button>
      <OptionNote id={noteId} option={option} />
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{`${verb} ${ticket.key}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {`It moves to ${labelOf("ticket", option.to)} (${option.rule}) and leaves the flow: nothing is staffed on it${option.to === "rejected" ? ", and no move leaves Rejected" : " until it is moved back"}.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant={option.to === "rejected" ? "destructive" : "default"}
              disabled={pending}
              onClick={() => {
                setAsking(false);
                onMove();
              }}
            >
              {verb}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

/**
 * Staffs a builder (`POST /tickets/:num/staff`, role fixed to "builder"): a separate action from
 * any status move. Shown only on a staffable status, but a status alone does not say whether a live
 * session already holds the ticket — `admit()`'s own rule (`packages/db/src/repos/staffing.ts`) is
 * "any live session with this ticket_id", which `Fleet.sessions` already answers for free (built
 * from `v_fleet`, whose own WHERE clause excludes exactly the states admit() treats as ended). So a
 * held ticket disables the button instead of letting the click round-trip to a raw server refusal.
 */
function StaffBuilderButton({ ticket }: { readonly ticket: TicketView }) {
  const queryClient = useQueryClient();
  const fleet = useFleet();
  const heldBy = fleet.data?.sessions.find((s) => s.ticket === ticket.num);
  // One key per staffing attempt, held across a retry of it: a request that failed after the server
  // had already queued the spawn must not queue a second one. Settled on success, so a
  // later, deliberate staffing of this ticket is a new operation with a key of its own.
  const idempotency = useIdempotencyKey();
  const staff = useMutation({
    mutationFn: () => staffTicket(ticket.num, "builder", idempotency.current()),
    onSuccess: () => {
      idempotency.settle();
      notify.success(`Staffing a builder for ${ticket.key}`);
      return Promise.all([
        queryClient.invalidateQueries({
          queryKey: ticketQuery(ticket.num).queryKey,
        }),
        queryClient.invalidateQueries({ queryKey: TICKETS_KEY }),
      ]);
    },
  });
  return (
    <div className="flex flex-col gap-1">
      <Button
        size="sm"
        variant="outline"
        disabled={staff.isPending || heldBy !== undefined}
        onClick={() => staff.mutate()}
      >
        Staff builder
      </Button>
      {heldBy !== undefined && (
        <span className="text-xs text-muted-foreground">
          {`Held by ${heldBy.agent} (${labelOf("session", heldBy.state)}) — `}
          <TextLink href={sessionHref(heldBy.id)} inline>
            session
          </TextLink>
        </span>
      )}
      {staff.error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {staff.error.message}
        </p>
      )}
    </div>
  );
}

function OptionNote({
  id,
  option,
}: {
  readonly id: string;
  readonly option: TransitionOption;
}) {
  if (!option.allowed)
    return (
      <span id={id} className="text-xs break-words text-danger">
        {refusalText(option)}
      </span>
    );
  const checked =
    option.deferred === undefined ? "" : " · checked on submit (git diff)";
  return (
    <span id={id} className="font-mono text-xs text-muted-foreground">
      {`${option.rule}${checked}`}
    </span>
  );
}

/**
 * A move refused for the plan artifact — the one refusal the operator can answer here. Both of
 * `missing_artifact`'s causes qualify: the ticket names no plan *and* it names one that is not
 * there. Gating this on `plan_path === null` was a dead end of its own — one typo made the path
 * non-null, and the field that would have corrected it disappeared.
 */
const wantsPlanPath = (option: TransitionOption): boolean =>
  !option.allowed && option.reason === "missing_artifact";

/**
 * The remedy for a `missing_artifact` refusal, beside the refusal itself. `plan_path`
 * has always been settable through PATCH, but no screen exposed it, so an operator holding a
 * written plan could only point the ticket at it with curl — and the refusal named no next step.
 *
 * Starts from the path the ticket already names, so a refusal about a file that is not there is a
 * correction rather than a retype. Setting the path is all this does: the move stays the operator's
 * to make, and the server still checks the file is really in the worktree when they make it, so
 * naming a path that is not there refuses again rather than passing.
 */
function PlanPathField({ ticket }: { readonly ticket: TicketView }) {
  const queryClient = useQueryClient();
  const current = ticket.plan_path ?? "";
  const [path, setPath] = useState(current);
  const fieldId = useId();
  const set = useMutation({
    mutationFn: () =>
      patchTicket(ticket.num, ticket.version, { plan_path: path.trim() }),
    onSuccess: () => {
      notify.success(`Plan path set for ${ticket.key}`);
      return Promise.all([
        queryClient.invalidateQueries({
          queryKey: ticketQuery(ticket.num).queryKey,
        }),
        queryClient.invalidateQueries({ queryKey: TICKETS_KEY }),
      ]);
    },
  });
  const trimmed = path.trim();
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Label className="text-xs text-muted-foreground" htmlFor={fieldId}>
        Plan path
      </Label>
      <Input
        id={fieldId}
        value={path}
        placeholder={`docs/spikes/${ticket.key}.md`}
        onChange={(e) => setPath(e.target.value)}
        className="h-7 w-64 text-xs"
      />
      <Button
        size="sm"
        variant="outline"
        // Nothing to write: no path, or the one the ticket already names. Re-sending that would
        // bump the version without changing anything — a file that is missing is fixed on disk.
        disabled={trimmed === "" || trimmed === current || set.isPending}
        onClick={() => set.mutate()}
      >
        {current === "" ? "Set plan path" : "Update plan path"}
      </Button>
      {set.error !== null && (
        <span role="alert" className="text-xs text-destructive">
          {set.error.message}
        </span>
      )}
    </span>
  );
}
