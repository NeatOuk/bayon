import {
  NOTIFY_CONFIG_FIELDS,
  NOTIFY_CONFIG_KEY,
  NOTIFY_CONFIG_LABEL,
  NOTIFY_CONFIG_SCHEMA,
  shownDestination,
  type NotifyConfigField,
} from "@bayon/core";
import type { NotifyConfigView } from "@bayon/proto";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { z } from "zod";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { notify } from "@/components/ui/toast";
import {
  NOTIFY_CONFIG_KEY as CONFIG_QUERY_KEY,
  putNotifyConfig,
  refusalMessage,
} from "@/notify/notify-api";
import { SettingsSection } from "@/components/settings-section";

// The three settings that steer where a notification goes and what its link opens (§14).
// They are the only ones the GUI changes through a door of their own, and every change here is
// confirmed, audited, and announced — including to the address that is losing the mail. So the
// confirm is not politeness: it is the last moment before a durable redirect, and it names both
// values so the operator sees what is being replaced.

const HELP: Readonly<Record<NotifyConfigField, string>> = {
  email_to:
    "Where the email channel mails every notification. Empty stops the mail. Changing this mails the old address too, so a redirect cannot pass unnoticed.",
  email_from:
    "The sender the mail names. Empty uses the SMTP login when that is an address.",
  base_url:
    "The origin every notification's link opens, e.g. https://bayon.lan:5173 — an origin only, no path. A phone or a mailbox follows it, so name only the GUI you serve. Empty sends no link.",
};

const PLACEHOLDER: Readonly<Record<NotifyConfigField, string>> = {
  email_to: "you@example.com",
  email_from: "bayon@example.com",
  base_url: "https://bayon.lan:5173",
};

/** What the operator is about to change, once its value passed the same schema the server uses. */
interface PendingChange {
  readonly field: NotifyConfigField;
  readonly from: string;
  readonly to: string;
}

/** The draft of each field; absent means "as the server has it". */
type Drafts = Readonly<Partial<Record<NotifyConfigField, string>>>;

/** A value the server would take, or why it would not. */
export function checkDestination(
  field: NotifyConfigField,
  value: string,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: string } {
  const parsed = NOTIFY_CONFIG_SCHEMA[field].safeParse(value.trim());
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: z.prettifyError(parsed.error) };
}

export function DestinationsPanel({
  config,
}: {
  readonly config: NotifyConfigView;
}) {
  const queryClient = useQueryClient();
  const groupId = useId();
  const [drafts, setDrafts] = useState<Drafts>({});
  const [errors, setErrors] = useState<Drafts>({});
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: (p: PendingChange) => putNotifyConfig({ [p.field]: p.to }),
    onSuccess: (view, p) => {
      queryClient.setQueryData(CONFIG_QUERY_KEY, view);
      setDrafts((current) => ({ ...current, [p.field]: undefined }));
      setPending(null);
      notify.success(
        `${NOTIFY_CONFIG_LABEL[p.field]} is now ${shownDestination(p.to)}`,
        "The change is in the audit log.",
      );
    },
  });

  /** Nothing is sent from here: it only opens the confirm, once the value would be accepted. */
  function ask(field: NotifyConfigField) {
    setNotice(null);
    change.reset();
    const raw = drafts[field] ?? config[field];
    const checked = checkDestination(field, raw);
    if (!checked.ok) {
      setErrors((current) => ({ ...current, [field]: checked.error }));
      return;
    }
    setErrors((current) => ({ ...current, [field]: undefined }));
    if (checked.value === config[field]) {
      setNotice(`${NOTIFY_CONFIG_LABEL[field]} is already that.`);
      return;
    }
    setPending({ field, from: config[field], to: checked.value });
  }

  return (
    <SettingsSection
      label="notification destinations"
      title="Who is told, and where links go"
      description={
        <p id={groupId}>
          These three steer where a notification goes and what its link opens,
          so each change is confirmed here, written to the audit log with both
          values, and announced on the channels that are on.
        </p>
      }
    >
      {NOTIFY_CONFIG_FIELDS.map((field) => {
        const error = errors[field];
        const value = drafts[field] ?? config[field];
        return (
          <Field
            key={field}
            id={`${groupId}-${field}`}
            label={NOTIFY_CONFIG_LABEL[field]}
            hint={
              <>
                {`${HELP[field]} Now ${shownDestination(config[field])}. `}
                <span className="font-mono">{NOTIFY_CONFIG_KEY[field]}</span>
              </>
            }
            error={error}
            announce
          >
            {({ id, describedBy, invalid }) => (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id={id}
                  value={value}
                  placeholder={PLACEHOLDER[field]}
                  aria-invalid={invalid}
                  aria-describedby={describedBy}
                  className="max-w-96"
                  onChange={(event) =>
                    setDrafts((current) => ({
                      ...current,
                      [field]: event.target.value,
                    }))
                  }
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={change.isPending}
                  onClick={() => ask(field)}
                >
                  Change
                </Button>
              </div>
            )}
          </Field>
        );
      })}
      <p role="status" aria-live="polite" className="text-sm">
        {notice}
      </p>
      <AlertDialog
        open={pending !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setPending(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending === null
                ? "Change a destination?"
                : `Change ${NOTIFY_CONFIG_LABEL[pending.field]}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending === null
                ? ""
                : `It is ${shownDestination(pending.from)}. It becomes ${shownDestination(pending.to)}. The change is written to the audit log${pending.field === "email_to" && pending.from !== "" ? `, and ${pending.from} is mailed that it is no longer the recipient` : ""}.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={change.isPending}
              onClick={() => {
                if (pending !== null) change.mutate(pending);
              }}
            >
              {change.isPending ? "Changing…" : "Change it"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {change.isError && (
        <p role="alert" className="text-sm text-danger">
          {`Not changed: ${refusalMessage(change.error)}`}
        </p>
      )}
    </SettingsSection>
  );
}
