import {
  OPERATOR_SETTINGS,
  OPERATOR_SETTING_GROUPS,
  type OperatorSettingGroup,
  type OperatorSettingsPatch,
} from "@bayon/core";
import type { OperatorSettingView } from "@bayon/proto";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Loading } from "@/components/loading";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { TextLink } from "@/components/text-link";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ui/toast";
import { NOTIFICATIONS_HREF } from "@/routing";
import { CertificationRuleNote, TrustRuleNote } from "@/settings/policy-notes";
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
import { SettingsSection } from "@/components/settings-section";

const GROUP_TITLE: Readonly<Record<OperatorSettingGroup, string>> = {
  admission: "Admission",
  watchdog: "Watchdog",
  reconciler: "Reconciler",
  worktree: "Worktrees",
  executor: "Executors",
  backup: "Backups",
  jira: "Jira mirror",
  notify: "Notifications",
  qa: "QA",
  runners: "Runners",
};

/** What each group governs, beside its title. */
const GROUP_HELP: Readonly<Record<OperatorSettingGroup, string>> = {
  admission: "When a queued spawn is looked at again, and the disk it needs.",
  watchdog:
    "When a quiet session is probed, and when repeated failures slow or stop a ticket.",
  reconciler: "How the supervisor retries a command it lost track of.",
  worktree: "How often finished worktrees are swept.",
  executor: "What every executor is held to.",
  backup: "The nightly encrypted copy of the database.",
  jira: "How often a project's Jira mirror syncs.",
  notify: "When and where notifications go.",
  qa: "How long CI checks get before QA decides without them.",
  runners: "How often each runner's package is checked for a newer release.",
};

/**
 * The notify group has a screen of its own, where a channel's events are checkboxes and
 * a test send sits beside them; drawing the same rows here as bare numbers too would be two places
 * to change one thing. The map stays exhaustive over the groups, so a group added later still needs
 * a title.
 */
const OWN_SCREEN: Readonly<Record<string, string>> = {
  notify: NOTIFICATIONS_HREF,
};

/** Settings → General (M4 §12.1): the whitelisted operator settings, and the two security controls read-only. */
export function GeneralSettings() {
  const settings = useQuery(settingsQuery);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Settings · General" />
      <p className="max-w-3xl text-sm text-muted-foreground">
        The settings an operator tunes. Each value is checked against its bounds
        before it is saved, and every change is written to the audit log. The
        kill switch is the header&apos;s Pause fleet; the daily budget cap is on
        the Fleet; notifications have{" "}
        <TextLink href={NOTIFICATIONS_HREF} inline>
          their own tab
        </TextLink>
        .
      </p>
      {settings.isPending && (
        <Loading label="Loading the settings…" lines={4} />
      )}
      {settings.isError && (
        <QueryError
          title="The settings are unavailable"
          error={settings.error}
          onRetry={() => void settings.refetch()}
        />
      )}
      {settings.data !== undefined && (
        <SettingsForm settings={settings.data.settings} />
      )}
      <CertificationRuleNote
        requireCertified={settings.data?.require_certified}
      />
      <TrustRuleNote />
    </div>
  );
}

function SettingsForm({
  settings,
}: {
  readonly settings: readonly OperatorSettingView[];
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => draftOf(settings));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: putSettings,
    onSuccess: (view, patch: OperatorSettingsPatch) => {
      queryClient.setQueryData(SETTINGS_KEY, view);
      setDraft(draftOf(view.settings));
      const count = Object.keys(patch).length;
      // An event, so a toast; "Nothing changed" and "fix the marked settings" stay beside the
      // buttons, because they describe the form as it stands.
      notify.success(`Saved ${count} setting${count === 1 ? "" : "s"}`);
    },
  });

  function save(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    const checked = checkDraft(draft, settings);
    if (!checked.ok) {
      setErrors(checked.errors);
      setNotice("Nothing saved: fix the marked settings.");
      return;
    }
    setErrors({});
    if (checked.patch === null) {
      setNotice("Nothing changed.");
      return;
    }
    mutation.mutate(checked.patch);
  }

  function discard() {
    setDraft(draftOf(settings));
    setErrors({});
    setNotice(null);
    mutation.reset();
  }

  return (
    <form
      aria-label="general settings"
      onSubmit={save}
      noValidate
      className="flex flex-col gap-4"
    >
      {OPERATOR_SETTING_GROUPS.map((group) => {
        if (OWN_SCREEN[group] !== undefined) return null;
        const rows = settings.filter(
          (s) => OPERATOR_SETTINGS[s.key].group === group,
        );
        if (rows.length === 0) return null;
        return (
          <SettingsSection
            key={group}
            label={`${group} settings`}
            title={GROUP_TITLE[group]}
            description={GROUP_HELP[group]}
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
      })}
      {/* One Save for the whole form, kept in reach at the bottom of the screen while it scrolls. */}
      <div
        data-slot="save-bar"
        className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-2 rounded-xl border bg-card px-5 py-3 shadow-lg"
      >
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Saving…" : "Save changes"}
        </Button>
        <Button type="button" variant="outline" onClick={discard}>
          Discard
        </Button>
        <p role="status" aria-live="polite" className="text-sm">
          {notice}
        </p>
        {mutation.isError && (
          <p role="alert" className="text-sm text-danger">
            {`Not saved: ${mutation.error.message}`}
          </p>
        )}
      </div>
    </form>
  );
}
