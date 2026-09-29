// A moment the notifier found, as the notification it files: its dedupe key, the text
// every channel sends and the GUI hash it links to. Pure: the DB reads hand in plain rows. The key
// is what makes a notification exactly-once — the outbox's UNIQUE refuses a second — so each one is
// built from the source row's own id, or from the standing row and the UTC day.
import { z } from "zod";
import { SYSTEM_REQUEST_KIND } from "../watchdog/requests.js";
import {
  NOTIFY_CONFIG_LABEL,
  shownDestination,
  type NotifyConfigField,
} from "./destinations.js";
import { NotifyEventKind, type NotifyEventKind as Kind } from "./kinds.js";

export const NOTIFY_TITLE_MAX = 200;
export const NOTIFY_BODY_MAX = 1_000;
export const NOTIFY_LINK_MAX = 500;
/** A delivery's kept error, as its CHECK allows. */
export const NOTIFY_ERROR_MAX = 500;
const DEDUPE_KEY_MAX = 300;

/** What the outbox writer takes: every field checked, every text within its cap. */
export const NewNotification = z.object({
  event_kind: NotifyEventKind,
  dedupe_key: z.string().min(1).max(DEDUPE_KEY_MAX),
  workspace_id: z.string().min(1).nullable(),
  ticket_id: z.string().min(1).nullable(),
  title: z.string().min(1).max(NOTIFY_TITLE_MAX),
  body: z.string().max(NOTIFY_BODY_MAX),
  link_path: z
    .string()
    .max(NOTIFY_LINK_MAX)
    .regex(/^#\//, "a GUI hash path, #/…")
    .nullable(),
});
export type NewNotification = z.infer<typeof NewNotification>;

// Control characters but tab and newline: nothing a terminal, a header or a mail body should get.
// eslint-disable-next-line no-control-regex -- the point is to match them
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** `text` without control characters, cut to `max` with an ellipsis, never splitting a pair. */
export function capText(text: string, max: number): string {
  const clean = text.replace(CONTROL, "");
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  const whole = last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
  return `${whole}…`;
}

/** A ticket as a notification names it. */
export interface NotifyTicket {
  readonly id: string;
  /** Its key, e.g. FRM-12 (the settings' prefix and its number). */
  readonly key: string;
  readonly num: number;
  readonly title: string;
  readonly workspace_id: string | null;
}

const enc = encodeURIComponent;

/** The Inbox, the project's when there is one, narrowed to one ticket's requests when named. */
export function inboxLink(
  workspaceId: string | null,
  ticketNum: number | null,
): string {
  const base =
    workspaceId === null ? "#/inbox" : `#/p/${enc(workspaceId)}/inbox`;
  return ticketNum === null ? base : `${base}?ticket=${ticketNum}`;
}

/** One ticket: open in its project's IDE, or the fleet's ticket page. */
export const ticketLink = (t: NotifyTicket): string =>
  t.workspace_id === null
    ? `#/tickets/${t.num}`
    : `#/p/${enc(t.workspace_id)}/tickets?open=ticket:${t.num}`;

/** The UTC day of `now`, e.g. 2026-09-22: the window a standing condition repeats in. */
export const utcDay = (now: number): string =>
  new Date(now).toISOString().slice(0, 10);

function filed(n: {
  readonly event_kind: Kind;
  readonly dedupe_key: string;
  readonly workspace_id: string | null;
  readonly ticket_id: string | null;
  readonly title: string;
  readonly body: string;
  readonly link_path: string | null;
}): NewNotification {
  return {
    ...n,
    // A title is one line on every channel: a header, a subject, a banner's first line.
    title:
      capText(n.title.replace(/[\r\n]+/g, " "), NOTIFY_TITLE_MAX).trim() ||
      n.event_kind,
    body: capText(n.body, NOTIFY_BODY_MAX),
  };
}

const SYSTEM_KINDS: readonly string[] = Object.values(SYSTEM_REQUEST_KIND);
/** Who a system request (the watchdog's) is from, as a title says it. */
export const WATCHDOG_ASKER = "Bayon's watchdog";

/** An open human request, as its row and joins give it. */
export interface RequestMoment {
  readonly id: string;
  readonly kind: string;
  readonly question: string;
  /** The asking session's agent, by name; null for the watchdog's or a request with no session. */
  readonly agent: string | null;
  readonly ticket: NotifyTicket | null;
  /** The ticket's project, else the session's. */
  readonly workspace_id: string | null;
}

/** "<agent> asked on FRM-12", the question below; the watchdog's are its own. */
export function questionNotification(r: RequestMoment): NewNotification {
  const asker = SYSTEM_KINDS.includes(r.kind)
    ? WATCHDOG_ASKER
    : (r.agent ?? "An agent");
  return filed({
    event_kind: "question",
    dedupe_key: `request:${r.id}`,
    workspace_id: r.workspace_id,
    ticket_id: r.ticket?.id ?? null,
    title:
      r.ticket === null
        ? `${asker} asked`
        : `${asker} asked on ${r.ticket.key}`,
    body: r.question,
    link_path: inboxLink(r.workspace_id, r.ticket?.num ?? null),
  });
}

/** A staffing proposal: the question it was filed with says who, as what, on which ticket. */
export function proposalNotification(r: RequestMoment): NewNotification {
  const who = r.agent ?? "The orchestrator";
  return filed({
    event_kind: "staff_proposal",
    dedupe_key: `proposal:${r.id}`,
    workspace_id: r.workspace_id,
    ticket_id: r.ticket?.id ?? null,
    title:
      r.ticket === null
        ? `${who} proposes a staffing`
        : `${who} proposes staffing ${r.ticket.key}`,
    body: r.question,
    link_path: inboxLink(r.workspace_id, r.ticket?.num ?? null),
  });
}

/** A ticket_event that moved a ticket into `qa_human`. */
export interface QaHumanMoment {
  readonly eventId: number;
  readonly ticket: NotifyTicket;
}

export const qaHumanNotification = (m: QaHumanMoment): NewNotification =>
  filed({
    event_kind: "qa_human",
    dedupe_key: `qa_human:${m.eventId}`,
    workspace_id: m.ticket.workspace_id,
    ticket_id: m.ticket.id,
    title: `${m.ticket.key} is ready for your QA`,
    body: m.ticket.title,
    link_path: ticketLink(m.ticket),
  });

/** A `supervisor.block_ticket` audit row, with the request it filed folded in. */
export interface BlockMoment {
  readonly auditId: number;
  readonly ticket: NotifyTicket | null;
  readonly reason: string;
  /** The question of the request the block filed, when it could be read. */
  readonly question: string | null;
}

export function blockNotification(m: BlockMoment): NewNotification {
  const lines = [m.reason, ...(m.question === null ? [] : [m.question])];
  return filed({
    event_kind: "ticket_blocked",
    dedupe_key: `blocked:${m.auditId}`,
    workspace_id: m.ticket?.workspace_id ?? null,
    ticket_id: m.ticket?.id ?? null,
    title:
      m.ticket === null
        ? "A ticket was blocked"
        : `${m.ticket.key} was blocked`,
    body: lines.join("\n"),
    link_path: inboxLink(m.ticket?.workspace_id ?? null, m.ticket?.num ?? null),
  });
}

/** A failed `jira.sync` audit row whose project's sync before it did not fail. */
export interface JiraFailMoment {
  readonly auditId: number;
  readonly workspaceId: string;
  readonly workspaceName: string;
  /** The row's stored error message: already scrubbed of the token and capped by the sync. */
  readonly message: string;
}

export const jiraFailNotification = (m: JiraFailMoment): NewNotification =>
  filed({
    event_kind: "jira_sync_failed",
    dedupe_key: `jira_sync:${m.auditId}`,
    workspace_id: m.workspaceId,
    ticket_id: null,
    title: `The Jira sync of ${m.workspaceName} failed`,
    body: m.message,
    link_path: `#/p/${enc(m.workspaceId)}/overview`,
  });

/** A budget on the `budget_warn` arm. */
export interface BudgetMoment {
  readonly id: string;
  readonly scope: string;
  /** The agent of an agent budget, by name; null for the fleet's. */
  readonly agent: string | null;
  readonly period: string;
  readonly cap_usd: number | null;
  readonly cap_tokens: number | null;
  readonly warn_pct: number;
}

function capsOf(b: BudgetMoment): string {
  const caps = [
    ...(b.cap_usd === null ? [] : [`$${b.cap_usd}`]),
    ...(b.cap_tokens === null ? [] : [`${b.cap_tokens} tokens`]),
  ];
  return caps.length === 0 ? "" : ` of ${caps.join(" / ")}`;
}

export function budgetNotification(
  b: BudgetMoment,
  now: number,
): NewNotification {
  const whose = b.agent === null ? "The fleet's" : `Agent ${b.agent}'s`;
  return filed({
    event_kind: "budget_warn",
    dedupe_key: `budget_warn:${b.id}:${utcDay(now)}`,
    workspace_id: null,
    ticket_id: null,
    title: "A budget passed its warning level",
    body: `${whose} ${b.period} budget${capsOf(b)} is past ${b.warn_pct}% spent.`,
    link_path: "#/spend",
  });
}

/** A human-only attention row (v_needs_attention), budget_warn aside: one row, as the view holds it. */
export interface ArmRow {
  readonly why: string;
  readonly ref: string;
  readonly ticket: NotifyTicket | null;
}

/**
 * The rows of one arm that are one moment. Four unanswered questions on one ticket were
 * four near-identical notifications, because the key carried each row's own `ref`; a ticket now
 * gathers its rows, and an arm with no ticket keeps one moment per ref, so two unhealthy executors
 * stay two.
 */
export interface ArmMoment extends ArmRow {
  /** How many rows stand in this group. */
  readonly count: number;
}

/** What gathers a row: its arm and its ticket, or its arm and its ref when it has none. */
export const armGroup = (r: ArmRow): string =>
  `${r.why}\u0000${r.ticket === null ? r.ref : r.ticket.id}`;

/** One moment per group, in the order each group's first row came; `ref` is that first row's. */
export function groupArms(rows: readonly ArmRow[]): ArmMoment[] {
  const groups = new Map<string, ArmMoment>();
  for (const row of rows) {
    const key = armGroup(row);
    const seen = groups.get(key);
    groups.set(
      key,
      seen === undefined
        ? { ...row, count: 1 }
        : { ...seen, count: seen.count + 1 },
    );
  }
  return [...groups.values()];
}

const on = (t: NotifyTicket | null): string =>
  t === null ? "" : ` on ${t.key}`;

/** Each arm's title; an arm this list does not know still notifies, by its name. */
const ARM_TITLE: Readonly<Record<string, (m: ArmMoment) => string>> = {
  worktree_dirty: (m) =>
    m.count === 1
      ? `A worktree with uncommitted work is kept${on(m.ticket)}`
      : `${m.count} worktrees with uncommitted work are kept${on(m.ticket)}`,
  worktree_kept: (m) =>
    m.count === 1
      ? `A worktree is kept for you to decide${on(m.ticket)}`
      : `${m.count} worktrees are kept for you to decide${on(m.ticket)}`,
  executor_unhealthy: (m) => `Executor ${m.ref} is unhealthy`,
  backup_failed: () => "The last backup failed",
  export_failed: (m) =>
    m.count === 1
      ? `The ${m.ref} export failed${on(m.ticket)}`
      : `${m.count} exports failed${on(m.ticket)}`,
  unanswered_human: (m) =>
    m.count === 1
      ? `A question has waited over a day${on(m.ticket)}`
      : `${m.count} questions have waited over a day${on(m.ticket)}`,
};

const ARM_LINK: Readonly<Record<string, string>> = {
  executor_unhealthy: "#/executors",
  backup_failed: "#/",
};

function armLink(m: ArmMoment): string {
  if (m.why === "unanswered_human")
    return inboxLink(m.ticket?.workspace_id ?? null, m.ticket?.num ?? null);
  const fixed = ARM_LINK[m.why];
  if (fixed !== undefined) return fixed;
  return m.ticket === null ? "#/" : ticketLink(m.ticket);
}

/**
 * The ref a group's key carries: the row's, unless its ticket already names the group. So a fourth
 * question on the same ticket does not mint a new key, and the day's one notification stands.
 */
const armKeyRef = (m: ArmMoment): string => (m.ticket === null ? m.ref : "-");

const unknownArm = (m: ArmMoment): string =>
  m.count === 1
    ? `${m.why} needs you${on(m.ticket)}`
    : `${m.count} ${m.why} need you${on(m.ticket)}`;

export function armNotification(m: ArmMoment, now: number): NewNotification {
  const title = ARM_TITLE[m.why]?.(m) ?? unknownArm(m);
  return filed({
    event_kind: "attention",
    dedupe_key: `attention:${m.why}:${armKeyRef(m)}:${m.ticket?.id ?? "-"}:${utcDay(now)}`,
    workspace_id: m.ticket?.workspace_id ?? null,
    ticket_id: m.ticket?.id ?? null,
    title,
    body: m.ticket === null ? "" : m.ticket.title,
    link_path: armLink(m),
  });
}

/** The GUI screen a change alert points at. */
export const NOTIFY_SETTINGS_LINK = "#/settings/notifications";

/** One of the three destination settings, as `PUT /notifications/config` just changed it. */
export interface DestinationChange {
  readonly field: NotifyConfigField;
  /** The value before; "" was unset. */
  readonly from: string;
  readonly to: string;
  /** The `notify.config` audit row the change wrote: what makes this alert's key its own. */
  readonly auditId: number;
}

/**
 * The alert a destination change files (§14). A bearer holder who redirects the mail or
 * repoints the links cannot do it quietly: this goes on every enabled channel, and the address that
 * is losing the mail is told directly besides (the deliverer's `to` override).
 */
export function destinationChangedNotification(
  c: DestinationChange,
): NewNotification {
  const what = NOTIFY_CONFIG_LABEL[c.field];
  return filed({
    event_kind: "attention",
    dedupe_key: `notify_config:${c.field}:${c.auditId}`,
    workspace_id: null,
    ticket_id: null,
    title: `Bayon's notification settings changed: ${what}`,
    body: [
      `${what} was ${shownDestination(c.from)}. It is now ${shownDestination(c.to)}.`,
      "If this was not you, the change is in the audit log with who made it.",
    ].join("\n"),
    link_path: NOTIFY_SETTINGS_LINK,
  });
}

/** An open `runner_updates` row: a runner's package is newer than what is installed. */
export interface RunnerUpdateMoment {
  readonly runner_id: string;
  readonly current: string;
  readonly latest: string;
}

/**
 * A runner release newer than the installed one. Filed once, ever, per (runner,
 * latest): the key carries no day, so it does not repeat while the item stands. Nothing upgrades
 * anything; the body says the one consequence that matters (redetect: any version bump
 * lapses that runner's certifications).
 */
export const runnerUpdateNotification = (
  m: RunnerUpdateMoment,
): NewNotification =>
  filed({
    event_kind: "attention",
    dedupe_key: `runner_update:${m.runner_id}:${m.latest}`,
    workspace_id: null,
    ticket_id: null,
    title: `${m.runner_id} ${m.current} → ${m.latest} available`,
    body: "Nothing upgrades itself. Bumping it lapses the runner's certifications.",
    link_path: "#/runners",
  });

/** What a test send says: no row, no ticket. */
export const TEST_NOTIFICATION = {
  title: "Bayon test notification",
  body: "Notifications reach you on this channel.",
} as const;
