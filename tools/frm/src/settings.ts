// `frm settings get|set`: the shell door to the governed settings, and the only door
// at all to the two security controls. `admission.require_certified` and
// `executors.untrusted_roles` are kept out of the GUI's whitelist on purpose — the GUI can be
// served on the LAN with the operator's bearer added by its proxy — so they change "only from a
// shell". This is that shell: straight into $FRM_DB (else $FRM_HOME/foreman.db) through
// @bayon/db/operator, checked by the same core schemas PUT /settings uses and audited as the
// operator's with via 'frm'.
//
// A security key prints what the value does and needs --yes, so nobody loosens the isolation
// boundary or the certification rule by typing a number.
// Exit codes: 0 done, 1 refused or unreachable database, 2 bad usage, no $FRM_DB/$FRM_HOME to
// find one in, or --yes missing.
import { parseArgs } from "node:util";
import {
  AGENT_GIT_AUTHOR_KEY,
  err,
  FLEET_PAUSED_KEY,
  GATE_SETTING_KEYS,
  GOVERNED_SETTING_KEYS,
  isGovernedSettingKey,
  isOperatorSettingKey,
  LOCAL_ROOTS_KEY,
  LOGIN_IN_PLACE_KEY,
  LoginInPlace,
  NOTIFY_BASE_URL_KEY,
  NOTIFY_EMAIL_FROM_KEY,
  NOTIFY_EMAIL_TO_KEY,
  ok,
  OPERATOR_SETTINGS,
  PRIVATE_REPO_HOSTS_KEY,
  READS_GRANTED_LOGIN,
  readsGrantedLogin,
  REQUIRE_CERTIFIED_KEY,
  SHELL_ONLY_SETTINGS,
  UNTRUSTED_ROLES_KEY,
  WORK_ROLES,
  type Clock,
  type JsonValue,
  type Result,
} from "@bayon/core";
import { getRunner, getSettings, openDb, type Db } from "@bayon/db";
import { setSettingFromCli, type SettingWrite } from "@bayon/db/operator";
import { dbPathOf } from "./db-path.js";

/** The roles a session is spawned as (core WORK_ROLES): what executors.untrusted_roles may list. */
const ROLES: readonly string[] = WORK_ROLES;

const USAGE_LINE =
  "frm settings get [key] | frm settings set <key> <value> [--yes]";

/**
 * The shell-only settings that are security controls: core's list less the agents' git identity,
 * which is an identity and not a control. Derived rather than listed, so a security key added to
 * core's list needs --yes here from the day it lands instead of being written with no gate
 *; settings.test.ts holds every one of them to an EFFECTS line too.
 */
export const SECURITY_CONTROLS: readonly string[] = Object.keys(
  SHELL_ONLY_SETTINGS,
).filter((key) => key !== AGENT_GIT_AUTHOR_KEY);

/**
 * What a gated key does, printed before it is read or changed. The security controls among them are
 * the ones the GUI shows read-only (apps/web settings/policy-notes.tsx); the notifier's three
 * destinations have an audited GUI door of their own. Every one of them needs --yes here.
 */
const EFFECTS: Readonly<Record<string, string>> = {
  [REQUIRE_CERTIFIED_KEY]:
    "1 refuses a spawn whose runner has not passed certification on its executor; " +
    "0 lets a runner nobody has certified run unattended",
  [UNTRUSTED_ROLES_KEY]:
    "the host's isolation boundary: a role on this list runs only on a trust='untrusted' " +
    "(container) executor, and a role taken off it may run on the trusted host",
  [LOGIN_IN_PLACE_KEY]:
    "consent: a runner named here reads the login file named with it — the one its own CLI " +
    "keeps on this host — instead of a copy in the secret store, and writes the rotated " +
    "credential back to that same file. Bayon reads no login file it was not given here, and " +
    "`none` revokes. Grant only a file you are content for that runner to read and replace, and " +
    "only to a registered runner that can read a login in place: any other is refused",
  [LOCAL_ROOTS_KEY]:
    "the GUI's New project form (POST /projects) accepts a folder as a repo only when its real " +
    "path is inside one of these, and an agent then works on a copy of it. The form can be " +
    "served on the LAN, so allow only folders you are content for anyone who reaches it to hand " +
    "to an agent. `none` revokes; frm project add takes a path without it",
  [PRIVATE_REPO_HOSTS_KEY]:
    "New project and every session read a project's repo from its URL; a URL on this machine " +
    "(localhost, 127.x) or on a private network (10.x, 172.16-31.x, 192.168.x, fc00::/7) is " +
    "refused unless its host is listed here. The form can be served on the LAN, so list only " +
    "your own git servers: anyone who reaches it could point Bayon at them. Link-local and " +
    "cloud metadata addresses are never allowed. `none` revokes",
  [NOTIFY_EMAIL_TO_KEY]:
    "where the notifier mails every notification the email channel sends (agents' questions, " +
    "ticket titles, failures). Set only an address you read; an empty string stops the mail",
  [NOTIFY_EMAIL_FROM_KEY]:
    "the sender the notifier's mail names; empty uses the SMTP login when it is an address. " +
    "The SMTP server itself is NOTIFY_SMTP_URL in the host secret store, never a setting",
  [NOTIFY_BASE_URL_KEY]:
    "the origin every notification's link opens (https://host:port, no path): a phone or a " +
    "mailbox follows it, so name only the GUI you serve. Empty sends no link",
};

