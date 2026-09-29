import { JIRA_TOKEN_SECRET } from "@bayon/core";
import type { JiraTokenStatus } from "@bayon/proto";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { Loading } from "@/components/loading";
import { SectionTitle } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { jiraTokenQuery } from "@/jira/jira-api";
import {
  keychainCommand,
  keychainLabel,
  keychainLengthCommand,
  storeLabel,
} from "@/notify/channel-secret-step";
import { CopyCommand } from "@/notify/copy-command";

// Where the operator's Jira token goes, per host (`GET /jira` names the store the API reads, and
// the running install's Keychain service): the Mac's Keychain, or the docker host's
// secret files. The GUI never asks for the token itself.

/**
 * Stores the token from the clipboard, so it never lands in the shell's history. Not `-w` alone:
 * its prompt cuts input at 128 characters, and an Atlassian API token is about 190. `-U` replaces
 * a token already stored. `service` is the install's own, from `GET /jira`.
 */
export const jiraKeychainCommand = (service: string): string =>
  keychainCommand(service, JIRA_TOKEN_SECRET);

/** The stored token's length (and the newline `-w` prints): about 190, or 129 when it was cut. */
export const jiraKeychainLengthCommand = (service: string): string =>
  keychainLengthCommand(service, JIRA_TOKEN_SECRET);

/** The docker host's file store: the value on stdin. */
export const FILE_STORE_COMMAND = `sudo /srv/bayon/<deployment>/secrets.sh put <deployment> api ${JIRA_TOKEN_SECRET}`;

/** The API process's own environment, which the host store reads first. */
export const ENV_ALTERNATIVE = `FRM_SECRET_${JIRA_TOKEN_SECRET}`;

function MissingToken({ status }: { readonly status: JiraTokenStatus }) {
  return (
    <>
      <p className="text-sm">
        {`No ${status.secret} yet. Create an API token at id.atlassian.com → Security → API tokens, with the account that can see the project, then store it:`}
      </p>
      {status.keychain !== null ? (
        <>
          <p className="text-sm">
            {`Copy the token first, then run, for the ${keychainLabel(status.keychain)}:`}
          </p>
          <CopyCommand
            command={jiraKeychainCommand(status.keychain.service)}
            label="the Keychain command"
          />
          <p className="text-xs text-muted-foreground">
            -U replaces a token already stored. Typing or pasting the token at
            the security prompt cuts it to 128 characters, so the command reads
            the clipboard instead.
          </p>
          <p className="text-sm">
            Then check its length: this should print about 190, not 129.
          </p>
          <CopyCommand
            command={jiraKeychainLengthCommand(status.keychain.service)}
            label="the length check"
          />
          <p className="text-xs text-muted-foreground">
            {`Or set ${ENV_ALTERNATIVE} in the API's environment.`}
          </p>
        </>
      ) : (
        <>
          <CopyCommand
            command={FILE_STORE_COMMAND}
            label="the secrets command"
          />
          <p className="text-xs text-muted-foreground">
            On the docker host, with the token on stdin.
          </p>
        </>
      )}
      <p className="text-xs text-muted-foreground">
        No restart needed: the next sync reads it.
      </p>
    </>
  );
}

/**
 * The token step: found, or the one command for this host's store. `quiet` shows it only once the
 * token is known to be missing, or cannot be checked (the strip says nothing while all is well).
 * Its heading is an h2: both places it renders (the New project form, the Tickets view's strip) sit
 * directly under the screen's h1.
 */
export function JiraTokenStep({
  quiet = false,
  level = "h2",
}: {
  readonly quiet?: boolean;
  /** h2 under a page's h1 (the Tickets view, New project); h3 inside the Settings view's Jira section. */
  readonly level?: "h2" | "h3";
}) {
  const token = useQuery(jiraTokenQuery);
  const headingId = useId();
  if (quiet && (token.isPending || token.data?.present === true)) return null;
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded-lg border p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <SectionTitle id={headingId} as={level}>
          Jira API token
        </SectionTitle>
        {token.data !== undefined && (
          <StatusBadge
            entity="secret"
            state={token.data.present ? "found" : "missing"}
          />
        )}
      </div>
      {token.isPending && <Loading label="Checking for the token…" />}
      {token.isError && (
        <p role="alert" className="text-sm text-destructive">
          {`Could not check for the token: ${token.error.message}`}
        </p>
      )}
      {token.data?.present === true && (
        <p className="text-sm text-muted-foreground">
          {`${token.data.secret} is in the API's ${storeLabel(token.data)}; it never leaves the API.`}
        </p>
      )}
      {token.data?.present === false && <MissingToken status={token.data} />}
      {token.data?.present !== true && (
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={token.isFetching}
            onClick={() => void token.refetch()}
          >
            {token.isFetching ? "Checking…" : "Check again"}
          </Button>
        </div>
      )}
    </section>
  );
}
