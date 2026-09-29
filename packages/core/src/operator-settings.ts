// The operator's tunable settings (§4 config over code; M4 §12.1 GET/PUT /settings): a
// closed whitelist of the M4 settings, each with the bounds its value must keep, its seeded
// default (012, 013) and what a GUI input says about it. Every bound here sits inside what the
// setting's reader accepts, so a value PUT through the API can never stop admission, the
// reconciler, the health check or the backup job from reading its settings.
//
// Not here, on purpose: `fleet.paused` (its own audited doors, POST /fleet/pause|resume),
// `budget.daily_cap_usd` (PUT /settings/budget, then M4-c's /budgets), and the two security
// controls, `executors.untrusted_roles` (the host's isolation boundary) and
// `admission.require_certified` (off, an uncertified runner runs unattended): they stay shell-only
// (seeded-settings.ts), since the GUI can be served on the LAN with the operator's bearer added by
// its proxy.
import { z } from "zod";
import { err, ok, type Result } from "./errors.js";
import { QA_CI_GRACE_DEFAULT_MS } from "./gates/ci.js";
import { ALL_NOTIFY_EVENTS } from "./notify/kinds.js";

/** `mask` is a set of flags as bits (a channel's event kinds, core NOTIFY_EVENT_KINDS). */
export type OperatorSettingUnit =
  "ms" | "percent" | "count" | "hour" | "flag" | "mask";

export const OPERATOR_SETTING_GROUPS = [
  "admission",
  "watchdog",
  "reconciler",
  "worktree",
  "executor",
  "backup",
  "jira",
  "notify",
  "qa",
  "runners",
] as const;
export type OperatorSettingGroup = (typeof OPERATOR_SETTING_GROUPS)[number];

export interface OperatorSettingDef {
  readonly group: OperatorSettingGroup;
  readonly unit: OperatorSettingUnit;
  readonly label: string;
  readonly help: string;
  readonly min: number;
  readonly max: number;
  /** Whole numbers only; a percentage may be fractional. */
  readonly int: boolean;
  /** The value the migrations seed. */
  readonly default: number;
  /** 0 is also accepted, below `min`, and means off (the Jira mirror's two intervals). */
  readonly offAtZero?: true;
}

const MIN = 60_000;
const DAY = 86_400_000;

/** A channel's switch: off by default. */
function notifyFlag(label: string, help: string) {
  return {
    group: "notify",
    unit: "flag",
    label,
    help,
    min: 0,
    max: 1,
    int: true,
    default: 0,
  } as const satisfies OperatorSettingDef;
}

/** A channel's events, as bits of core NOTIFY_EVENT_KINDS; every kind by default. */
function notifyEvents(label: string) {
  return {
    group: "notify",
    unit: "mask",
    label,
    help: "Which events this channel sends, as a sum of bits: question 1, staffing proposal 2, ready for QA 4, blocked 8, Jira sync failed 16, budget warning 32, attention 64.",
    min: 0,
    max: ALL_NOTIFY_EVENTS,
    int: true,
    default: ALL_NOTIFY_EVENTS,
  } as const satisfies OperatorSettingDef;
}

