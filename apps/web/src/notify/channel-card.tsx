import {
  notifyEnabledKey,
  notifyEventsKey,
  type NotifyChannel,
  type OperatorSettingsPatch,
} from "@bayon/core";
import type { NotifyChannelStatus } from "@bayon/proto";
import { useMutation } from "@tanstack/react-query";
import { useId } from "react";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { formatLocalTime } from "@/lib/format";
import { ChannelSecretStep, storeLabel } from "@/notify/channel-secret-step";
import {
  EVENT_HELP,
  EVENT_KINDS,
  EVENT_LABEL,
  hasEvent,
  withEvent,
} from "@/notify/event-labels";
import {
  isTestCooldown,
  refusalMessage,
  sendNotifyTest,
} from "@/notify/notify-api";
import { SettingsSection } from "@/components/settings-section";

// One channel, whole: its switch, which events it carries, whether its destination is
// stored, a test send, and what happened last. The mask is never shown as a number — the boxes are
// the mask — and no destination or credential is ever asked for or shown here (§14).

export const CHANNEL_TITLE: Readonly<Record<NotifyChannel, string>> = {
  mac: "This Mac",
  ntfy: "ntfy",
  webhook: "Webhook",
  email: "Email",
};

const CHANNEL_HELP: Readonly<Record<NotifyChannel, string>> = {
  mac: "Banners in this Mac's Notification Center. Local, so quiet hours do not hold them — macOS Focus already does.",
  ntfy: "Published to an ntfy topic, which your phone subscribes to.",
  webhook: "POSTed to a webhook; a Slack incoming webhook gets Slack's shape.",
  email: "Mailed over SMTP to the recipient below.",
};

/** Why a channel cannot send yet, when it is not configured. */
const NOT_CONFIGURED: Readonly<Record<NotifyChannel, string>> = {
  mac: "The API is not running on a Mac, so there is no Notification Center to show.",
  ntfy: "Its topic is not in the host secret store.",
  webhook: "Its URL is not in the host secret store.",
  email: "Its SMTP server, or the recipient, is not set.",
};

function TestButton({ channel }: { readonly channel: NotifyChannel }) {
  const test = useMutation({ mutationFn: () => sendNotifyTest(channel) });
  const said = test.isPending
    ? "Sending…"
    : test.isError
      ? isTestCooldown(test.error)
        ? "A test just went to this channel. Wait a few seconds."
        : `Not sent: ${refusalMessage(test.error)}`
      : test.data === undefined
        ? ""
        : test.data.sent
          ? "Sent. It should reach you now."
          : `Not sent: ${test.data.error?.message ?? "the channel refused it"}`;
  const failed = test.isError || (test.data !== undefined && !test.data.sent);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={test.isPending}
        onClick={() => test.mutate()}
      >
        {test.isPending ? "Sending…" : "Send test"}
      </Button>
      <p
        role={failed ? "alert" : "status"}
        className={
          failed ? "text-sm text-destructive" : "text-sm text-muted-foreground"
        }
      >
        {said}
      </p>
    </div>
  );
}

function EventBoxes({
  channel,
  events,
  disabled,
  onChange,
}: {
  readonly channel: NotifyChannel;
  readonly events: number;
  readonly disabled: boolean;
  readonly onChange: (patch: OperatorSettingsPatch) => void;
}) {
  const groupId = useId();
  return (
    <fieldset
      aria-labelledby={groupId}
      className="flex flex-col gap-2 border-0 p-0"
    >
      <p id={groupId} className="text-sm font-medium">
        {`What ${CHANNEL_TITLE[channel]} sends`}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {EVENT_KINDS.map((kind) => {
          const id = `${groupId}-${kind}`;
          return (
            <div key={kind} className="flex items-start gap-2">
              <Checkbox
                id={id}
                disabled={disabled}
                checked={hasEvent(events, kind)}
                onCheckedChange={(on: boolean) =>
                  onChange({
                    [notifyEventsKey(channel)]: withEvent(events, kind, on),
                  })
                }
              />
              <Label htmlFor={id} className="flex flex-col items-start gap-0.5">
                <span>{EVENT_LABEL[kind]}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {EVENT_HELP[kind]}
                </span>
              </Label>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

export function ChannelCard({
  status,
  enabled,
  events,
  pending,
  onChange,
}: {
  readonly status: NotifyChannelStatus;
  readonly enabled: boolean;
  /** `notify.<channel>.events` as stored. */
  readonly events: number;
  /** A save is in flight: the inputs wait rather than fight the server's answer. */
  readonly pending: boolean;
  readonly onChange: (patch: OperatorSettingsPatch) => void;
}) {
  const channel = status.channel;
  const switchId = useId();
  return (
    <SettingsSection
      label={`${channel} notifications`}
      title={CHANNEL_TITLE[channel]}
      description={CHANNEL_HELP[channel]}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Switch
          id={switchId}
          disabled={pending}
          checked={enabled}
          onCheckedChange={(on: boolean) =>
            onChange({ [notifyEnabledKey(channel)]: on ? 1 : 0 })
          }
        />
        <Label htmlFor={switchId}>{enabled ? "On" : "Off"}</Label>
        <StatusBadge
          entity="channel"
          state={status.configured ? "configured" : "unconfigured"}
        />
      </div>
      {!status.configured && (
        <p className="text-sm">{NOT_CONFIGURED[channel]}</p>
      )}
      {!status.configured && <ChannelSecretStep status={status} />}
      {status.configured && status.secret !== null && (
        <p className="text-xs text-muted-foreground">
          {`${status.secret} is in the API's ${storeLabel(status)}; it never leaves the API.`}
        </p>
      )}
      <EventBoxes
        channel={channel}
        events={events}
        disabled={pending}
        onChange={onChange}
      />
      <TestButton channel={channel} />
      <p className="text-xs text-muted-foreground">
        {status.last_sent_at === null
          ? "Nothing sent yet."
          : `Last sent ${formatLocalTime(status.last_sent_at)}.`}
      </p>
      {status.last_error !== undefined && (
        <p role="alert" className="text-sm text-danger">
          {`Last error: ${status.last_error}`}
        </p>
      )}
    </SettingsSection>
  );
}
