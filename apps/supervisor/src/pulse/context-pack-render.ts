// The context pack's sections (§10.1), rendered from its reads as plain markdown lines: the pulse
// template owns every heading. Pure: the same reads and checks give the same text, and every age
// is taken against the pulse's scheduled_at, never the clock. Probe output is fenced (§10.2): an
// untrusted check sits in `<untrusted probe="…">`, and no fenced text holds a `<`, `>` or `"`, so
// nothing inside a fence can close it early or open another.
import { StaffRole, ticketKey, type PromptInputs } from "@bayon/core";
import type {
  ContextPackInputs,
  PackAttentionItem,
  PackCount,
  PackHandoff,
  PackList,
  PulseCheckRow,
} from "@bayon/db";
import { z } from "zod";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A fenced probe result's most characters; the whole of it stays in pulse_checks. */
export const PROBE_BLOCK_CHARS = 1_600;

/** How long before `asOf`: "<1 min", "12 min", "3 h", "2 d". */
export function age(asOf: number, at: number): string {
  const ms = Math.max(0, asOf - at);
  if (ms < MINUTE) return "<1 min";
  if (ms < HOUR) return `${String(Math.floor(ms / MINUTE))} min`;
  if (ms < DAY) return `${String(Math.floor(ms / HOUR))} h`;
  return `${String(Math.floor(ms / DAY))} d`;
}

