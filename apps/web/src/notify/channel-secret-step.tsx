import type { KeychainScopeView, NotifyChannelStatus } from "@bayon/proto";
import { CopyCommand } from "@/notify/copy-command";

// Where a channel's destination goes, per host, exactly as the Jira token step does it:
// the Mac's Keychain, or the docker host's secret files. The GUI never asks for the destination
// itself — it is a secret (§14) — so this is one command to run and nothing to type here.

// The Keychain service is the running install's own, as the API reports it: `foreman`
// for the default home (~/.foreman), a service derived from the home for any other install. The
// commands name it, so a secret stored from here lands where this install reads it, and nowhere a
// scratch or second install could.

/**
 * Stores the value from the clipboard, so it never lands in the shell's history, and so the
 * `security` prompt's 128-character cut cannot silently truncate a long URL. `-U` replaces one
 * already stored.
 */
export const keychainCommand = (service: string, secret: string): string =>
  `security add-generic-password -U -s ${service} -a ${secret} -w "$(pbpaste)"`;

/** What was stored, by length only: this never prints the value. */
export const keychainLengthCommand = (
  service: string,
  secret: string,
): string =>
  `security find-generic-password -s ${service} -a ${secret} -w | wc -c`;

/** Which Keychain service, and whose: "Keychain · foreman (this install)". */
export const keychainLabel = (keychain: KeychainScopeView): string =>
  `Keychain · ${keychain.service} (${keychain.owner ? "this install" : "this home's own, not ~/.foreman's"})`;

/** Where the API reads a secret from, in words, for a "found" line. */
export const storeLabel = (status: {
  readonly keychain: KeychainScopeView | null;
}): string =>
  status.keychain === null ? "secret files" : keychainLabel(status.keychain);

/** The docker host's file store: the value on stdin. */
export const fileStoreCommand = (secret: string): string =>
  `sudo /srv/bayon/<deployment>/secrets.sh put <deployment> api ${secret}`;

/** The API process's own environment, which the host store reads first. */
export const envAlternative = (secret: string): string =>
  `FRM_SECRET_${secret}`;

/** What each channel's secret is, in words, so the operator knows what to copy first. */
const WHAT: Readonly<Record<string, string>> = {
  NOTIFY_NTFY_URL:
    "the full ntfy topic URL, e.g. https://ntfy.sh/<a-topic-nobody-guesses>. Anyone with the URL can read your notifications, so make the topic long.",
  NOTIFY_WEBHOOK_URL:
    "the webhook's URL (a Slack incoming webhook works as it is).",
  NOTIFY_SMTP_URL:
    "the SMTP server as one URL: smtps://user:password@host:465, or smtp://…:587, which must upgrade with STARTTLS.",
};

/**
 * The one-time store step for a channel that is not configured. `mac` has no secret (it is this
 * host's own Notification Center), so it never renders one.
 */
export function ChannelSecretStep({
  status,
}: {
  readonly status: NotifyChannelStatus;
}) {
  const secret = status.secret;
  if (secret === null) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">
        {`No ${secret} yet. Copy ${WHAT[secret] ?? "the destination."}`}
      </p>
      {status.keychain !== null ? (
        <>
          <p className="text-sm">{`Then run, for the ${keychainLabel(status.keychain)}:`}</p>
          <CopyCommand
            command={keychainCommand(status.keychain.service, secret)}
            label={`the Keychain command for ${secret}`}
          />
          <p className="text-xs text-muted-foreground">
            -U replaces one already stored. The command reads the clipboard
            because typing the value at the security prompt cuts it to 128
            characters.
          </p>
          <p className="text-sm">Then check its length is the whole value:</p>
          <CopyCommand
            command={keychainLengthCommand(status.keychain.service, secret)}
            label={`the length check for ${secret}`}
          />
        </>
      ) : (
        <>
          <CopyCommand
            command={fileStoreCommand(secret)}
            label={`the secrets command for ${secret}`}
          />
          <p className="text-xs text-muted-foreground">
            On the docker host, with the value on stdin.
          </p>
        </>
      )}
      <p className="text-xs text-muted-foreground">
        {`Or set ${envAlternative(secret)} in the API's environment. No restart needed either way: the next send reads it.`}
      </p>
    </div>
  );
}
