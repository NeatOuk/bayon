import { JIRA_TOKEN_SECRET, err } from "@bayon/core";
import {
  hostSecrets,
  keychainScope,
  type HostSecrets,
  type KeychainOptions,
  type KeychainScope,
  type SecretStore,
} from "@bayon/executors";
import type { JiraTokenStatus } from "@bayon/proto";

// Where the API finds the operator's Jira token, on every host: the Mac's Keychain
// (FRM_SECRET_JIRA_API_TOKEN in the API's own environment first), or, with FRM_SECRET_STORE=file on
// the docker host, the read-only file under FRM_SECRETS_DIR, where the environment is refused. The
// same lookup a spawn uses (hostSecrets(…).spawn), built once at boot and read at each sync, so a
// token stored later needs no restart. The Keychain service is this install's own:
// `foreman` for the default home only, so a scratch API never reads the live install's token.

export type SecretStoreKind = HostSecrets["kind"];

export interface JiraTokenStore {
  /** Which host store answers: what the missing-token message tells the operator to use. */
  readonly kind: SecretStoreKind;
  /** The Keychain service this install reads; null with the file store. */
  readonly keychain: KeychainScope | null;
  readonly secrets: SecretStore;
}

/**
 * The host store from `env`. One `env` refuses (the file store with a secret in the environment,
 * say) does not stop the API: every read of it then fails, naming why.
 */
export function jiraTokenStore(
  env: Readonly<Record<string, string | undefined>>,
  keychain?: KeychainOptions,
): JiraTokenStore {
  const host = hostSecrets(env, keychain === undefined ? {} : { keychain });
  if (host.ok)
    return {
      kind: host.value.kind,
      keychain: host.value.keychain,
      secrets: host.value.spawn,
    };
  const refused = host.error;
  const file = env.FRM_SECRET_STORE === "file";
  return {
    kind: file ? "file" : "keychain",
    keychain: file ? null : keychainScope(env),
    secrets: { get: () => Promise.resolve(err(refused)) },
  };
}

/**
 * Said before a non-default home's commands, whose service is not the live install's:
 * short, since the whole missing-token message must fit an audit row's 500 characters. The live
 * install's wording is unchanged.
 */
const NOT_DEFAULT_HOME = "not ~/.foreman's Keychain: ";

/** How to store the token in `store`, and that the next sync reads it with no restart. */
export function storeTokenHint(
  store: Pick<JiraTokenStore, "kind" | "keychain">,
): string {
  if (store.kind === "file" || store.keychain === null) {
    return `store it with \`sudo /srv/bayon/<deployment>/secrets.sh put <deployment> api ${JIRA_TOKEN_SECRET}\` (the value on stdin); the next sync reads it, no restart needed`;
  }
  const service = store.keychain.service;
  // The Keychain's door, from the clipboard: the `security` prompt cuts what is pasted into it at
  // 128 characters, and an Atlassian API token is about 190. `-U` replaces one there.
  const put = `security add-generic-password -U -s ${service} -a ${JIRA_TOKEN_SECRET} -w "$(pbpaste)"`;
  // The stored token's length, and the newline `-w` prints: about 190, or 129 when it was cut.
  const length = `security find-generic-password -s ${service} -a ${JIRA_TOKEN_SECRET} -w | wc -c`;
  const whose = store.keychain.owner ? "" : NOT_DEFAULT_HOME;
  return `${whose}copy the token, then run \`${put}\` and check that \`${length}\` prints about 190, not 129 (or set FRM_SECRET_${JIRA_TOKEN_SECRET} in the API's environment); the next sync reads it, no restart needed`;
}

/**
 * `GET /jira`: whether a sync could read the token now, by the sync's own lookup, and from which
 * store and service. The value is read and dropped here: only whether it was found leaves.
 */
export async function jiraTokenStatus(
  store: JiraTokenStore,
): Promise<JiraTokenStatus> {
  const found = await store.secrets.get(JIRA_TOKEN_SECRET);
  return {
    secret: JIRA_TOKEN_SECRET,
    store: store.kind,
    keychain: store.keychain,
    present: found.ok,
  };
}
