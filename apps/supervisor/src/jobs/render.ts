// Deterministic markdown rendering for the exporter (spec §10.5). Pure and DB-free on
// purpose (the design doc's §3 step 2): the same view always renders to the same bytes, so this is
// fully unit-testable without a database, and it never adds a renderer-owned wall-clock stamp --
// the one thing that would make an unchanged ticket hash differently on every run. Every timestamp
// that *is* ticket data (transition log, hand-offs) renders as UTC ISO-8601, never local time or a
// raw epoch.
import { stringify } from "yaml";

export interface TicketExportGate {
  readonly kind: string;
  readonly state: string;
}

export interface TicketExportEvent {
  readonly kind: string;
  readonly actor: string;
  readonly reason: string | null;
  readonly createdAt: number;
}

export interface TicketExportHandoff {
  readonly fromSessionId: string | null;
  readonly toSessionId: string | null;
  readonly createdAt: number;
}

/** What the renderer needs; §4's read side supplies it (gates/events/handoffs default to `[]`
 * until migration 003 lands the tables that hold them). */
export interface TicketExportView {
  readonly key: string;
  readonly title: string;
  readonly status: string;
  readonly type: string;
  readonly tier: string;
  readonly priority: number;
  readonly costUsd: number;
  readonly branch: string | null;
  readonly prUrl: string | null;
  readonly bodyMd: string;
  readonly acceptanceMd: string;
  readonly gates?: readonly TicketExportGate[];
  readonly events?: readonly TicketExportEvent[];
  readonly handoffs?: readonly TicketExportHandoff[];
}

const isoUtc = (ms: number): string => new Date(ms).toISOString();
const NONE = "_none recorded_";

/** Frontmatter as one plain object with an explicit key order (§10.5: status, type, tier, gates,
 * cost, links) -- `yaml.stringify` walks a plain object in insertion order, so this order IS the
 * file's order, never left to however a caller happened to build the input. */
function frontmatter(t: TicketExportView): string {
  const doc = {
    key: t.key,
    status: t.status,
    type: t.type,
    tier: t.tier,
    priority: t.priority,
    cost_usd: t.costUsd,
    gates: (t.gates ?? []).map((g) => ({ kind: g.kind, state: g.state })),
    links: { branch: t.branch, pr_url: t.prUrl },
  };
  return stringify(doc).trimEnd();
}

function transitionLog(events: readonly TicketExportEvent[]): string {
  if (events.length === 0) return NONE;
  return events
    .map(
      (e) =>
        `- ${isoUtc(e.createdAt)} · ${e.kind} · ${e.actor}` +
        (e.reason === null || e.reason === "" ? "" : ` — ${e.reason}`),
    )
    .join("\n");
}

function handoffSummaries(handoffs: readonly TicketExportHandoff[]): string {
  if (handoffs.length === 0) return NONE;
  return handoffs
    .map(
      (h) =>
        `- ${isoUtc(h.createdAt)} · ${h.fromSessionId ?? "?"} → ${h.toSessionId ?? "(unassigned)"}`,
    )
    .join("\n");
}

/** Renders one ticket to markdown with YAML frontmatter. Deterministic: the same `t` always
 * produces the same bytes, key order included. */
export function renderTicketMarkdown(t: TicketExportView): string {
  const body = t.bodyMd.trim();
  const acceptance = t.acceptanceMd.trim();
  return (
    [
      "---",
      frontmatter(t),
      "---",
      "",
      `# ${t.title}`,
      "",
      body === "" ? NONE : body,
      "",
      "## Acceptance",
      "",
      acceptance === "" ? NONE : acceptance,
      "",
      "## Transition log",
      "",
      transitionLog(t.events ?? []),
      "",
      "## Hand-offs",
      "",
      handoffSummaries(t.handoffs ?? []),
    ].join("\n") + "\n"
  );
}

/**
 * A mission version's export file: `rendered_md` verbatim, plus the trailing newline every other
 * export file gets. No frontmatter of its own -- a mission version is immutable once inserted
 *, so its export is the DB's own bytes, not a second rendering to keep in sync.
 */
export function renderMissionMarkdown(renderedMd: string): string {
  return `${renderedMd.trimEnd()}\n`;
}
