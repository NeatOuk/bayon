// The supervisor's scrub for a forge token: a message this daemon keeps, returns or
// logs never names the token, in any form it could have been written in — raw, base64 (as an
// Authorization header carries it), base64url, or %-encoded (as a URL carries it).
//
// This is the API's `secret-scrub.ts` shape, written here rather than shared because an earlier change owns
// extracting the Jira client's guards into one module; folding the two together is that ticket's.

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
 * A forge token scrubbed out of `message`, in its raw form and in the two shapes an
 * `Authorization` header is built from (`Bearer <token>`, and `x-access-token:<token>` base64'd as
 * a git credential would carry it).
 */
export const scrubToken = (message: string, token: string): string =>
  scrubSecrets(message, [token, `Bearer ${token}`, `x-access-token:${token}`]);

/**
 * The credential parts of a remote URL, for scrubbing git's own messages (security
 * review, MEDIUM 1). `checkOriginUrl` accepts `https://user:token@host/path`, so a project may
 * legally carry a credential in the remote it was created with — and git echoes the remote it
 * could not reach, userinfo and all, in an authentication failure.
 *
 * Only the credential is returned. The host and the path are **not** secrets, and redacting them
 * would leave the operator an error that says nothing about which repository refused them.
 */
export function urlCredentials(raw: string): string[] {
  if (!URL.canParse(raw)) return [];
  const url = new URL(raw);
  if (url.password === "" && url.username === "") return [];
  const decode = (s: string): string => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const user = decode(url.username);
  const pass = decode(url.password);
  return [
    url.password,
    pass,
    `${url.username}:${url.password}`,
    `${user}:${pass}`,
  ].filter((part) => part !== "");
}

/**
 * Every secret a message about one delivery could have picked up: the forge token (in each of the
 * shapes a header or a git credential carries it) and any credential in the recorded remote URL.
 */
export const deliverySecrets = (
  token: string | null,
  remoteUrl: string,
): string[] => [
  ...(token === null
    ? []
    : [token, `Bearer ${token}`, `x-access-token:${token}`]),
  ...urlCredentials(remoteUrl),
];
