import {
  NOTIFY_CHANNELS,
  NOTIFY_POLL_KEY,
  NOTIFY_QUIET_END_KEY,
  NOTIFY_QUIET_START_KEY,
  OPERATOR_SETTINGS,
  notifyEnabledKey,
  notifyEventsKey,
  type OperatorSettingKey,
  type OperatorSettingsPatch,
} from "@bayon/core";
import type { OperatorSettingView } from "@bayon/proto";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Loading } from "@/components/loading";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { notify } from "@/components/ui/toast";
import { ChannelCard } from "@/notify/channel-card";
import { DestinationsPanel } from "@/notify/destinations-panel";
import {
  NOTIFY_CHANNELS_KEY,
  notifyChannelsQuery,
  notifyConfigQuery,
} from "@/notify/notify-api";
import { SettingField } from "@/settings/setting-field";
import {
  SETTINGS_KEY,
  putSettings,
  settingsQuery,
} from "@/settings/settings-api";
import {
  checkDraft,
  draftOf,
  type Draft,
  type FieldErrors,
} from "@/settings/settings-form";
import { SectionSave, SettingsSection } from "@/components/settings-section";

// Settings → Notifications. an earlier change shipped the notifier with no way to reach it:
// every channel starts off, and turning one on meant seven `frm settings set` calls and adding up a
// bitmask by hand. This screen is that work, in words: when Bayon may tell you, where it tells you,
// and what it tells you — with a test send beside each channel, because a notification you have
// never seen arrive is a notification you do not trust.

/** The timing settings, above the channels: they govern every one of them. */
const TIMING_KEYS: readonly OperatorSettingKey[] = [
  NOTIFY_QUIET_START_KEY,
  NOTIFY_QUIET_END_KEY,
  NOTIFY_POLL_KEY,
];

/** A stored value, or the default when the row is missing or out of its bounds. */
export function settingValue(
  settings: readonly OperatorSettingView[],
  key: OperatorSettingKey,
): number {
  const row = settings.find((s) => s.key === key);
  return row?.valid === true && row.value !== null
    ? row.value
    : OPERATOR_SETTINGS[key].default;
}

export function NotificationsSettings() {
  const settings = useQuery(settingsQuery);
  const channels = useQuery(notifyChannelsQuery);
  const config = useQuery(notifyConfigQuery);
  const queryClient = useQueryClient();
  const [failed, setFailed] = useState<string | null>(null);
  // A switch or a box saves itself: the row is the control, so there is nothing to "apply".
  const save = useMutation({
    mutationFn: putSettings,
    onSuccess: (view) => {
      setFailed(null);
      queryClient.setQueryData(SETTINGS_KEY, view);
      // `enabled` is in the channels view too, and a send may now be possible.
      void queryClient.invalidateQueries({ queryKey: NOTIFY_CHANNELS_KEY });
    },
    onError: (error: Error) => setFailed(error.message),
  });

  const rows = settings.data?.settings ?? [];
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Settings · Notifications" />
      <p className="max-w-3xl text-sm text-muted-foreground">
        What Bayon tells you about, and how it reaches you. Every channel starts
        off. Where each one sends is a secret in the host&apos;s store, never
        here — this page only says whether it is stored, and names it.
      </p>
      {(settings.isPending || channels.isPending || config.isPending) && (
        <Loading label="Loading the notification settings…" lines={4} />
      )}
      {settings.isError && (
        <QueryError
          title="The settings are unavailable"
          error={settings.error}
          onRetry={() => void settings.refetch()}
        />
      )}
      {channels.isError && (
        <QueryError
          title="The channels are unavailable"
          error={channels.error}
          onRetry={() => void channels.refetch()}
        />
      )}
      {config.isError && (
        <QueryError
          title="The destinations are unavailable"
          error={config.error}
          onRetry={() => void config.refetch()}
        />
      )}
      {failed !== null && (
        <p role="alert" className="text-sm text-danger">
          {`Not saved: ${failed}`}
        </p>
      )}
      {settings.data !== undefined && <TimingPanel settings={rows} />}
      {config.data !== undefined && <DestinationsPanel config={config.data} />}
      {channels.data !== undefined &&
        settings.data !== undefined &&
        NOTIFY_CHANNELS.map((channel) => {
          const status = channels.data.find((c) => c.channel === channel);
          if (status === undefined) return null;
          return (
            <ChannelCard
              key={channel}
              status={status}
              enabled={settingValue(rows, notifyEnabledKey(channel)) === 1}
              events={settingValue(rows, notifyEventsKey(channel))}
              pending={save.isPending}
              onChange={(patch: OperatorSettingsPatch) => save.mutate(patch)}
            />
          );
        })}
    </div>
  );
}

/** Quiet hours and how often the notifier looks: the whitelist's own fields, saved together. */
function TimingPanel({
  settings,
}: {
  readonly settings: readonly OperatorSettingView[];
}) {
  const queryClient = useQueryClient();
  const rows = settings.filter((s) => TIMING_KEYS.includes(s.key));
  const [draft, setDraft] = useState<Draft>(() => draftOf(rows));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: putSettings,
    onSuccess: (view) => {
      queryClient.setQueryData(SETTINGS_KEY, view);
      setDraft(
        draftOf(view.settings.filter((s) => TIMING_KEYS.includes(s.key))),
      );
      notify.success("Saved the notification timing");
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    const checked = checkDraft(draft, rows);
    if (!checked.ok) {
      setErrors(checked.errors);
      setNotice("Nothing saved: fix the marked values.");
      return;
    }
    setErrors({});
    if (checked.patch === null) {
      setNotice("Nothing changed.");
      return;
    }
    save.mutate(checked.patch);
  }

  return (
    <SettingsSection
      label="notification timing"
      title="When"
      description="Inside quiet hours, ntfy, the webhook and email wait until they end. This Mac's banners do not: they are local, and macOS Focus already governs them. −1 on either hour turns quiet hours off."
      form={{ label: "notification timing", onSubmit: submit }}
      footer={
        <SectionSave
          label="Save"
          pending={save.isPending}
          error={save.isError ? save.error.message : null}
        >
          <p role="status" aria-live="polite" className="text-sm">
            {notice}
          </p>
        </SectionSave>
      }
    >
      <div className="grid gap-x-6 gap-y-5 @4xl:grid-cols-2">
        {rows.map((s) => (
          <SettingField
            key={s.key}
            setting={s}
            text={draft[s.key] ?? ""}
            error={errors[s.key]}
            onChange={(text) =>
              setDraft((current) => ({ ...current, [s.key]: text }))
            }
          />
        ))}
      </div>
    </SettingsSection>
  );
}