/** The first `n` characters, never half a surrogate pair. */
function head(text: string, n: number): string {
  const code = text.charCodeAt(n - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}

/** `text` on one line in at most `max` characters; a cut ends in "…". */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${head(flat, max - 1)}…`;
}

const usd = (n: number): string => `$${n.toFixed(2)}`;
const counted = (cs: readonly PackCount[]): string =>
  cs.length === 0
    ? "none"
    : cs.map((c) => `${c.key} ${String(c.n)}`).join(", ");
const shown = (list: PackList<unknown>): string =>
  list.rows.length === list.total
    ? String(list.total)
    : `${String(list.rows.length)} of ${String(list.total)}`;
const onTicket = (num: number | null): string =>
  num === null ? "" : ` · #${String(num)}`;
const cmp = (a: string, b: string): number => Number(a > b) - Number(a < b);

function header(p: ContextPackInputs): string {
  const { budget, pulse, previous } = p;
  const cap =
    budget.daily_cap_usd === null
      ? "no daily cap"
      : `a ${usd(budget.daily_cap_usd)} daily cap, ${usd(Math.max(0, budget.daily_cap_usd - budget.today_usd))} left`;
  const since =
    previous === null
      ? "no pulse ran before this one"
      : age(pulse.scheduled_at, previous.scheduled_at);
  // A project's orchestrator is told which; a fleet one's header is as it always was.
  const project =
    p.project === null
      ? []
      : [`- Project: ${p.project.name} (${p.project.id})`];
  return [
    `- Pulse #${String(p.seq)} for ${p.agent.name} (${pulse.trigger}), scheduled ${new Date(pulse.scheduled_at).toISOString()}`,
    ...project,
    `- Since the last pulse: ${since}`,
    `- Budget: ${usd(budget.today_usd)} spent today; ${cap}`,
    `- Live sessions: ${counted(p.sessions)}`,
    `- Tickets: ${counted(p.ticket_statuses)}`,
  ].join("\n");
}

function subject(i: PackAttentionItem): string {
  if (i.ticket_num === null) return i.ref;
  const ticket = `#${String(i.ticket_num)} ${oneLine(i.ticket_title ?? "", 80)}`;
  return i.ref === i.ticket_id ? ticket : `${i.ref} · ${ticket}`;
}

function attention(p: ContextPackInputs): string | undefined {
  if (p.attention.length === 0) return undefined;
  return p.attention
    .map((g) =>
      [
        `${g.why} (${shown({ total: g.total, rows: g.items })}, newest first):`,
        ...g.items.map((i) => `- ${subject(i)}`),
      ].join("\n"),
    )
    .join("\n\n");
}

/**
 * A ticket waiting on the operator's answers: the pack says so on its line, and the
 * pulse template says what that means (it is not staffed, and its questions are not asked again).
 */
const waiting = (open: number): string =>
  open === 0
    ? ""
    : ` · waiting on ${String(open)} answer${open === 1 ? "" : "s"} from the operator: not staffable until answered`;

function tickets(p: ContextPackInputs): string | undefined {
  const list = p.tickets;
  if (list.total === 0) return undefined;
  const asOf = p.pulse.scheduled_at;
  return [
    `${shown(list)} in flight, most urgent first:`,
    ...list.rows.map((t) => {
      const owner =
        t.owner_agent === null
          ? "unowned"
          : `owner ${t.owner_agent} (${t.owner_role ?? "?"})`;
      const blocked =
        t.blocked_reason === null
          ? ""
          : ` · blocked: ${oneLine(t.blocked_reason, 120)}`;
      const pending = t.handoff_pending
        ? " · hand-off pending: staff a successor"
        : "";
      return `- #${String(t.num)} [${t.status}] ${oneLine(t.title, 80)} · p${String(t.priority)} · ${owner} · age ${age(asOf, t.created_at)}${pending}${waiting(t.open_questions)}${blocked}`;
    }),
  ].join("\n");
}

/** A successor's role when its predecessor's is not one ticket_staff takes (or it has none). */
const FALLBACK_SUCCESSOR_ROLE: StaffRole = "builder";

/**
 * The exact call that staffs a pending hand-off's successor: the ticket by its key, the role its
 * predecessor ran as. Both are checked values (a key_prefix the db validated, a ticket number, a
 * StaffRole), so the call holds no `<`, `>` or `&` and its only `"` are its own.
 */
export function staffCall(
  keyPrefix: string,
  h: Pick<PackHandoff, "ticket_num" | "from_role">,
): string {
  const role = StaffRole.safeParse(h.from_role);
  return `→ ticket_staff ${JSON.stringify({
    ticket: ticketKey(keyPrefix, h.ticket_num),
    role: role.success ? role.data : FALLBACK_SUCCESSOR_ROLE,
  })}`;
}

/**
 * The newest `count` pending hand-offs, each its agent-written text inert, then the call that
 * staffs its successor; then one line counting the ones left out, when any were.
 */
function handoffs(p: ContextPackInputs, count: number): string | undefined {
  const list = p.handoffs;
  if (list.total === 0) return undefined;
  const asOf = p.pulse.scheduled_at;
  const rows = list.rows.slice(0, count);
  const omitted = list.total - rows.length;
  const note =
    omitted === 0
      ? []
      : [
          `${String(omitted)} more pending hand-off${omitted === 1 ? "" : "s"} not shown — staff the ones above first`,
        ];
  return [
    `${shown({ total: list.total, rows })} pending, newest first:`,
    ...rows.flatMap((h) => [
      inert(
        [
          `- #${String(h.ticket_num)} ${oneLine(h.ticket_title, 80)} (${h.quality}, ${age(asOf, h.created_at)} ago): ${oneLine(h.goal_line ?? "no goal line", 200)}`,
          `  next: ${oneLine(h.next_steps_md ?? "none written", 300)}`,
        ].join("\n"),
      ),
      `  ${staffCall(p.key_prefix, h)}`,
    ]),
    ...note,
  ].join("\n");
}

function messages(p: ContextPackInputs): string | undefined {
  const { messages: mail, human_requests: asks } = p;
  if (mail.total === 0 && asks.total === 0) return undefined;
  const asOf = p.pulse.scheduled_at;
  return [
    `Unread messages: ${shown(mail)}`,
    ...mail.rows.map(
      (m) =>
        `- ${age(asOf, m.ts)} ago, from ${m.from_kind} ${m.from_id}${onTicket(m.ticket_num)}: ${oneLine(m.subject, 100)} — ${oneLine(m.body_md, 200)}`,
    ),
    "",
    `Open human requests: ${shown(asks)}`,
    ...asks.rows.map(
      (h) =>
        `- asked ${age(asOf, h.asked_at)} ago${onTicket(h.ticket_num)} (${h.kind}): ${oneLine(h.question, 200)}`,
    ),
  ].join("\n");
}

const Actions = z.array(z.string());

/** pulse_report's actions, one line each; unreadable ones are shown as they are, never dropped. */
function actionLines(json: string | null): string[] {
  if (json === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return [`- (unreadable actions) ${oneLine(json, 200)}`];
  }
  const parsed = Actions.safeParse(value);
  return parsed.success
    ? parsed.data.map((a) => `- ${oneLine(a, 200)}`)
    : [`- (unreadable actions) ${oneLine(json, 200)}`];
}

function lastPulse(p: ContextPackInputs): string | undefined {
  const prev = p.previous;
  if (prev === null) return undefined;
  const actions = actionLines(prev.actions_json);
  return [
    `Pulse ${prev.id} (${prev.trigger}) ended ${prev.state}, scheduled ${age(p.pulse.scheduled_at, prev.scheduled_at)} before this one.`,
    prev.summary_md ?? "It left no report.",
    ...(actions.length === 0 ? [] : ["", "Actions:", ...actions]),
  ].join("\n");
}

function knowledge(p: ContextPackInputs): string | undefined {
  if (p.knowledge.length === 0) return undefined;
  return p.knowledge
    .map(
      (k) =>
        `- ${oneLine(k.title, 100)} (${k.kind}): ${oneLine(k.body_md, 240)}`,
    )
    .join("\n");
}

const Flagged = z.object({ untrusted: z.boolean() });

/** Whether a result says it is untrusted (result_json); an unreadable one does. */
function saysUntrusted(json: string | null): boolean {
  if (json === null) return false;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return true;
  }
  const flagged = Flagged.safeParse(value);
  return flagged.success && flagged.data.untrusted;
}

