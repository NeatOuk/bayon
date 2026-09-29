import {
  NOTIFY_BASE_URL_KEY,
  NOTIFY_CHANNELS,
  NOTIFY_EMAIL_FROM_KEY,
  NOTIFY_EMAIL_TO_KEY,
  NOTIFY_POLL_KEY,
  NOTIFY_QUIET_END_KEY,
  NOTIFY_QUIET_START_KEY,
  NotifyBaseUrl,
  NotifyEmail,
  OPERATOR_SETTINGS,
  notifyEnabledKey,
  notifyEventsKey,
  operatorSettingSchema,
  type NotifyChannel,
  type OperatorSettingKey,
  type QuietHours,
} from "@bayon/core";
import { getSettings, type Db } from "@bayon/db";
import type { z } from "zod";

// The notifier's settings, read each tick: an operator's change applies from the next.
// A value that does not pass its schema is read as its default — every channel's default is off —
// and named in `problems`, which the notifier logs when they change.

export interface ChannelSettings {
  readonly enabled: boolean;
  /** Bits of core NOTIFY_EVENT_KINDS. */
  readonly events: number;
}

export interface NotifySettings {
  readonly pollMs: number;
  readonly channels: Readonly<Record<NotifyChannel, ChannelSettings>>;
  readonly quiet: QuietHours;
  /** "" is unset. */
  readonly emailTo: string;
  readonly emailFrom: string;
  readonly baseUrl: string;
}

export interface LoadedSettings {
  readonly settings: NotifySettings;
  /** The keys read as their default because their value did not pass. */
  readonly problems: readonly string[];
}

const NUMERIC_KEYS = [
  NOTIFY_POLL_KEY,
  NOTIFY_QUIET_START_KEY,
  NOTIFY_QUIET_END_KEY,
  ...NOTIFY_CHANNELS.flatMap((c) => [notifyEnabledKey(c), notifyEventsKey(c)]),
] as const satisfies readonly OperatorSettingKey[];
const STRING_KEYS = [
  NOTIFY_EMAIL_TO_KEY,
  NOTIFY_EMAIL_FROM_KEY,
  NOTIFY_BASE_URL_KEY,
] as const;
export const NOTIFY_SETTING_KEYS: readonly string[] = [
  ...NUMERIC_KEYS,
  ...STRING_KEYS,
];

const STRING_SCHEMA: Readonly<
  Record<(typeof STRING_KEYS)[number], z.ZodType<string>>
> = {
  [NOTIFY_EMAIL_TO_KEY]: NotifyEmail,
  [NOTIFY_EMAIL_FROM_KEY]: NotifyEmail,
  [NOTIFY_BASE_URL_KEY]: NotifyBaseUrl,
};

/** Each setting at its default: every channel off. */
export function defaultNotifySettings(): NotifySettings {
  return settingsFrom(new Map(), []);
}

function settingsFrom(
  rows: ReadonlyMap<string, unknown>,
  problems: string[],
): NotifySettings {
  const num = (key: (typeof NUMERIC_KEYS)[number]): number => {
    const def = OPERATOR_SETTINGS[key];
    if (!rows.has(key)) return def.default;
    const parsed = operatorSettingSchema(def).safeParse(rows.get(key));
    if (parsed.success) return parsed.data;
    problems.push(key);
    return def.default;
  };
  const text = (key: (typeof STRING_KEYS)[number]): string => {
    if (!rows.has(key)) return "";
    const parsed = STRING_SCHEMA[key].safeParse(rows.get(key));
    if (parsed.success) return parsed.data;
    problems.push(key);
    return "";
  };
  const channel = (c: NotifyChannel): ChannelSettings => ({
    enabled: num(notifyEnabledKey(c)) === 1,
    events: num(notifyEventsKey(c)),
  });
  return {
    pollMs: num(NOTIFY_POLL_KEY),
    channels: {
      mac: channel("mac"),
      ntfy: channel("ntfy"),
      webhook: channel("webhook"),
      email: channel("email"),
    },
    quiet: {
      start: num(NOTIFY_QUIET_START_KEY),
      end: num(NOTIFY_QUIET_END_KEY),
    },
    emailTo: text(NOTIFY_EMAIL_TO_KEY),
    emailFrom: text(NOTIFY_EMAIL_FROM_KEY),
    baseUrl: text(NOTIFY_BASE_URL_KEY),
  };
}

/** The settings now; unreadable rows are the defaults (every channel off), named in `problems`. */
export async function loadNotifySettings(db: Db): Promise<LoadedSettings> {
  const rows = await getSettings(db, NOTIFY_SETTING_KEYS);
  if (!rows.ok) {
    return {
      settings: defaultNotifySettings(),
      problems: [`the notify settings are unreadable (${rows.error.message})`],
    };
  }
  const problems: string[] = [];
  const settings = settingsFrom(rows.value, problems);
  return { settings, problems };
}

/** The email channel's recipient and sender, read at each send ("" unset). */
export async function mailParties(
  db: Db,
): Promise<{ readonly to: string; readonly from: string }> {
  const { settings } = await loadNotifySettings(db);
  return { to: settings.emailTo, from: settings.emailFrom };
}
