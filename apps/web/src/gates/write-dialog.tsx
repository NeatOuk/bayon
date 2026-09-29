import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { ApiRequestError } from "@/api/http";
import { TICKETS_KEY, TICKET_KEY } from "@/api/queries";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { notify } from "@/components/ui/toast";
import { GATES_KEY } from "@/gates/gate-api";

// The operator's gate and finding writes (§12.1): each a dialog that checks its proto request before
// it posts. A 409 means the gate or finding moved on first: every view is refetched and says so.

/** proto's note bound: a waive reason or a resolution note, 1 to 500 characters, shown forever. */
export const NOTE_MAX_CHARS = 500;

export type OnConflict = (message: string) => void;

export const isConflict = (error: Error): boolean =>
  error instanceof ApiRequestError && error.status === 409;

export const conflictText = (subject: string, error: Error): string =>
  `${subject} changed before your write arrived (${error.message}); the view is refreshed.`;

/** Every view a gate or finding write changes: the queue, the ticket details, the board's rounds. */
export function useGateRefresh(): () => Promise<unknown> {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      [GATES_KEY, TICKET_KEY, TICKETS_KEY].map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    );
}

/** The banner a 409 leaves behind. */
export function ConflictNotice({ notice }: { readonly notice: string | null }) {
  if (notice === null) return null;
  return (
    <Alert status="warning">
      <AlertTitle>Already moved on</AlertTitle>
      <AlertDescription>{notice}</AlertDescription>
    </Alert>
  );
}

export interface NoteField {
  readonly name: string;
  readonly label: string;
  /** A one-line input (a run id); otherwise a textarea (a note). */
  readonly short?: boolean;
  readonly maxLength: number;
}

type Values = Readonly<Record<string, string>>;

export function WriteDialog<T>({
  trigger,
  title,
  description,
  submit: submitLabel,
  fields,
  parse,
  invalid,
  send,
  done,
  subject,
  onConflict,
}: {
  readonly trigger: string;
  readonly title: string;
  readonly description: string;
  readonly submit: string;
  readonly fields: readonly NoteField[];
  /** The request from what was typed, or null when its proto schema refuses it. */
  readonly parse: (values: Values) => T | null;
  /** What to fix when `parse` refuses. */
  readonly invalid: string;
  readonly send: (request: T) => Promise<unknown>;
  /** What the toast says once the write lands: the dialog closes, so this is the only word of it. */
  readonly done: string;
  /** What the write changes, as a 409 notice names it. */
  readonly subject: string;
  readonly onConflict: OnConflict;
}) {
  const refresh = useGateRefresh();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Values>({});
  const [formError, setFormError] = useState<string | null>(null);
  const baseId = useId();
  const write = useMutation({
    mutationFn: send,
    onSuccess: () => {
      setOpen(false);
      notify.success(done);
      void refresh();
    },
    // Only a 409 closes the dialog: any other refusal stays beside what was typed.
    onError: (error) => {
      if (!isConflict(error)) return;
      onConflict(conflictText(subject, error));
      setOpen(false);
      void refresh();
    },
  });

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setValues({});
      setFormError(null);
      write.reset();
    }
  }

  function submit() {
    const request = parse(values);
    if (request === null) {
      setFormError(invalid);
      return;
    }
    setFormError(null);
    write.mutate(request);
  }

  const errorMessage =
    formError ?? (write.isError ? write.error.message : null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button size="sm" variant="outline">
            {trigger}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {fields.map((field) => {
          const id = `${baseId}-${field.name}`;
          const props = {
            id,
            value: values[field.name] ?? "",
            maxLength: field.maxLength,
            disabled: write.isPending,
          };
          const onChange = (text: string) =>
            setValues((v) => ({ ...v, [field.name]: text }));
          return (
            <div key={field.name} className="flex flex-col gap-1">
              <Label htmlFor={id}>{field.label}</Label>
              {field.short === true ? (
                <Input
                  {...props}
                  onChange={(event) => onChange(event.target.value)}
                />
              ) : (
                <Textarea
                  {...props}
                  onChange={(event) => onChange(event.target.value)}
                />
              )}
            </div>
          );
        })}
        {errorMessage !== null && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage}
          </p>
        )}
        <DialogFooter>
          <Button onClick={submit} disabled={write.isPending}>
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
