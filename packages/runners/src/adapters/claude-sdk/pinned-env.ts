// The env a worked-on repository must not choose (the design). A repo's
// own .claude/settings.json (and settings.local.json) may carry an `env` block, and the CLI applies
// it to itself before its first API call: a repo could name the host, the proxy or the TLS trust
// that the session's credential travels over, or have the runtime print it. The CLI applies
// settings env source by source, user, project, local, then --settings (the SDK's inline
// `settings`), then managed policy, so the same names in the inline settings win over the repo's,
// at start and whenever it re-applies settings.
//
// Each value here is what the pinned CLI (2.1.283, as 2.1.269) treats as unset: its env accessor maps "" to
// undefined, and its `process.env.X || …` reads skip "". Two names need a real value instead.
import { err, ok, type Result } from "@bayon/core";
import { frmError } from "../../errors.js";

/** The CLI's own default API, spelled out: a few of its readers test `!== undefined`, not "". */
export const DEFAULT_BASE_URL = "https://api.anthropic.com";

/**
 * The names the inline settings pin, with the value each gets when the session env does not set
 * it. Where the session env does, the operator's value is pinned instead, so a configured base URL
 * or an executor's egress proxy keeps working and the repo cannot change it.
 *
 * Not here, and why (the spike has the evidence): ANTHROPIC_UNIX_SOCKET, which the CLI refuses from
 * every settings source itself; CLAUDE_CODE_CUSTOM_OAUTH_URL, refused from project scope and bound
 * to an approved list; the OAuth environment switches, which this build hardwires to prod; the host
 * CA-store selectors (NODE_OPTIONS, SSL_CERT_*, CLAUDE_CODE_CERT_STORE), which need an on-path
 * position a repo cannot get once destination and proxies are pinned; client certificates;
 * SSLKEYLOGFILE and the CLI's own debug switches, which print no credential on this build.
 */
export const PINNED_ENV: Readonly<Record<string, string>> = {
  // Where the API calls go.
  ANTHROPIC_BASE_URL: DEFAULT_BASE_URL,
  CLAUDE_CODE_API_BASE_URL: "",
  _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "",
  // Which provider serves them: every switch off, and each provider's endpoint at its default.
  CLAUDE_CODE_USE_BEDROCK: "",
  CLAUDE_CODE_USE_VERTEX: "",
  CLAUDE_CODE_USE_FOUNDRY: "",
  CLAUDE_CODE_USE_ANTHROPIC_AWS: "",
  CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: "",
  CLAUDE_CODE_USE_MANTLE: "",
  CLAUDE_CODE_USE_GATEWAY: "",
  ANTHROPIC_BEDROCK_BASE_URL: "",
  ANTHROPIC_VERTEX_BASE_URL: "",
  ANTHROPIC_FOUNDRY_BASE_URL: "",
  ANTHROPIC_AWS_BASE_URL: "",
  ANTHROPIC_GOOGLE_CLOUD_BASE_URL: "",
  ANTHROPIC_BEDROCK_MANTLE_BASE_URL: "",
  // The route there. Both spellings: process.env is case-sensitive and the CLI reads both.
  HTTPS_PROXY: "",
  https_proxy: "",
  HTTP_PROXY: "",
  http_proxy: "",
  ALL_PROXY: "",
  all_proxy: "",
  NO_PROXY: "",
  no_proxy: "",
  // Who is trusted on it. Verification on is "1": the CLI and node turn it off only for "0".
  NODE_TLS_REJECT_UNAUTHORIZED: "1",
  NODE_EXTRA_CA_CERTS: "",
  // What the runtime prints: its fetch logger writes every request's headers, the credential among
  // them, to stderr, which reaches a takeover's pty log.
  BUN_CONFIG_VERBOSE_FETCH: "",
  // Who the session is. See CREDENTIALS.
  ANTHROPIC_API_KEY: "",
  CLAUDE_CODE_OAUTH_TOKEN: "",
  ANTHROPIC_AUTH_TOKEN: "",
  // Free-form headers: it can carry `x-api-key:` or `authorization:` lines.
  ANTHROPIC_CUSTOM_HEADERS: "",
};

/**
 * Names in PINNED_ENV whose value is a credential. The pins reach the CLI's argv, where no secret
 * goes (Invariant 11), so these are only ever blanked, when the session env holds none: a repo then
 * cannot run the session on its own account. One the operator gave is left out of the pins. With the
 * destination pinned it goes nowhere new; the repo could still swap in its own (the spike's residual).
 */
const CREDENTIALS: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
]);

/**
 * The proxy names come in two spellings, and readers differ on which wins (Bun and Python's urllib
 * take the lower-case one, even empty). One the operator sets alone is pinned in both, so its twin
 * never reaches a reader as "" and switches the proxy off.
 */
const TWIN: Readonly<Record<string, string>> = Object.fromEntries(
  ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"].flatMap((upper) => [
    [upper, upper.toLowerCase()],
    [upper.toLowerCase(), upper],
  ]),
);

/**
 * A user, a password, a query or a fragment in a URL (read the way proxy clients read one written
 * without a scheme): anywhere a credential rides in one. A value the parser refuses counts when it
 * has an `@`, so a malformed URL cannot carry a password past this.
 */
function carriesCredentials(value: string): boolean {
  const url = URL.parse(value.includes("://") ? value : `http://${value}`);
  if (url === null) return value.includes("@");
  return (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  );
}

/**
 * The `env` of the inline settings for a session whose child env is `env`. A value copied from it
 * that may carry a credential in a URL is refused rather than put on argv: the operator moves the
 * credential out of the URL.
 */
export function pinnedEnv(
  env: Readonly<Record<string, string | undefined>>,
): Result<Record<string, string>> {
  const pins: Record<string, string> = {};
  for (const [name, unset] of Object.entries(PINNED_ENV)) {
    const twin = TWIN[name];
    const given = env[name] ?? (twin === undefined ? undefined : env[twin]);
    if (given === undefined) {
      pins[name] = unset;
    } else if (CREDENTIALS.has(name)) {
      continue;
    } else if (carriesCredentials(given)) {
      return err(
        frmError(
          "validation",
          `${name} in the session env may carry a credential in its URL (a user, a password, a ` +
            `query or a fragment); this runner pins ${name} on its command line, where no ` +
            "credential may go. Move the credential out of the URL.",
        ),
      );
    } else {
      pins[name] = given;
    }
  }
  return ok(pins);
}