const needsYes = (key: string): boolean => SECURITY_CONTROLS.includes(key);

/** The notifier's shell-only strings: seeded empty, which is unset. */
const NOTIFY_STRING_KEYS: readonly string[] = [
  NOTIFY_EMAIL_TO_KEY,
  NOTIFY_EMAIL_FROM_KEY,
  NOTIFY_BASE_URL_KEY,
];

export const SETTINGS_USAGE = [
  `       ${USAGE_LINE}`,
  "settings get: the governed settings and their values, or one key's. A key with no row shows",
  "  the default its reader falls back to.",
  "settings set: one governed setting in $FRM_DB (else $FRM_HOME/foreman.db), checked by the same",
  "  schema as PUT /settings and audited as the operator's (settings.put via frm). A value the key",
  "  already has writes nothing. Refused: fleet.paused (it has frm pause | frm resume) and any key",
  `  no schema governs. The gated keys (${SECURITY_CONTROLS.join(", ")}) print what the`,
  "  value does and need --yes. The GUI shows the security controls read-only, because it can be",
  "  served on the LAN with the operator's bearer; the notifier's three destinations it may change,",
  "  on its Notifications page, where each change is audited and announced.",
  "  projects.local_roots takes the whole list, comma-separated: frm roots adds or removes one folder.",
].join("\n");

const invalid = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

export type SettingsCommand =
  | { readonly action: "get"; readonly key?: string }
  | {
      readonly action: "set";
      readonly key: string;
      readonly value: JsonValue;
      readonly yes: boolean;
    };

/** The gate settings (core GATE_SETTING_KEYS): config, which `frm config apply` writes. */
const GATE_KEYS: readonly string[] = Object.values(GATE_SETTING_KEYS);

/** Named on its own, so the pointer is the command that does it rather than "unknown key". */
function checkKey(key: string): Result<void> {
  if (key === FLEET_PAUSED_KEY) {
    return invalid(
      `${FLEET_PAUSED_KEY} is not set here: pause and resume it with frm pause | frm resume (audited)`,
    );
  }
  // an operator reaching for `settings set gates.base_drift` got "not a governed
  // setting" under the whole usage, with nothing saying where the gate settings are set.
  if (GATE_KEYS.includes(key)) {
    return invalid(
      `${key} is a gate setting: set it with frm config apply <file.json>, the file holding {"settings": {"${key}": <value>}}`,
    );
  }
  return isGovernedSettingKey(key)
    ? ok(undefined)
    : invalid(
        `${key} is not a governed setting; the keys are ${GOVERNED_SETTING_KEYS.join(", ")}`,
      );
}

/**
 * `runners.login_in_place`: `<runner-id>=<absolute path>`, comma-separated, `none` or an empty
 * string revoking every grant. A pair shape rather than JSON, so consent is typed at a shell
 * without quoting braces; core's schema judges the ids and the paths, here and in the writer.
 */
function loginGrantsOf(key: string, raw: string): Result<JsonValue> {
  const text = raw.trim();
  if (text === "" || text === "none") return ok({});
  const grants: Record<string, string> = {};
  for (const entry of text.split(",")) {
    const pair = entry.trim();
    if (pair === "") continue;
    const at = pair.indexOf("=");
    if (at <= 0 || at === pair.length - 1) {
      return invalid(
        `${key}: ${JSON.stringify(pair)} is not <runner-id>=<absolute path>`,
      );
    }
    const runner = pair.slice(0, at).trim();
    if (Object.hasOwn(grants, runner)) {
      return invalid(`${key}: ${JSON.stringify(runner)} is granted twice`);
    }
    grants[runner] = pair.slice(at + 1).trim();
  }
  return ok(grants);
}

/** `projects.local_roots`: absolute folders, comma-separated; `none` or an empty string clears it.
 * Core's schema judges each path, here and in the writer. */
function localRootsOf(raw: string): JsonValue {
  const text = raw.trim();
  if (text === "" || text === "none") return [];
  return [
    ...new Set(
      text
        .split(",")
        .map((root) => root.trim())
        .filter((root) => root !== ""),
    ),
  ];
}

