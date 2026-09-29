import type { SessionView } from "@bayon/proto";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { sessionQuery } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ui/toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { handOffSession } from "@/handoffs/handoff-api";

/** SessionHandoffRequest's bound on the note. */
const NOTE_MAX_CHARS = 500;

/** The supervisor hands off only a running session that holds a ticket. */
const canHandOff = (session: SessionView): boolean =>
  session.state === "running" && session.ticket_id !== null;

/** §12.3 SESSION [hand off]: the operator hands this session off now (§7.1, reason `operator`). */
export function HandoffButton({ session }: { readonly session: SessionView }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const noteId = useId();
  const send = useMutation({
    mutationFn: (text: string) =>
      handOffSession(session.id, text === "" ? undefined : text),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: sessionQuery(session.id).queryKey,
      });
      setOpen(false);
      notify.success(
        "Hand-off requested",
        "The session writes its packet, then exits.",
      );
    },
  });

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setNote("");
      send.reset();
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogTrigger
          render={
            <Button size="sm" variant="outline" disabled={!canHandOff(session)}>
              Hand off
            </Button>
          }
        />
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Hand off this session</DialogTitle>
            <DialogDescription>
              It writes its hand-off packet and exits; the next session on its
              ticket takes the packet over (§7).
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            <Label htmlFor={noteId}>Note (optional)</Label>
            <Textarea
              id={noteId}
              value={note}
              maxLength={NOTE_MAX_CHARS}
              onChange={(event) => setNote(event.target.value)}
            />
            {send.isError && (
              <p role="alert" className="text-sm text-destructive">
                {send.error.message}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              onClick={() => send.mutate(note.trim())}
              disabled={send.isPending}
            >
              Hand off now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
