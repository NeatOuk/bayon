// The API's one scrub (extracted for): a message the API keeps or returns
// never names a secret it holds, in any form it could have been written in — raw, base64 (as a
// Basic header or SMTP AUTH carries it), base64url, or %-encoded (as a URL carries it). The Jira
// client scrubs its token and Basic pair with it; the notifier its three destinations.

const REDACTED = "<redacted>";

/** Every form `secret` could reach a message in. */
function formsOf(secret: string): string[] {
  const bytes = Buffer.from(secret, "utf8");
  const b64 = bytes.toString("base64");
  return [
    secret,
    b64,
    b64.replace(/=+$/, ""),
    bytes.toString("base64url"),
    encodeURIComponent(secret),
  ];
}

/** `message` with every form of every secret replaced, the longest first. */
export function scrubSecrets(
  message: string,
  secrets: readonly string[],
): string {
  const forms = [
    ...new Set(secrets.filter((s) => s.length > 0).flatMap(formsOf)),
  ]
    .filter((f) => f.length > 0)
    .toSorted((a, b) => b.length - a.length);
  return forms.reduce((m, f) => m.replaceAll(f, REDACTED), message);
}

/**
 * The parts of a URL that are secret on their own: the whole of it (with and without its userinfo,
 * which is what `fetch` sees), its password and `user:pass` pair (and SMTP AUTH PLAIN's
 * `\0user\0pass`), and its path with the query: an ntfy topic or a Slack webhook's path *is* the
 * credential. The host alone is not scrubbed.
 */
export function urlSecretParts(raw: string): string[] {
  if (!URL.canParse(raw)) return [raw];
  const url = new URL(raw);
  const parts = [raw, url.href];
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  if (url.password !== "" || url.username !== "") {
    const user = decode(url.username);
    const pass = decode(url.password);
    parts.push(
      url.password,
      pass,
      `${url.username}:${url.password}`,
      `${user}:${pass}`,
      `\0${user}\0${pass}`,
      `${user}\0${pass}`,
    );
    const bare = new URL(raw);
    bare.username = "";
    bare.password = "";
    parts.push(bare.href);
  }
  const tail = `${url.pathname}${url.search}`;
  if (tail.length > 1) parts.push(tail, tail.slice(1));
  return parts.filter((p) => p.length > 0);
}