export const OPERATOR_SETTINGS = {
  "admission.recheck_ms": {
    group: "admission",
    unit: "ms",
    label: "Queue recheck",
    help: "How often a queued spawn is checked again; a resume admits within this.",
    min: 500,
    max: 10 * MIN,
    int: true,
    default: 5_000,
  },
  "admission.disk_min_free_pct": {
    group: "admission",
    unit: "percent",
    label: "Minimum free disk",
    help: "An executor with less free disk than this queues new spawns (disk) and fails its health check.",
    min: 0,
    max: 50,
    int: false,
    default: 10,
  },
  "watchdog.silent_ms": {
    group: "watchdog",
    unit: "ms",
    label: "Silent session probe",
    help: "A session silent this long is probed.",
    min: MIN,
    max: DAY,
    int: true,
    default: 30 * MIN,
  },
  "watchdog.retry_storm_count": {
    group: "watchdog",
    unit: "count",
    label: "Retry storm failures",
    help: "This many runner_error failures of one runner on one executor within the window close admission for that pair.",
    min: 1,
    max: 100,
    int: true,
    default: 5,
  },
  "watchdog.retry_storm_window_ms": {
    group: "watchdog",
    unit: "ms",
    label: "Retry storm window",
    help: "The window those failures fall within.",
    min: 1_000,
    max: DAY,
    int: true,
    default: 10 * MIN,
  },
  "watchdog.retry_storm_backoff_ms": {
    group: "watchdog",
    unit: "ms",
    label: "Retry storm backoff",
    help: "How long a retry storm keeps admission closed for that pair.",
    min: 0,
    max: DAY,
    int: true,
    default: 15 * MIN,
  },
  "watchdog.circuit_failed_runs": {
    group: "watchdog",
    unit: "count",
    label: "Circuit breaker",
    help: "Failed runs after which a ticket is blocked and a human is asked.",
    min: 1,
    max: 100,
    int: true,
    default: 3,
  },
  "reconciler.command_requeue_ms": {
    group: "reconciler",
    unit: "ms",
    label: "Command requeue after",
    help: "A claimed command no handler holds this long is requeued (idempotent handlers only).",
    min: MIN,
    max: DAY,
    int: true,
    default: 5 * MIN,
  },
  "reconciler.command_max_attempts": {
    group: "reconciler",
    unit: "count",
    label: "Command attempts",
    help: "Claims one command gets before it is failed.",
    min: 1,
    max: 20,
    int: true,
    default: 3,
  },
  "worktree.recheck_ms": {
    group: "worktree",
    unit: "ms",
    label: "Worktree sweep",
    help: "How often worktrees are swept: a dirty one is kept and flagged, a clean merged one removed.",
    min: MIN,
    max: DAY,
    int: true,
    default: 60 * MIN,
  },
  "executor.clock_skew_max_ms": {
    group: "executor",
    unit: "ms",
    label: "Maximum clock skew",
    help: "An executor whose clock is off by more than this, either way, fails its health check.",
    min: 100,
    max: 10 * MIN,
    int: true,
    default: 5_000,
  },
  "backup.enabled": {
    group: "backup",
    unit: "flag",
    label: "Nightly backup",
    help: "Take the encrypted nightly backup; event retention runs only after a good one.",
    min: 0,
    max: 1,
    int: true,
    default: 1,
  },
  "backup.at_utc_hour": {
    group: "backup",
    unit: "hour",
    label: "Backup hour (UTC)",
    help: "The hour, UTC, the nightly backup starts.",
    min: 0,
    max: 23,
    int: true,
    default: 3,
  },
  "backup.keep": {
    group: "backup",
    unit: "count",
    label: "Backups kept",
    help: "The newest this many encrypted backups are kept; older ones are removed.",
    min: 1,
    max: 1_000,
    int: true,
    default: 14,
  },
  "jira.sync_interval_ms": {
    group: "jira",
    unit: "ms",
    label: "Jira sync interval",
    help: "How often each project with a Jira source mirrors its issues; 0 turns the timer off (the Sync button still works).",
    min: MIN,
    max: DAY,
    int: true,
    default: 15 * MIN,
    offAtZero: true,
  },
  // between full syncs, a quick pass reads only the issues changed since the last pass.
  "jira.quick_interval_ms": {
    group: "jira",
    unit: "ms",
    label: "Jira quick sync interval",
    help: "How often each project with a Jira source picks up the issues changed since the last pass. It files and updates tickets but never parks one; that waits for the full sync. 0 turns it off.",
    min: MIN,
    max: DAY,
    int: true,
    default: MIN,
    offAtZero: true,
  },
  // CI checks as QA: how long a CI gate waits for the first check before it decides the
  // CI is not coming. A project's own wait for the checks to finish is its `qa_ci_timeout_ms`.
  "qa.ci_grace_ms": {
    group: "qa",
    unit: "ms",
    label: "CI first-check grace",
    help: "A QA gate that waits on CI decides reviewer_error if no check at all is reported on the pull request within this.",
    min: MIN,
    max: 120 * MIN,
    int: true,
    default: QA_CI_GRACE_DEFAULT_MS,
  },
  // Notifications. Every channel starts off: the GUI asks the operator to turn one on.
  // Where each channel sends is in the host secret store, never here (§14 amendment).
  "notify.poll_ms": {
    group: "notify",
    unit: "ms",
    label: "Notification check",
    help: "How often new questions, proposals, blocks and other moments are looked for and due notifications sent.",
    min: 5_000,
    max: 10 * MIN,
    int: true,
    default: 15_000,
  },
  "notify.mac.enabled": notifyFlag(
    "Mac notifications",
    "Show notifications in this Mac's Notification Center.",
  ),
  "notify.mac.events": notifyEvents("Mac events"),
  "notify.ntfy.enabled": notifyFlag(
    "ntfy notifications",
    "Publish notifications to the ntfy topic stored as NOTIFY_NTFY_URL.",
  ),
  "notify.ntfy.events": notifyEvents("ntfy events"),
  "notify.webhook.enabled": notifyFlag(
    "Webhook notifications",
    "POST notifications to the webhook (or Slack) URL stored as NOTIFY_WEBHOOK_URL.",
  ),
  "notify.webhook.events": notifyEvents("Webhook events"),
  "notify.email.enabled": notifyFlag(
    "Email notifications",
    "Mail notifications through the SMTP server stored as NOTIFY_SMTP_URL, to notify.email.to.",
  ),
  "notify.email.events": notifyEvents("Email events"),
  "notify.quiet_start_hour": {
    group: "notify",
    unit: "hour",
    label: "Quiet hours start",
    help: "Local hour quiet hours start; -1 is off. ntfy, webhook and email wait until they end; Mac notifications do not.",
    min: -1,
    max: 23,
    int: true,
    default: -1,
  },
  "notify.quiet_end_hour": {
    group: "notify",
    unit: "hour",
    label: "Quiet hours end",
    help: "Local hour quiet hours end, when held notifications go out; -1 is off.",
    min: -1,
    max: 23,
    int: true,
    default: -1,
  },
  // The runner update check: a fixed unauthenticated GET of each adapter's own package
  // on npm, at boot and on this schedule; it never upgrades anything.
  "runners.update_check_hours": {
    group: "runners",
    unit: "hour",
    label: "Runner update check",
    help: "How often each runner's package is checked against npm for a newer release; 0 turns it off.",
    min: 1,
    max: 168,
    int: true,
    default: 24,
    offAtZero: true,
  },
} as const satisfies Readonly<Record<string, OperatorSettingDef>>;

