import type { AttachWhen, SessionView } from "@bayon/proto";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { attachSession, detachSession, sessionQuery } from "@/api/queries";
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
import { clearLeaseToken, writeLeaseToken } from "@/session/pty-lease-storage";

/** Attach requires a live automated process to quiesce and takes over on the local executor only
 * (/136) — a session elsewhere or already ended has nothing for the operator to drive. */
const ATTACHABLE: readonly string[] = ["running", "idle"];
const canAttach = (session: SessionView): boolean =>
  ATTACHABLE.includes(session.state) && session.executor_id === "local";

/**
 * A "take over after this step" the supervisor has recorded and not yet carried out.
 * Only while the session could still be taken over: an ended row never shows one.
 */
export const takeoverPending = (session: SessionView): boolean =>
  session.attach_intent_at !== null && ATTACHABLE.includes(session.state);

/**
 * §12.5 SESSION [attach]. While the agent is mid-turn the default is **Take over after this step**
 *: the turn finishes on its own and the session is taken over between turns, so nothing
 * half-done is lost. **Take over now (interrupts)** stops it mid-turn and asks first. An idle
 * session is simply **Attach** — it asks `turn_end` too, which takes it at once, and waits rather
 * than interrupting if a run started meanwhile. While a takeover is pending: a Cancel. Detach ends
 * the interactive session and hands the ticket back to automation, so it asks first, as
 * `StopButton` does.
 */
export function AttachButton({ session }: { readonly session: SessionView }) {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: sessionQuery(session.id).queryKey,
    });
  const attach = useMutation({
    // Minted before the request, not learned from its response: the 202 carries no lease token
    // (REST convention), so this tab must know its own token up front to later
    // recognize it by equality against whatever `attach_lease_owner` a poll shows — no race, no
    // "adopt whatever shows up next" guessing (own code review found that guess wrong
    // in both directions: a false-positive holder, and a reload permanently losing the real one).
    mutationFn: (when: AttachWhen) => {
      const token = crypto.randomUUID();
      writeLeaseToken(session.id, token);
      return attachSession(session.id, token, when);
    },
    onSuccess: invalidate,
  });
  const [confirmNow, setConfirmNow] = useState(false);
  const [confirmDetach, setConfirmDetach] = useState(false);
  const detach = useMutation({
    mutationFn: () => detachSession(session.id),
    onSuccess: () => {
      clearLeaseToken(session.id);
      setConfirmDetach(false);
      attach.reset();
      invalidate();
    },
  });
  // The ask is accepted (202) before the supervisor has claimed it. Until the row says what came of
  // it — the takeover recorded, the attach made, or the run over — this tab's own accepted ask stands
  // in for the pending state, so the button cannot be pressed twice meanwhile.
  const { reset } = attach;
  useEffect(() => reset(), [reset, session.attach_intent_at, session.state]);
  const awaitingClaim =
    attach.isSuccess &&
    attach.variables === "turn_end" &&
    session.state === "running";

  if (session.state === "human_attached") {
    return (
      <>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            detach.reset();
            setConfirmDetach(true);
          }}
        >
          Detach
        </Button>
        <AlertDialog open={confirmDetach} onOpenChange={setConfirmDetach}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Detach from this session?</AlertDialogTitle>
              <AlertDialogDescription>
                Ends the interactive terminal, brings automation back, and asks
                for a short note about what you changed by hand.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {detach.error !== null && (
              <p role="alert" className="text-sm text-destructive">
                {detach.error.message}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <Button
                disabled={detach.isPending}
                onClick={() => detach.mutate()}
              >
                Detach
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );
  }

  if (takeoverPending(session) || awaitingClaim) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span role="status" className="text-sm text-muted-foreground">
            taking over after this step…
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={detach.isPending}
            onClick={() => detach.mutate()}
          >
            Cancel
          </Button>
        </div>
        {detach.error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {detach.error.message}
          </p>
        )}
      </div>
    );
  }

  const failure = attach.error !== null && !confirmNow && (
    <p role="alert" className="text-sm text-destructive">
      {attach.error.message}
    </p>
  );

  if (session.state === "running" && canAttach(session)) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={attach.isPending}
            onClick={() => attach.mutate("turn_end")}
          >
            Take over after this step
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={attach.isPending}
            onClick={() => {
              attach.reset();
              setConfirmNow(true);
            }}
          >
            Take over now (interrupts)
          </Button>
        </div>
        {failure}
        <AlertDialog open={confirmNow} onOpenChange={setConfirmNow}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Take over now?</AlertDialogTitle>
              <AlertDialogDescription>
                Stops the agent in the middle of its turn: whatever it has not
                finished yet is lost. Take over after this step instead to let
                the turn end first.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {attach.error !== null && (
              <p role="alert" className="text-sm text-destructive">
                {attach.error.message}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <Button
                variant="destructive"
                disabled={attach.isPending}
                onClick={() =>
                  attach.mutate("now", {
                    onSuccess: () => setConfirmNow(false),
                  })
                }
              >
                Take over now
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <Button
        size="sm"
        variant="outline"
        disabled={!canAttach(session) || attach.isPending}
        onClick={() => attach.mutate("turn_end")}
      >
        Attach
      </Button>
      {failure}
    </div>
  );
}
