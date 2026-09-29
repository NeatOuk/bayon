import {
  AnswerRequest,
  INBOX_ANSWER_MAX_CHARS,
  type InboxItem,
} from "@bayon/proto";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
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
import { choicesOf } from "@/inbox/choices";
import { recommendationOf } from "@/inbox/inbox-groups";
import { Recommendation } from "@/inbox/recommendation";
import { notify } from "@/components/ui/toast";
import {
  INBOX_KEY,
  answerInboxItem,
  conflictMessage,
  isFinalConflict,
} from "@/inbox/inbox-api";

/**
 * `POST /inbox/:id/answer`. An answer is final: a non-retryable 409 means someone answered first, so
 * the inbox is refetched and `onConflict` says so (the request then leaves the open list, this dialog
 * with it). A retryable 409 leaves the request open (approving a proposal whose agent is
 * busy), so the dialog stays and shows the server's reason.
 */
export function AnswerDialog({
  item,
  onConflict,
  preset = null,
}: {
  readonly item: InboxItem;
  readonly onConflict: (message: string) => void;
  /** An option already picked beside the button: the answer starts from it. */
  readonly preset?: string | null;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const inputId = useId();
  const refresh = () => queryClient.invalidateQueries({ queryKey: INBOX_KEY });
  const send = useMutation({
    mutationFn: (text: string) => answerInboxItem(item.id, text),
    onSuccess: () => {
      void refresh();
      setOpen(false);
      notify.success("Answer sent");
    },
    onError: (error) => {
      if (!isFinalConflict(error)) return;
      onConflict(
        `"${item.question}" was answered before yours reached the server; the inbox is refreshed.`,
      );
      setOpen(false);
      void refresh();
    },
  });

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setAnswer(preset ?? "");
      setFormError(null);
      send.reset();
    }
  }

  function submit() {
    const parsed = AnswerRequest.safeParse({ answer });
    if (!parsed.success) {
      setFormError(
        `Write an answer of 1 to ${INBOX_ANSWER_MAX_CHARS} characters.`,
      );
      return;
    }
    setFormError(null);
    send.mutate(parsed.data.answer);
  }

  const choices = choicesOf(item.options);
  const recommendation = recommendationOf(item.context_md);
  const errorMessage =
    formError ?? (send.isError ? conflictMessage(send.error) : null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button size="sm">Answer</Button>} />
      {/* A long question or option would widen the dialog past its box: the medium width, the
          options wrapping (a Button is nowrap by default), and each row kept inside it. */}
      <DialogContent size="md" className="[&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>Answer</DialogTitle>
          <DialogDescription>{item.question}</DialogDescription>
        </DialogHeader>
        {recommendation !== null && <Recommendation text={recommendation} />}
        {choices.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {choices.map((choice) => (
              <Button
                key={choice}
                variant="outline"
                size="sm"
                className="h-auto max-w-full py-1.5 text-left whitespace-normal"
                onClick={() => setAnswer(choice)}
              >
                {choice}
              </Button>
            ))}
          </div>
        )}
        <div className="flex flex-col gap-1">
          <Label htmlFor={inputId}>Your answer</Label>
          <Textarea
            id={inputId}
            value={answer}
            maxLength={INBOX_ANSWER_MAX_CHARS}
            disabled={send.isPending}
            onChange={(event) => setAnswer(event.target.value)}
          />
          {errorMessage !== null && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={send.isPending}>
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
