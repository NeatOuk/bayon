import { z } from "zod";
import {
  forgeRemote,
  forgeTokenSecret,
  isHttpsUrl,
  remoteHost,
} from "../delivery/remote.js";

// Whether a project's repo can be read the way the supervisor's mirror clone reads it,
// in plain words. Pure: the supervisor runs `git ls-remote` and classifies what git said; the API
// and the spawn path turn the result into a sentence and one thing to do. A value handed in as a
// secret and a URL's userinfo never reach a sentence, a detail or a log (Invariant 11).

/** How long the check's `git ls-remote` may take before it is killed and called a timeout. */
export const REPO_CHECK_LIMIT_MS = 20_000;
/** How much of git's stderr a result or a message quotes. */
export const REPO_DETAIL_MAX = 300;

/**
 * - `found`: git listed the repository's refs.
 * - `missing`: it does not exist, or the credential offered (none, or the forge token) cannot read
 *   it — a forge answers both the same way, on purpose, so neither can be told apart here.
 * - `host_key`: ssh does not know the host's key, and never accepts one unasked.
 * - `unreachable`: the host name does not resolve, or no connection could be made.
 * - `timeout`: no answer within REPO_CHECK_LIMIT_MS.
 * - `failed`: anything else git said; `detail` quotes it.
 */
export const RepoReachOutcome = z.enum([
  "found",
  "missing",
  "host_key",
  "unreachable",
  "timeout",
  "failed",
]);
export type RepoReachOutcome = z.infer<typeof RepoReachOutcome>;

/** A `repo.check` command's result, as the supervisor records it. */
export const RepoCheckResult = z.object({
  outcome: RepoReachOutcome,
  /** The branch the remote's HEAD names; null when not found or not said. */
  default_branch: z.string().min(1).nullable(),
  /** Whether the asked base is a branch on the remote; null when none was asked or not found. */
  base_found: z.boolean().nullable(),
  /** The secret a token for this URL is read from, when the supervisor would offer one. */
  token_secret: z.string().min(1).nullable(),
  /** Whether that token was in the store and offered to git. */
  token_offered: z.boolean(),
  /** git's own words, redacted and cut to REPO_DETAIL_MAX; empty when found. */
  detail: z.string().max(REPO_DETAIL_MAX),
});
export type RepoCheckResult = z.infer<typeof RepoCheckResult>;

const HOST_KEY =
  /host key verification failed|no \S+ host key is known|remote host identification has changed/i;
const UNREACHABLE =
  /could not resolve host|could not resolve hostname|name or service not known|nodename nor servname|temporary failure in name resolution|failed to connect|couldn't connect to server|connection (?:refused|reset|timed out)|operation timed out|network is unreachable|no route to host/i;
/**
 * git's and the forges' own phrasing for "no such repository, or no access to it" ( * L2): anchored, so a missing ssh binary or git helper ("ssh: command not found", "git-remote-https:
 * not found") is not read as the operator's URL or access and falls to `failed`, which blocks
 * nothing.
 */