export type OperatorSettingKey = keyof typeof OPERATOR_SETTINGS;

/** The whitelist, in the order the GUI shows it. */
export const OPERATOR_SETTING_KEYS = Object.keys(
  OPERATOR_SETTINGS,
) as readonly OperatorSettingKey[];

export const OperatorSettingKey = z.enum(OPERATOR_SETTING_KEYS);

export const isOperatorSettingKey = (key: string): key is OperatorSettingKey =>
  Object.hasOwn(OPERATOR_SETTINGS, key);

/** The schema a value of `def` must pass: 0 or 1 for a flag, else a number within its bounds. */
export function operatorSettingSchema(
  def: OperatorSettingDef,
): z.ZodType<number> {
  if (def.unit === "flag") return z.union([z.literal(0), z.literal(1)]);
  const bounded = (def.int ? z.int() : z.number()).min(def.min).max(def.max);
  return def.offAtZero === true ? z.union([z.literal(0), bounded]) : bounded;
}

const patchShape = Object.fromEntries(
  OPERATOR_SETTING_KEYS.map((key) => [
    key,
    operatorSettingSchema(OPERATOR_SETTINGS[key]).optional(),
  ]),
) as { readonly [K in OperatorSettingKey]: z.ZodOptional<z.ZodType<number>> };

/** `PUT /settings`' map: whitelisted keys only (any other is refused), at least one. */
export const OperatorSettingsPatch = z
  .strictObject(patchShape)
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "name at least one setting",
  });
export type OperatorSettingsPatch = z.infer<typeof OperatorSettingsPatch>;

/** One key and value checked against the whitelist: unknown or out of bounds is `validation`. */
export function checkOperatorSetting(
  key: string,
  value: unknown,
): Result<{ readonly key: OperatorSettingKey; readonly value: number }> {
  if (!isOperatorSettingKey(key)) {
    return err({
      class: "validation",
      message: `${key} is not an operator setting; the tunable keys are ${OPERATOR_SETTING_KEYS.join(", ")}`,
      retryable: false,
    });
  }
  const parsed = operatorSettingSchema(OPERATOR_SETTINGS[key]).safeParse(value);
  return parsed.success
    ? ok({ key, value: parsed.data })
    : err({
        class: "validation",
        message: `${key}: ${z.prettifyError(parsed.error)}`,
        retryable: false,
      });
}
