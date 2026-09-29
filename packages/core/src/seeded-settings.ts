// What frm's operator door (db seedConfig) may seed, and how. A setting the
// operator governs is checked and audited however it is written: a seed of a whitelisted key passes
// the same check as PUT /settings and leaves the same audit row. The security controls are kept out
// of the GUI's whitelist, since a LAN page with the operator's bearer must not loosen them; they
// change only from a shell, and a seed of one is checked and audited too. So does the agents' git
// identity, which the GUI's numeric whitelist cannot hold: a malformed seed of it is
// refused here rather than stopping the supervisor from loading its settings. fleet.paused is never
// seeded: its updated_at is when the fleet last resumed (FleetHold.resumedAt).
import { z } from "zod";
import { ADMISSION_SETTING_KEYS } from "./admission.js";
import { AGENT_GIT_AUTHOR_KEY, AgentGitAuthor } from "./agent-identity.js";
import { err, ok, type Result } from "./errors.js";
import { FLEET_PAUSED_KEY } from "./fleet-pause.js";
import { UNTRUSTED_ROLES_KEY, UntrustedRoles } from "./gates/settings.js";
import { LOGIN_IN_PLACE_KEY, LoginInPlace } from "./login-in-place.js";
import { LOCAL_ROOTS_KEY, LocalRoots } from "./project/local-roots.js";
import {
  PRIVATE_REPO_HOSTS_KEY,
  PrivateRepoHosts,
} from "./project/repo-hosts.js";
import {
  NOTIFY_BASE_URL_KEY,
  NOTIFY_EMAIL_FROM_KEY,
  NOTIFY_EMAIL_TO_KEY,
  NotifyBaseUrl,
  NotifyEmail,
} from "./notify/destinations.js";
import {
  checkOperatorSetting,
  isOperatorSettingKey,
  OPERATOR_SETTING_KEYS,
} from "./operator-settings.js";

/** Off, a runner nobody certified runs unattended (§15): a security control, shell-only. */
export const REQUIRE_CERTIFIED_KEY = ADMISSION_SETTING_KEYS.requireCertified;

/**
 * The settings no numeric whitelist can hold, each with the schema a seeded value must pass: the
 * security controls, the agents' git identity and the notifier's destinations. Shell-only with one
 * exception — the three `notify.*` destinations also have an audited API door of their own,
 * `PUT /notifications/config`, which takes those three names and no other. They stay
 * here because the shell door stays too, and both check with the same schema.
 */
export const SHELL_ONLY_SETTINGS: Readonly<Record<string, z.ZodType>> = {
  [REQUIRE_CERTIFIED_KEY]: z.union([z.literal(0), z.literal(1)]),
  [UNTRUSTED_ROLES_KEY]: UntrustedRoles,
  [LOGIN_IN_PLACE_KEY]: LoginInPlace,
  [LOCAL_ROOTS_KEY]: LocalRoots,
  // The loopback and private hosts a project's repo may be read from.
  [PRIVATE_REPO_HOSTS_KEY]: PrivateRepoHosts,
  [AGENT_GIT_AUTHOR_KEY]: AgentGitAuthor,
  // The notifier's recipient, sender and link origin: strings, and each steers where a
  // notification goes or what it links to. A LAN page may change them only through the door that
  // confirms, audits both values and tells the address being replaced (§14).
  [NOTIFY_EMAIL_TO_KEY]: NotifyEmail,
  [NOTIFY_EMAIL_FROM_KEY]: NotifyEmail,
  [NOTIFY_BASE_URL_KEY]: NotifyBaseUrl,
};

export const isShellOnlySettingKey = (key: string): boolean =>
  Object.hasOwn(SHELL_ONLY_SETTINGS, key);

/**
 * Every setting an operator may set by name, checked wherever it is written: the GUI's whitelist
 * (PUT /settings) and the shell-only ones. `fleet.paused` is deliberately not one — it has its own
 * audited doors (`frm pause` | `frm resume`) — and neither is any key no schema here governs.
 * `frm settings get|set` is the shell door to exactly this list.
 */
export const GOVERNED_SETTING_KEYS: readonly string[] = [
  ...OPERATOR_SETTING_KEYS,
  ...Object.keys(SHELL_ONLY_SETTINGS),
];

export const isGovernedSettingKey = (key: string): boolean =>
  GOVERNED_SETTING_KEYS.includes(key);

/** A governed key is checked, and audited when it changes; any other is written as it comes. */
export type SeededKind = "governed" | "plain";

const invalid = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

/** How a seed of `key` is written, or why it is refused (`validation`). */
export function checkSeededSetting(
  key: string,
  value: unknown,
): Result<SeededKind> {
  if (key === FLEET_PAUSED_KEY) {
    return invalid(
      `${FLEET_PAUSED_KEY} is not seeded: pause and resume it with frm pause | frm resume (audited)`,
    );
  }
  if (isOperatorSettingKey(key)) {
    const checked = checkOperatorSetting(key, value);
    return checked.ok ? ok("governed") : checked;
  }
  if (!isShellOnlySettingKey(key)) return ok("plain");
  const parsed = SHELL_ONLY_SETTINGS[key]?.safeParse(value);
  return parsed?.success === true
    ? ok("governed")
    : invalid(
        `${key}: ${parsed === undefined ? "no schema" : z.prettifyError(parsed.error)}`,
      );
}
