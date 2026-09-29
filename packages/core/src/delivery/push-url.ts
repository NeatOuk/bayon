import { err, ok, type Result } from "../errors.js";

// Where a repo's delivered work is pushed (`repos.push_url`, migration 039), pure. A folder project
// fetches from the folder, but its finished work belongs on the remote the folder itself works
// against — its `origin`. This decides what such a target may look like, and takes a credential out
// of one read from a folder before anything else sees it.
//
// The three spellings forgeRemote (remote.ts) understands, and nothing else:
//   https://<host>/<path>
//   ssh://[<login>@]<host>[:<port>]/<path>
//   <login>@<host>:<path>                      (scp-like, which is not a URL)
//
// Userinfo is refused wherever it could hold a secret (§14): any user or password on https, where a
// token is commonly pasted as the user; a password on ssh://; a `user:password@` on scp-like. An ssh
// login name (`git@`) is not a credential — refusing it would refuse every ordinary ssh remote.

/** The longest target accepted: far past any real remote, short of a pasted document. */
const MAX_LENGTH = 2_000;

/** `<scheme>://<authority><rest>`, for the two URL schemes a target may use. */
const URL_SHAPE = /^(https|ssh):\/\/([^/?#\s]*)([^\s]*)$/i;

/** Any `<scheme>://<authority><rest>`: what the strip reads, so no scheme keeps a credential. */
const ANY_URL_SHAPE = /^([a-z][a-z0-9+.-]*):\/\/([^/?#\s]*)([^\s]*)$/i;

/** `<userinfo>@<host>:<path>`: scp-like. The userinfo holds no `/` or `@`; the host no `:`. */
const SCP_SHAPE = /^([^/@\s]+)@([^/:@\s]+):([^\s]+)$/;

/**
 * An ssh login: a plain name, never starting with `-` (M8.1 review, MEDIUM 2). ssh reads a login
 * that starts with `-` as an option — `-oProxyCommand=…@host` runs a command — so the shape rule
 * refuses it here rather than trusting git's own guard to catch it downstream.
 */
const LOGIN = /^[a-z0-9_][a-z0-9._-]*$/i;

/** A host: letters, digits, dots and dashes, or a bracketed IPv6 literal. */
const HOST = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:.]+\])$/i;

const invalid = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

const refusedShape = (url: string): Result<never> =>
  invalid(
    `push target ${JSON.stringify(url)} must be an https://, ssh:// or git@host:path URL.`,
  );

const refusedLogin = (url: string): Result<never> =>
  invalid(
    `push target ${JSON.stringify(url)} has an ssh login that is not a plain name (letters, digits, ".", "_" or "-", not starting with "-").`,
  );

const CREDENTIAL =
  "a push target must not carry credentials (user:password@): store the forge token in the host secret store instead.";

/** `authority` split at its last `@`: the userinfo (null when none) and the host with its port. */
function splitAuthority(authority: string): {
  readonly userinfo: string | null;
  readonly hostPort: string;
} {
  const at = authority.lastIndexOf("@");
  return at < 0
    ? { userinfo: null, hostPort: authority }
    : { userinfo: authority.slice(0, at), hostPort: authority.slice(at + 1) };
}

/** `hostPort` without a trailing `:<digits>`; null when what is left is not a host. */
function hostOf(hostPort: string): string | null {
  const host = hostPort.replace(/:\d{1,5}$/, "");
  return HOST.test(host) ? host : null;
}

/** A URL target's checks: a host, a path, and no userinfo that could be a secret. */
function checkUrl(
  url: string,
  scheme: string,
  authority: string,
  rest: string,
): Result<string> {
  const { userinfo, hostPort } = splitAuthority(authority);
  const https = scheme.toLowerCase() === "https";
  if (userinfo !== null && (https || userinfo.includes(":"))) {
    return invalid(CREDENTIAL);
  }
  if (userinfo !== null && !LOGIN.test(userinfo)) return refusedLogin(url);
  if (hostOf(hostPort) === null) return refusedShape(url);
  if (rest.replace(/\/+$/, "") === "") return refusedShape(url);
  return ok(url);
}

/**
 * `url` trimmed, when it is a push target this project may record; otherwise a one-sentence
 * `validation` error naming what is wrong with it. Never throws.
 */
export function checkPushUrl(url: string): Result<string> {
  const trimmed = url.trim();
  if (trimmed === "") return invalid("a push target cannot be empty.");
  if (trimmed.length > MAX_LENGTH) {
    return invalid(`a push target is at most ${MAX_LENGTH} characters.`);
  }
  const asUrl = URL_SHAPE.exec(trimmed);
  if (asUrl !== null) {
    const [, scheme, authority, rest] = asUrl as unknown as [
      string,
      string,
      string,
      string,
    ];
    return checkUrl(trimmed, scheme, authority, rest);
  }
  const scp = SCP_SHAPE.exec(trimmed);
  if (scp !== null && !trimmed.includes("://")) {
    const [, login, host, path] = scp as unknown as [
      string,
      string,
      string,
      string,
    ];
    if (login.includes(":")) return invalid(CREDENTIAL);
    if (!LOGIN.test(login)) return refusedLogin(trimmed);
    // A path starting with `-` would reach the remote's shell as an option, not a path.
    if (!HOST.test(host) || path.startsWith("-")) return refusedShape(trimmed);
    return ok(trimmed);
  }
  return refusedShape(trimmed);
}

export interface StrippedPushUrl {
  /** `url` with every credential this module refuses taken out; otherwise exactly as given. */
  readonly url: string;
  /** True when something was taken out. */
  readonly stripped: boolean;
}

/**
 * `url` with the userinfo `checkPushUrl` refuses removed, spelled as it was given otherwise: ssh://
 * and scp-like lose a password and keep their login; every other `scheme://` URL loses its whole
 * userinfo, so even a target `checkPushUrl` will go on to refuse can be named in a warning safely.
 * Anything else (a path) comes back unchanged.
 *
 * String surgery on purpose: `new URL(…).toString()` re-normalises a URL, and the owner's own
 * spelling is what they will recognise in the settings.
 */
export function stripPushUrlCredentials(url: string): StrippedPushUrl {
  const trimmed = url.trim();
  const asUrl = ANY_URL_SHAPE.exec(trimmed);
  if (asUrl !== null) {
    const [, scheme, authority, rest] = asUrl as unknown as [
      string,
      string,
      string,
      string,
    ];
    const { userinfo, hostPort } = splitAuthority(authority);
    if (userinfo === null) return { url: trimmed, stripped: false };
    if (scheme.toLowerCase() !== "ssh") {
      return { url: `${scheme}://${hostPort}${rest}`, stripped: true };
    }
    const colon = userinfo.indexOf(":");
    if (colon < 0) return { url: trimmed, stripped: false };
    const login = userinfo.slice(0, colon);
    const kept = login === "" ? hostPort : `${login}@${hostPort}`;
    return { url: `${scheme}://${kept}${rest}`, stripped: true };
  }
  const scp = SCP_SHAPE.exec(trimmed);
  if (scp === null) return { url: trimmed, stripped: false };
  const [, userinfo, host, path] = scp as unknown as [
    string,
    string,
    string,
    string,
  ];
  const colon = userinfo.indexOf(":");
  if (colon < 0) return { url: trimmed, stripped: false };
  return {
    url: `${userinfo.slice(0, colon)}@${host}:${path}`,
    stripped: true,
  };
}

/** Where a repo's delivered work goes: its push target when it has one, else its origin. */
export function pushTargetOf(repo: {
  readonly push_url: string | null;
  readonly origin_url: string | null;
}): string | null {
  const push = repo.push_url?.trim() ?? "";
  return push === "" ? repo.origin_url : push;
}