/**
 * Makes text inert in the pack: NFC first, as compile normalizes, then `&`, `<`, `>` and `"` as
 * entities. Such text holds no tag of any case (`<probe>`, `</untrusted>`, …) and no comment
 * opener, so only the pack's own probe tags are tags. Applied to every section but the probes',
 * whose blocks escape each field themselves, and the hand-offs', whose entries escape their text
 * and add a staffCall; compile then sinks any heading.
 */
export const inert = (text: string): string =>
  text
    .normalize("NFC")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** One check as a block: `<probe>` when trusted, else `<untrusted>`, its body escaped and capped. */
export function probeBlock(check: PulseCheckRow, trusted: boolean): string {
  const lines = [
    `state: ${check.state}${check.duration_ms === null ? "" : `, ${String(check.duration_ms)} ms`}`,
    ...(check.error === null ? [] : [`error: ${check.error}`]),
    ...(check.result_json === null ? [] : [`result: ${check.result_json}`]),
    ...(check.result_path === null
      ? []
      : [`full output: ${check.result_path}`]),
  ];
  const body = inert(lines.join("\n"));
  const capped =
    body.length <= PROBE_BLOCK_CHARS
      ? body
      : `${head(body, PROBE_BLOCK_CHARS)}\n… clipped: the whole result is in pulse_checks`;
  const name = inert(check.name);
  return trusted
    ? `<probe name="${name}">\n${capped}\n</probe>`
    : `<untrusted probe="${name}">\n${capped}\n</untrusted>`;
}

/**
 * The checks as blocks, by probe name then id. A check is trusted only when its probe's row says
 * so (untrusted_output = 0) and its result does not say otherwise.
 */
export function probeBlocks(
  checks: readonly PulseCheckRow[],
  p: ContextPackInputs,
): string[] {
  const flags = new Map(p.probes.map((r) => [r.name, r.untrusted_output]));
  return checks
    .toSorted((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id))
    .map((c) =>
      probeBlock(c, flags.get(c.name) === 0 && !saysUntrusted(c.result_json)),
    );
}

function probes(
  blocks: readonly string[],
  omitted: number,
): string | undefined {
  const note =
    omitted === 0
      ? []
      : [
          `(${String(omitted)} more probe result${omitted === 1 ? "" : "s"} left out to fit the pack: each is in pulse_checks)`,
        ];
  const all = [...blocks, ...note];
  return all.length === 0 ? undefined : all.join("\n\n");
}

const inertOr = (text: string | undefined): string | undefined =>
  text === undefined ? undefined : inert(text);

/**
 * The pulse template's inputs: the reads, the probe blocks that fit (`omitted` did not), and the
 * newest `handoffsShown` pending hand-offs (the rest are counted). Every section's text is inert,
 * whoever wrote it (agents write titles, mail, packets, knowledge and reports); the probes section
 * is the blocks as probeBlock made them, and the hand-offs section escapes its own text so each
 * entry's staffCall keeps its quotes.
 */
export function packSections(
  p: ContextPackInputs,
  probe: { readonly blocks: readonly string[]; readonly omitted: number },
  handoffsShown: number = p.handoffs.rows.length,
): PromptInputs {
  return {
    mission: inertOr(p.mission?.rendered_md),
    header: inert(header(p)),
    attention: inertOr(attention(p)),
    tickets: inertOr(tickets(p)),
    handoffs: handoffs(p, handoffsShown),
    messages: inertOr(messages(p)),
    last_pulse: inertOr(lastPulse(p)),
    knowledge: inertOr(knowledge(p)),
    probes: probes(probe.blocks, probe.omitted),
  };
}
