import type { InboxItem } from "@bayon/proto";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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
import {
  INBOX_KEY,
  conflictMessage,
  dismissInboxItem,
} from "@/inbox/inbox-api";

/**
 * `POST /inbox/:id/dismiss` behind a confirm: the operator withdraws a question that no
 * longer matters instead of inventing an answer a later session would act on. It stops holding its
 * ticket, and the last one's dismissal wakes the orchestrator as a last answer does. Final, so it
 * asks first. A 409 (someone closed it first) refetches the lists, and the question leaves them.
 */
export function DismissButton({ item }: { readonly item: InboxItem }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: INBOX_KEY });
  const dismiss = useMutation({
    mutationFn: () => dismissInboxItem(item.id),
    onSuccess: () => {
      setConfirming(false);
      notify.success("Question dismissed");
      void refresh();
    },
    onError: () => {
      setConfirming(false);
      void refresh();
    },
  });
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={dismiss.isPending}
        onClick={() => {
          dismiss.reset();
          setConfirming(true);
        }}
      >
        Dismiss
      </Button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Dismiss this question?</AlertDialogTitle>
            <AlertDialogDescription>
              {`"${item.question}" is closed with no answer, as no longer relevant. It stops holding its ticket, and no session is told to act on it.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={dismiss.isPending}
              onClick={() => dismiss.mutate()}
            >
              Dismiss question
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {dismiss.isError && (
        <p role="alert" className="text-sm text-destructive">
          {`Not dismissed: ${conflictMessage(dismiss.error)}`}
        </p>
      )}
    </>
  );
}