/**
 * A shell string as the key's value: a number for the numeric keys (the GUI's whitelist and the
 * 0|1 certification rule), a comma-separated list for the roles (`none` or an empty string clears
 * it), `<runner-id>=<path>` pairs for the login grants, and otherwise the text itself —
 * `agents.git_author` is `Name <email>`. Core's schema then judges it, here and again in the writer.
 */
export function settingValueOf(key: string, raw: string): Result<JsonValue> {
  if (key === LOGIN_IN_PLACE_KEY) return loginGrantsOf(key, raw);
  if (key === LOCAL_ROOTS_KEY) return ok(localRootsOf(raw));
  // Host names as a URL names them: the same comma list, lower-cased.
  if (key === PRIVATE_REPO_HOSTS_KEY)
    return ok(localRootsOf(raw.toLowerCase()));
  if (key === UNTRUSTED_ROLES_KEY) {
    const text = raw.trim();
    if (text === "" || text === "none") return ok([]);
    const roles = [
      ...new Set(
        text
          .split(",")
          .map((role) => role.trim())
          .filter((role) => role !== ""),
      ),
    ];
    // Checked against the real set here for the pointed message. Core's UntrustedRoles refuses a
    // non-role too, at every door that writes the setting — this one, PUT /settings and
    // `frm config apply` — since a typo does not weaken the isolation boundary but empties it:
    // trustRefusal matches the role exactly, so "REVIEWER" matches nothing.
    const bad = roles.find((role) => !ROLES.includes(role));
    return bad === undefined
      ? ok(roles)
      : invalid(
          `${key}: ${JSON.stringify(bad)} is not a role (${ROLES.join(", ")})`,
        );
  }
  if (isOperatorSettingKey(key) || key === REQUIRE_CERTIFIED_KEY) {
    const n = Number(raw.trim());
    return raw.trim() !== "" && Number.isFinite(n)
      ? ok(n)
      : invalid(`${key} takes a number, not ${JSON.stringify(raw)}`);
  }
  return ok(raw);
}

function readArgs(argv: readonly string[]) {
  try {
    return ok(
      parseArgs({
        args: [...argv],
        allowPositionals: true,
        strict: true,
        options: { yes: { type: "boolean", default: false } },
      }),
    );
  } catch (cause) {
    const why = cause instanceof Error ? cause.message : "bad arguments";
    return invalid(`${why}; usage: ${USAGE_LINE}`);
  }
}

/** `frm settings get|set …`: argv from the command word on. */
export function parseSettingsCli(
  argv: readonly string[],
): Result<SettingsCommand> {
  const args = readArgs(argv);
  if (!args.ok) return args;
  const [word, action, key, value, ...rest] = args.value.positionals;
  if (word !== "settings" || rest.length > 0)
    return invalid(`usage: ${USAGE_LINE}`);
  if (action === "get") {
    if (value !== undefined) return invalid(`usage: ${USAGE_LINE}`);
    if (key === undefined) return ok({ action: "get" });
    const checked = checkKey(key);
    return checked.ok ? ok({ action: "get", key }) : checked;
  }
  if (action !== "set" || key === undefined || value === undefined) {
    return invalid(`usage: ${USAGE_LINE}`);
  }
  const checked = checkKey(key);
  if (!checked.ok) return checked;
  const parsed = settingValueOf(key, value);
  return parsed.ok
    ? ok({
        action: "set",
        key,
        value: parsed.value,
        yes: args.value.values.yes,
      })
    : parsed;
}

export interface SettingsIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock: Clock;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/**
 * What the key falls back to when there is no row: an operator setting's own default, and for the
 * security controls the value the migrations seed (007, 012) — an admission reader treats a
 * missing row as a config error, so what this says is what a fresh database holds.
 * settings.test.ts migrates one and holds these strings to it, since a seed that moved and a line
 * here that did not is a lie an operator would act on.
 */
export function defaultOf(key: string): string {
  if (isOperatorSettingKey(key)) return String(OPERATOR_SETTINGS[key].default);
  if (key === REQUIRE_CERTIFIED_KEY) return "1";
  if (key === UNTRUSTED_ROLES_KEY) return '["investigator"]';
  if (key === LOGIN_IN_PLACE_KEY) return "{}"; // 026: consent granted to nobody
  if (key === LOCAL_ROOTS_KEY) return "[]"; // 027: no folder allowed
  if (key === PRIVATE_REPO_HOSTS_KEY) return "[]"; // no row: no private host allowed
  if (NOTIFY_STRING_KEYS.includes(key)) return '""'; // the notifications migration: unset
  return key === AGENT_GIT_AUTHOR_KEY ? "the built-in agent identity" : "none";
}

