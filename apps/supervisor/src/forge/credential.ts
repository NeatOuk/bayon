// The forge token a remote is offered (one rule, shared by the
// delivery push and by every read the supervisor's mirrors make from their origin. The rule is
// decided by the URL alone: its host names a forge Bayon implements (`forgeRemote`), that forge's
// `FORGE_TOKEN_<KIND>` is in the host secret store, and — for git — the URL is https. Anything else
// (an ssh or scp-like remote, a local path, a host with no forge kind, a store without the token)
// gets no credential of ours at all, and git, which never prompts (GIT_ENV_FLOOR), fails instead.
//
// The token goes to git only through its environment (`gitTokenEnv`), answered by the credential
// helper `gitTokenFlags()` names, and only for the URL's own host: never an argv element, a URL, a
// file or a mirror's config (Invariant 11). A store miss is not an error here; the caller decides
// what no token means. And only to a git on this host: a non-local executor is never handed it.
import {
  forgeRemote,
  forgeTokenSecret,
  isHttpsUrl,
  type ForgeRemote,
} from "@bayon/core";
import { gitTokenEnv, gitTokenFlags, type SecretStore } from "@bayon/executors";
import { FORGES } from "./github.js";

export interface ForgeCredential {
  /** The forge `url` is on, when Bayon implements it; null otherwise. */
  readonly forge: ForgeRemote | null;
  /** The token for that forge's API; null with no forge, or when the store has none. */
  readonly token: string | null;
  /** The same token, offered to git only when `url` is https; null otherwise. */
  readonly gitToken: string | null;
}

const NONE: ForgeCredential = { forge: null, token: null, gitToken: null };

/** The forge `url` is on and the token the host store holds for it, by the one rule above. */
export async function forgeCredential(
  secrets: SecretStore,
  url: string,
  forgeOf: (url: string) => ForgeRemote | null = forgeRemote,
): Promise<ForgeCredential> {
  const forge = forgeOf(url);
  if (forge === null || !FORGES.has(forge.kind)) return NONE;
  const found = await secrets.get(forgeTokenSecret(forge.kind));
  if (!found.ok) return { ...NONE, forge };
  return {
    forge,
    token: found.value,
    gitToken: isHttpsUrl(url) ? found.value : null,
  };
}

/** What git is handed to answer an https credential prompt: `-c` flags and env, or neither. */
export interface GitAuth {
  /** Goes before the subcommand, after SAFE_GIT (see `gitTokenFlags`). Never holds the token. */
  readonly flags: readonly string[];
  /** Added to git's environment: the one place the token travels. */
  readonly env: Readonly<Record<string, string>>;
}

export const NO_GIT_AUTH: GitAuth = { flags: [], env: {} };

/**
 * `gitToken` as git's flags and env, answering only for `url`'s host (as git names it in a
 * credential request: with a port when the URL has a non-default one). A null token, or a URL that
 * does not parse, is no credential at all.
 */
export function gitAuthOf(gitToken: string | null, url: string): GitAuth {
  if (gitToken === null || !URL.canParse(url)) return NO_GIT_AUTH;
  return {
    flags: gitTokenFlags(),
    env: gitTokenEnv(gitToken, new URL(url).host),
  };
}

/**
 * What a mirror's read from `originUrl` (a clone, a fetch) offers git: delivery's rule, applied to
 * the repo's origin. No origin, or no store (a caller wired without one), is no credential.
 */
export async function originGitAuth(
  secrets: SecretStore | undefined,
  originUrl: string | null,
): Promise<GitAuth> {
  if (secrets === undefined || originUrl === null) return NO_GIT_AUTH;
  return gitAuthOf(
    (await forgeCredential(secrets, originUrl)).gitToken,
    originUrl,
  );
}
