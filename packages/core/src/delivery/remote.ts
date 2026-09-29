// Which forge a remote is on (spike §1.4), pure. The kind is decided by the URL's
// **host** and by nothing else: no org, no repository and no deployment of anyone's is named here or
// anywhere downstream. A host with no implementation simply has no kind, and the delivery job then
// pushes without opening a pull request and says so in the ticket's timeline.
//
// Three spellings reach us from `repos.origin_url`, because that is what an operator pastes:
//   https://<host>/<owner>/<repo>[.git]
//   ssh://git@<host>/<owner>/<repo>[.git]
//   git@<host>:<owner>/<repo>[.git]            (scp-like, which is not a URL)
// Anything else — a path, a `file://`, a program transport — is no forge.

/** The forge kinds with an implementation. One today; a second is a file, not a refactor. */
export const FORGE_KINDS = ["github"] as const;
export type ForgeKind = (typeof FORGE_KINDS)[number];

/** Which host is which kind. The only place a forge's host name appears. */
const KIND_BY_HOST: Readonly<Record<string, ForgeKind>> = {
  "github.com": "github",
  "www.github.com": "github",
};

/** Each kind's REST root, https and fixed; tests point a client at a fixture instead. */
export const FORGE_API_BASE: Readonly<Record<ForgeKind, string>> = {
  github: "https://api.github.com",
};

/**
 * The host-store secret holding `kind`'s token (§14, Invariant 11). Decided by the **kind**, so one
 * token serves every project on that forge and no project name ever becomes a secret name.
 */
export const forgeTokenSecret = (kind: ForgeKind): string =>
  `FORGE_TOKEN_${kind.toUpperCase()}`;

/** Every secret name a forge could ask for: what an operator is told to store. */
export const FORGE_TOKEN_SECRETS: readonly string[] =
  FORGE_KINDS.map(forgeTokenSecret);

export interface ForgeRemote {
  readonly kind: ForgeKind;
  /** Lower-cased, no port: what chose the kind. */
  readonly host: string;
  readonly owner: string;
  /** Without its `.git` suffix. */
  readonly repo: string;
  /** Where the forge's REST API lives. */
  readonly apiBase: string;
}

/** `<owner>/<repo>` of a path, or null: exactly two non-empty segments, the second de-suffixed. */
function ownerRepo(path: string): { owner: string; repo: string } | null {
  const parts = path.split("/").filter((part) => part !== "");
  if (parts.length !== 2) return null;
  const [owner, last] = parts as [string, string];
  const repo = last.endsWith(".git") ? last.slice(0, -".git".length) : last;
  if (owner === "" || repo === "") return null;
  return { owner, repo };
}

/** `git@host:owner/repo.git` as a host and a path, or null. `scp`-like is not a URL. */
function scpLike(url: string): { host: string; path: string } | null {
  const match = /^[^/@\s]+@([^/:\s]+):(.+)$/.exec(url);
  if (match === null) return null;
  const [, host, path] = match as unknown as [string, string, string];
  return { host, path };
}

/** `url`'s host and path when it is an https or ssh URL, or null for anything else. */
function urlParts(url: string): { host: string; path: string } | null {
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") return null;
  return { host: parsed.hostname, path: parsed.pathname };
}

/**
 * The forge `url` is on, or null when its host has no kind (and for a path, a `file://`, a
 * `http://` remote, or anything that is not a repository URL at all). Never throws.
 */
export function forgeRemote(url: string): ForgeRemote | null {
  const trimmed = url.trim();
  if (trimmed === "") return null;
  const parts = urlParts(trimmed) ?? scpLike(trimmed);
  if (parts === null) return null;
  const host = parts.host.toLowerCase();
  const kind = KIND_BY_HOST[host];
  if (kind === undefined) return null;
  const named = ownerRepo(parts.path);
  return named === null
    ? null
    : { kind, host, ...named, apiBase: FORGE_API_BASE[kind] };
}

/** Whether `url` is an https URL: the only kind a token may be offered to (spike §1.5). */
export const isHttpsUrl = (url: string): boolean =>
  URL.canParse(url) && new URL(url).protocol === "https:";

/** The host of `url` for the record, or null: a host is never a secret, a whole URL can be (§14). */
export function remoteHost(url: string): string | null {
  const parts = urlParts(url) ?? scpLike(url);
  return parts === null || parts.host === "" ? null : parts.host.toLowerCase();
}