const shown = (value: unknown): string =>
  JSON.stringify(value) ?? String(value);

function report(
  key: string,
  rows: ReadonlyMap<string, unknown>,
  out: (line: string) => void,
): void {
  const value = rows.get(key);
  out(
    `${key} = ${value === undefined ? `(not set; default ${defaultOf(key)})` : shown(value)}`,
  );
  const effect = EFFECTS[key];
  if (effect !== undefined) out(`  security control: ${effect}`);
}

/**
 * The --yes gate every door to a security control goes through (`frm settings set`, `frm roots
 * add|remove`): the key's effect and the change are printed before anything is read or written,
 * --yes or not; false (exit 2) when the key is a security control and --yes is missing.
 */
export function securityConsent(
  c: {
    readonly name: string;
    readonly key: string;
    readonly change: string;
    readonly yes: boolean;
  },
  io: Pick<SettingsIo, "out" | "err">,
): boolean {
  if (!needsYes(c.key)) return true;
  io.out(`${c.key}: ${EFFECTS[c.key] ?? ""}`);
  io.out(c.change);
  if (c.yes) return true;
  io.err(
    `${c.name}: ${c.key} is a security control: repeat the command with --yes`,
  );
  return false;
}

/** What a write did, as `frm settings set` and `frm roots` report it. */
export function said(w: SettingWrite): string {
  return w.changed
    ? `${w.key}: ${w.from === null ? "(not set)" : shown(w.from)} -> ${shown(w.to)} (audited: settings.put via frm)`
    : `${w.key}: already ${shown(w.to)}; nothing written`;
}

/**
 * A login grant names only runners that can read one: each must be registered — the
 * supervisor registers its runners at boot — and its row must declare readsGrantedLogin, the fact a
 * spawn reads too. A grant to any other would drop that runner's own credentials and start its
 * sessions with none. The spawn and conformance refuse it regardless; this refuses it at the door,
 * before anything is written. A value that is not a grant map is left to the writer's schema.
 */
async function checkGrantees(db: Db, value: JsonValue): Promise<Result<void>> {
  const grants = LoginInPlace.safeParse(value);
  if (!grants.success) return ok(undefined);
  for (const runnerId of Object.keys(grants.data)) {
    const runner = await getRunner(db, runnerId);
    if (!runner.ok) {
      return runner.error.class === "not_found"
        ? invalid(
            `${LOGIN_IN_PLACE_KEY}: no runner ${runnerId} is registered in this database ` +
              "(the supervisor registers its runners when it starts)",
          )
        : runner;
    }
    if (!readsGrantedLogin(parsedOrNothing(runner.value.defaults_json))) {
      return invalid(
        `${LOGIN_IN_PLACE_KEY}: ${runnerId} cannot read a login in place (its registration does ` +
          `not declare ${READS_GRANTED_LOGIN}); a grant would leave its sessions with no credential`,
      );
    }
  }
  return ok(undefined);
}

/** A runner row's defaults as JSON, or `undefined` when they are not JSON (which reads as "cannot"). */
function parsedOrNothing(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Runs `frm settings get|set`. */
export async function runSettingsCommand(
  cmd: SettingsCommand,
  io: SettingsIo,
): Promise<number> {
  const name = `frm settings ${cmd.action}`;
  if (
    cmd.action === "set" &&
    !securityConsent(
      {
        name,
        key: cmd.key,
        change: `setting it to ${shown(cmd.value)}`,
        yes: cmd.yes,
      },
      io,
    )
  )
    return 2;
  const path = dbPathOf(io.env, "the database the settings are in");
  if (!path.ok) {
    io.err(`${name}: ${path.error.message}`);
    return 2;
  }
  const opened = await openDb({ path: path.value, clock: io.clock });
  if (!opened.ok) {
    io.err(`${name}: ${opened.error.message}`);
    return 1;
  }
  try {
    if (cmd.action === "get") {
      const keys = cmd.key === undefined ? GOVERNED_SETTING_KEYS : [cmd.key];
      const rows = await getSettings(opened.value, keys);
      if (!rows.ok) {
        io.err(`${name}: ${rows.error.message}`);
        return 1;
      }
      for (const key of keys) report(key, rows.value, io.out);
      return 0;
    }
    if (cmd.key === LOGIN_IN_PLACE_KEY) {
      const grantees = await checkGrantees(opened.value, cmd.value);
      if (!grantees.ok) {
        io.err(`${name}: nothing written: ${grantees.error.message}`);
        return 1;
      }
    }
    const set = await setSettingFromCli(opened.value, cmd.key, cmd.value);
    if (!set.ok) {
      io.err(`${name}: nothing written: ${set.error.message}`);
      return 1;
    }
    io.out(said(set.value));
    return 0;
  } finally {
    await opened.value.close();
  }
}