const MISSING =
  /repository '[^']*' not found|(?:remote: |error: )repository not found|does not appear to be a git repository|could not read (?:username|password) for '[^']*': terminal prompts disabled|authentication failed for '|permission denied \(publickey|permission to \S+ denied to|returned error: 40[134]\b|invalid username or (?:password|token)/i;

/** What a failed `ls-remote`, clone or fetch means, from git's stderr. */
export function classifyRemoteFailure(
  stderr: string,
): Exclude<RepoReachOutcome, "found" | "timeout"> {
  if (HOST_KEY.test(stderr)) return "host_key";
  if (UNREACHABLE.test(stderr)) return "unreachable";
  if (MISSING.test(stderr)) return "missing";
  return "failed";
}

/** A fetch that reached the remote and found no such branch. */
export const NO_REMOTE_BRANCH = /couldn't find remote ref/i;

export interface LsRemote {
  readonly heads: readonly string[];
  readonly defaultBranch: string | null;
}

/** `git ls-remote --symref -- <url> HEAD refs/heads/*`'s stdout: the heads and HEAD's branch. */
export function parseLsRemote(stdout: string): LsRemote {
  let defaultBranch: string | null = null;
  const heads: string[] = [];
  for (const line of stdout.split("\n")) {
    const [left = "", ref = ""] = line.split("\t").map((part) => part.trim());
    const symref = /^ref: refs\/heads\/(.+)$/.exec(left);
    if (symref !== null && ref === "HEAD") defaultBranch = symref[1] ?? null;
    else if (ref.startsWith("refs/heads/")) heads.push(ref.slice(11));
  }
  return { heads, defaultBranch };
}

/**
 * An http(s) URL's userinfo, wherever it is in a text: everything up to the **last** `@` of the
 * authority (`https://user:p@ss@host` included), since the authority ends at the first `/`, `?` or
 * `#` and a password may itself hold an `@` (review L1).
 */
const HTTP_USERINFO = /\b(https?:\/\/)[^\s/?#'"]*@/gi;
/** An ssh URL's password: its user stays (`ssh://git@host` is how ssh URLs are written). */
const SSH_PASSWORD = /\b(ssh:\/\/)([^\s/?#'":@]*):[^\s/?#'"]*@/gi;

const withoutUserinfo = (text: string): string =>
  text.replace(HTTP_USERINFO, "$1").replace(SSH_PASSWORD, "$1$2@");

/** `text` without http(s) userinfo and without any of `secrets`' values, trimmed and capped. */
export function redactCredentials(
  text: string,
  secrets: readonly string[] = [],
  max = REPO_DETAIL_MAX,
): string {
  const masked = secrets
    .filter((s) => s.length > 0)
    .reduce((t, s) => t.replaceAll(s, "***"), withoutUserinfo(text))
    .trim();
  return masked.length <= max ? masked : `…${masked.slice(-(max - 1))}`;
}

/** `url` as a sentence may name it: an http(s) URL loses its userinfo; ssh keeps only its user. */
export const displayUrl = (url: string): string => withoutUserinfo(url.trim());

/**
 * Where the host store keeps a secret, for the command that stores one: the Mac's Keychain service
 * of this install, or the docker host's file store. Null: say "the host secret store" only.
 */
export interface StoreHint {
  readonly kind: "keychain" | "file";
  /** The Keychain service; null with the file store. */
  readonly service: string | null;
}

/** The command that stores `secret` for the supervisor, or null without a hint. */
export function storeSecretCommand(
  secret: string,
  hint: StoreHint | null,
): string | null {
  if (hint === null) return null;
  if (hint.kind === "file" || hint.service === null) {
    return `sudo /srv/bayon/<deployment>/secrets.sh put <deployment> supervisor ${secret}`;
  }
  // `-w` last with no value: security prompts for it, so the token is never in argv or history.
  return `security add-generic-password -U -s ${hint.service} -a ${secret} -w`;
}

/** An ssh URL's host and port, for ssh-keyscan; null for anything else. */
function sshHost(url: string): { host: string; port: string | null } | null {
  if (URL.canParse(url) && new URL(url).protocol === "ssh:") {
    const u = new URL(url);
    return { host: u.hostname, port: u.port === "" ? null : u.port };
  }
  const scp = /^[^/@\s]+@([^/:\s]+):/.exec(url);
  return scp?.[1] === undefined ? null : { host: scp[1], port: null };
}

/** What to say about a check, and the one command that fixes it when there is one. */
export interface RepoReachText {
  readonly message: string;
  readonly command: string | null;
}

const said = (detail: string): string =>
  detail === "" ? "" : ` git said: ${detail}`;

function missingText(
  url: string,
  r: RepoCheckResult,
  hint: StoreHint | null,
): RepoReachText {
  const shown = displayUrl(url);
  const host = remoteHost(url) ?? "its host";
  if (r.token_secret !== null) {
    const command = storeSecretCommand(r.token_secret, hint);
    const where =
      command === null
        ? " in the host secret store"
        : ", with the command below";
    return r.token_offered
      ? {
          message: `Bayon cannot read ${shown} with the token in ${r.token_secret}: the repository does not exist, or that token has no access to it. Check the URL, or give the token access to the repository, or store a token that has it as ${r.token_secret}${where}.`,
          command,
        }
      : {
          message: `Bayon cannot read ${shown}: the repository does not exist, or it is private and Bayon has no token for ${host}. Check the URL. If the repository is private, store a token that can read it as ${r.token_secret}${where}; the next check reads it, no restart needed.`,
          command,
        };
  }
  if (sshHost(url) !== null) {
    return {
      message: `Bayon cannot read ${shown} over ssh: the repository does not exist, or this machine's ssh key has no access to it. Check the URL, or add this machine's public key (in ~/.ssh) to an account that can read the repository. Bayon uses a key file with no passphrase; it never asks for one and does not use the ssh agent.`,
      command: null,
    };
  }
  return {
    message: `Bayon cannot read ${shown}: the repository does not exist, or it needs a login Bayon has no token for. Check the URL, or use an ssh URL with a key on this machine.`,
    command: null,
  };
}

/** The plain words for a check's result: what happened, then what to do. */
export function repoReachText(
  url: string,
  r: RepoCheckResult,
  hint: StoreHint | null,
): RepoReachText {
  const shown = displayUrl(url);
  const host = remoteHost(url) ?? shown;
  switch (r.outcome) {
    case "found":
      return {
        message:
          r.default_branch === null
            ? `Found ${shown}.`
            : `Found ${shown}. Its default branch is ${r.default_branch}.`,
        command: null,
      };
    case "missing":
      return missingText(url, r, hint);
    case "host_key": {
      const ssh = sshHost(url);
      const port = ssh?.port === null || ssh === null ? "" : ` -p ${ssh.port}`;
      return {
        message: `This machine does not know ${host}'s ssh host key yet, so Bayon will not connect to it. Check the key's fingerprint against the one ${host} publishes, then add it to ~/.ssh/known_hosts with the command below.`,
        command: `ssh-keyscan${port} ${ssh?.host ?? host} >> ~/.ssh/known_hosts`,
      };
    }
    case "unreachable":
      return {
        message: `Bayon cannot reach ${host}: the host name does not resolve, or the connection failed. Check the URL and this machine's network.`,
        command: null,
      };
    case "timeout":
      return {
        message: `${host} did not answer within ${Math.round(REPO_CHECK_LIMIT_MS / 1000)} s. Check the URL and this machine's network, then try again.`,
        command: null,
      };
    case "failed":
      return {
        message: `git could not read ${shown}.${said(r.detail)}`,
        command: null,
      };
  }
}

/**
 * The secret a token for `url` is read from, when the supervisor offers one (delivery's rule,
 *): an https URL on a forge Bayon implements. Null for anything else.
 */
export function repoTokenSecret(url: string): string | null {
  const forge = forgeRemote(url);
  return forge !== null && isHttpsUrl(url)
    ? forgeTokenSecret(forge.kind)
    : null;
}
