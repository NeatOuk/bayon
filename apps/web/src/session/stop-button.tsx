import type { SessionView, StopMode } from "@bayon/proto";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sessionQuery, stopSession } from "@/api/queries";
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
import { notify } from "@/components/ui/toast";

/** What the toast says once the supervisor has the request. */
const STOPPED: Readonly<Record<StopMode | "discard", string>> = {
  graceful: "Stop requested: it finishes its turn first",
  kill: "Kill requested",
  discard: "Discard requested",
};

/** A session already ending or ended has nothing left to stop. */
const ENDED: readonly string[] = ["exited", "handed_off", "stopping"];
const canStop = (session: SessionView): boolean =>
  !ENDED.includes(session.state);

/**
 * §12.3 SESSION [stop]: `POST /sessions/:id/stop`, confirmed the same way the fleet pause switch
 * confirms a state change. Graceful is the safer default (a resumable runner ends `resumable`, so
 * it can come back); kill ends it for good right away. A session that has already suspended is
 * offered the kill alone, which discards it — graceful has nothing left to do there,
 * and the server refuses it saying exactly that.
 */
export function StopButton({ session }: { readonly session: SessionView }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const suspended = session.state === "resumable";
  const stop = useMutation({
    mutationFn: (mode: StopMode) => stopSession(session.id, mode),
    onSuccess: (_accepted, mode) => {
      setOpen(false);
      notify.success(STOPPED[suspended ? "discard" : mode]);
      void queryClient.invalidateQueries({
        queryKey: sessionQuery(session.id).queryKey,
      });
    },
  });

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={!canStop(session)}
        onClick={() => {
          stop.reset();
          setOpen(true);
        }}
      >
        {suspended ? "Discard" : "Stop"}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {suspended ? "Discard this session?" : "Stop this session?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {suspended
                ? "It suspended and could still be resumed. Discarding gives that up for good, and releases the worktree it is holding back from the sweep."
                : "Graceful lets it finish its current turn; a resumable runner ends resumable, so it can be picked back up later. Kill ends it right away."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {stop.error !== null && (
            <p role="alert" className="text-sm text-destructive">
              {stop.error.message}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {!suspended && (
              <Button
                variant="outline"
                disabled={stop.isPending}
                onClick={() => stop.mutate("graceful")}
              >
                Stop (graceful)
              </Button>
            )}
            <Button
              variant="destructive"
              disabled={stop.isPending}
              onClick={() => stop.mutate("kill")}
            >
              {suspended ? "Discard for good" : "Kill now"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
