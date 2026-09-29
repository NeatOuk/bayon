import type {
  TicketView,
  TransitionOption,
  TransitionRequest,
} from "@bayon/proto";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type ReactNode } from "react";
import { ApiRequestError } from "@/api/http";
import {
  TICKETS_KEY,
  patchTicket,
  ticketQuery,
  transitionTicket,
} from "@/api/queries";
import { labelOf } from "@/components/status";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { notify } from "@/components/ui/toast";
import {
  NOTE_LABELS,
  NO_NOTES,
  notesFor,
  refusalText,
  transitionRequest,
  type NoteField,
  type Notes,
} from "@/tickets/ticket-model";

// A ticket's moves as the operator makes them (moved it here from ticket-actions.tsx): one
// flow, so the Actions panel and the header's next-step line take a move the same way. Each write is
// against the version it shows (If-Match, M1 contract 3); a move that needs notes asks for them
// first; a 422 shows its rule, and a 409 refetches the ticket.

/** A write the view makes, each against the version it shows (If-Match, M1 contract 3). */
type Change =
  | { readonly kind: "move"; readonly request: TransitionRequest }
  | { readonly kind: "flag"; readonly needsHuman: boolean };

export interface TicketMove {
  /** Takes `option`, asking for its notes first when it needs any. */
  readonly choose: (option: TransitionOption) => void;
  /** Sets or clears needs_human. */
  readonly flag: (needsHuman: boolean) => void;
  readonly pending: boolean;
  /** The notes dialog while one is open, else the last write's outcome: render it beside the controls. */
  readonly ui: ReactNode;
}

/** What a landed write did, for its toast: the page itself only refreshes. */
const doneText = (ticketKey: string, c: Change): string =>
  c.kind === "move"
    ? `${ticketKey} moved to ${labelOf("ticket", c.request.to)}`
    : c.needsHuman
      ? `${ticketKey} flagged as needing a human`
      : `${ticketKey} no longer flagged as needing a human`;

export function useTicketMove(ticket: TicketView): TicketMove {
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState<TransitionOption | null>(null);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: ticketQuery(ticket.num).queryKey,
      }),
      queryClient.invalidateQueries({ queryKey: TICKETS_KEY }),
    ]);
  const change = useMutation({
    mutationFn: (c: Change) =>
      c.kind === "move"
        ? transitionTicket(ticket.num, ticket.version, c.request)
        : patchTicket(ticket.num, ticket.version, {
            needs_human: c.needsHuman,
          }),
    // Only success closes the notes dialog: a failure keeps what was typed, beside why it failed.
    onSuccess: (_view, c) => {
      setAsking(null);
      notify.success(doneText(ticket.key, c));
      void refresh();
    },
    onError: (error) => {
      if (error instanceof ApiRequestError && error.status === 409)
        void refresh();
    },
  });
  const move = (request: TransitionRequest | null) => {
    if (request !== null) change.mutate({ kind: "move", request });
  };
  const choose = (option: TransitionOption) => {
    if (notesFor(option).length === 0) {
      move(transitionRequest(option.to, [], NO_NOTES));
      return;
    }
    change.reset();
    setAsking(option);
  };
  const outcome = <Outcome error={change.error} ticketKey={ticket.key} />;
  return {
    choose,
    flag: (needsHuman) => change.mutate({ kind: "flag", needsHuman }),
    pending: change.isPending,
    ui:
      asking === null ? (
        outcome
      ) : (
        <NotesDialog
          option={asking}
          pending={change.isPending}
          onCancel={() => {
            setAsking(null);
            change.reset();
          }}
          onSubmit={(notes) =>
            move(transitionRequest(asking.to, notesFor(asking), notes))
          }
        >
          {outcome}
        </NotesDialog>
      ),
  };
}

/** The last write's failure. A 409 is news, not an error: the refetch already shows the newer ticket. */
function Outcome({
  error,
  ticketKey,
}: {
  readonly error: Error | null;
  readonly ticketKey: string;
}) {
  if (error === null) return null;
  const alert = (text: string) => (
    <p role="alert" className="text-sm text-destructive">
      {text}
    </p>
  );
  if (!(error instanceof ApiRequestError)) return alert(error.message);
  const wire = error.error;
  if (error.status === 409) {
    const now =
      wire.current_version === undefined
        ? "a newer version"
        : `v${wire.current_version}`;
    return (
      <p role="status" className="text-sm">
        {`${ticketKey} changed while you were looking (now ${now}). The actions are refreshed; choose again.`}
      </p>
    );
  }
  const rule = wire.rule;
  return rule === undefined
    ? alert(error.message)
    : alert(refusalText({ rule, reason: wire.reason, detail: wire.detail }));
}

function NotesDialog({
  option,
  pending,
  onCancel,
  onSubmit,
  children,
}: {
  readonly option: TransitionOption;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (notes: Notes) => void;
  /** The last submit's outcome, shown inside the dialog so the notes stay in view. */
  readonly children: ReactNode;
}) {
  const [notes, setNotes] = useState<Notes>(NO_NOTES);
  const baseId = useId();
  const fields = notesFor(option);
  const complete = transitionRequest(option.to, fields, notes) !== null;
  const edit = (field: NoteField, value: string) =>
    setNotes((current) => ({ ...current, [field]: value }));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`Move to ${labelOf("ticket", option.to)}`}</DialogTitle>
          <DialogDescription>{`${option.rule} needs these notes; they stay in the ticket's history.`}</DialogDescription>
        </DialogHeader>
        {fields.map((field) => (
          <div key={field} className="flex flex-col gap-1">
            <Label htmlFor={`${baseId}-${field}`}>{NOTE_LABELS[field]}</Label>
            <Textarea
              id={`${baseId}-${field}`}
              value={notes[field]}
              onChange={(event) => edit(field, event.target.value)}
            />
          </div>
        ))}
        {children}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={!complete || pending}
            onClick={() => onSubmit(notes)}
          >
            {`Move to ${labelOf("ticket", option.to)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
