// The notifier's three string settings: who is mailed, from whom, and the origin every
// deep link starts with. Each steers where a notification goes or what it links to, and the GUI can
// be served on the LAN with the operator's bearer, so a page there must not redirect them silently
// (§14). an earlier change gives them a second door beside `frm settings set --yes`: `PUT
// /notifications/config` takes these three names and no other, checks each with the schema here,
// audits both values, and tells the address that is losing the mail. The empty string unsets each;
// no row is unset too.
import { z } from "zod";

export const NOTIFY_EMAIL_TO_KEY = "notify.email.to";
export const NOTIFY_EMAIL_FROM_KEY = "notify.email.from";
export const NOTIFY_BASE_URL_KEY = "notify.base_url";

/** RFC 5321's longest path. */
const EMAIL_MAX = 254;
const BASE_URL_MAX = 200;

/** One address (no display name, no list), or "" for unset. */
export const NotifyEmail = z.union([
  z.literal(""),
  z.email("not an email address").max(EMAIL_MAX),
]);

/** `https://host[:port]` or `http://…`, with no user, path, query or fragment; one "/" allowed. */
export function isHttpOrigin(text: string): boolean {
  if (!URL.canParse(text)) return false;
  const url = new URL(text);
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.username === "" &&
    url.password === "" &&
    (text === url.origin || text === `${url.origin}/`)
  );
}

export const NotifyBaseUrl = z.union([
  z.literal(""),
  z
    .string()
    .max(BASE_URL_MAX)
    .refine(
      isHttpOrigin,
      "an http(s) origin with no path, e.g. https://bayon.lan:5173",
    ),
]);

/**
 * What `PUT /notifications/config` may name, and nothing else: three field names of its
 * own rather than the setting keys, so the body can never carry a key the door does not govern.
 */
export const NOTIFY_CONFIG_FIELDS = [
  "email_to",
  "email_from",
  "base_url",
] as const;
export const NotifyConfigField = z.enum(NOTIFY_CONFIG_FIELDS);
export type NotifyConfigField = z.infer<typeof NotifyConfigField>;

/** Each field's `settings` row. */
export const NOTIFY_CONFIG_KEY: Readonly<Record<NotifyConfigField, string>> = {
  email_to: NOTIFY_EMAIL_TO_KEY,
  email_from: NOTIFY_EMAIL_FROM_KEY,
  base_url: NOTIFY_BASE_URL_KEY,
};

/** The schema a field's value must pass — the same one the shell door uses. */
export const NOTIFY_CONFIG_SCHEMA: Readonly<
  Record<NotifyConfigField, z.ZodType<string>>
> = {
  email_to: NotifyEmail,
  email_from: NotifyEmail,
  base_url: NotifyBaseUrl,
};

/** What a field is called wherever a person reads it: a confirm, an alert, an audit row. */
export const NOTIFY_CONFIG_LABEL: Readonly<Record<NotifyConfigField, string>> =
  {
    email_to: "the email recipient",
    email_from: "the email sender",
    base_url: "the link origin",
  };

/** An unset value, as a sentence names it. */
export const shownDestination = (value: string): string =>
  value === "" ? "not set" : value;

/** `PUT /notifications/config`'s body: these three names only, at least one, each checked. */
export const NotifyConfigPatch = z
  .strictObject({
    email_to: NotifyEmail.optional(),
    email_from: NotifyEmail.optional(),
    base_url: NotifyBaseUrl.optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: `name at least one of ${NOTIFY_CONFIG_FIELDS.join(", ")}`,
  });
export type NotifyConfigPatch = z.infer<typeof NotifyConfigPatch>;

/** The three as they stand; "" is unset. */
export const NotifyConfigValues = z.object({
  email_to: z.string(),
  email_from: z.string(),
  base_url: z.string(),
});
export type NotifyConfigValues = z.infer<typeof NotifyConfigValues>;

/** The link a notification sends: the origin, then the GUI's hash path; none without an origin. */
export function notifyLink(
  baseUrl: string,
  linkPath: string | null,
): string | null {
  if (linkPath === null || baseUrl === "" || !isHttpOrigin(baseUrl))
    return null;
  return `${new URL(baseUrl).origin}/${linkPath}`;
}
