import {
  err,
  ok,
  ticketKey,
  waitingOnYou,
  type FrmError,
  type Result,
  type Wait,
  type WaitFacts,
} from "@bayon/core";
import {
  gateReason,
  listTicketReviewRounds,
  listWaitFacts,
  openQuestionCounts,
  type Db,
  type FindingRow,
  type GateListRow,
  type GateRow,
  type GateSession,
  type HandoffRow,
  type RoleBindingRow,
  type TicketEconomicsRow,
  type TicketEventRow,
  type TicketExportRow,
  type TicketLinkRow,
  type TicketRow,
} from "@bayon/db";
import {
  FindingView,
  GateSummary,
  GateView,
  HandoffView,
  RoleBindingView,
  TicketEconomics,
  TicketEventView,
  TicketExportView,
  TicketLinkView,
  TicketSummary,
  TicketView,
} from "@bayon/proto";
import { z } from "zod";

// Rows into the proto DTOs. A row that does not fit its DTO is an internal error, never sent on.

const corrupt = (what: string, detail: string): FrmError => ({
  class: "internal",
  message: `stored ${what} does not fit its DTO: ${detail}`,
  retryable: false,
});

function parseAs<T>(
  schema: z.ZodType<T>,
  value: unknown,
  what: string,
): Result<T> {
  const parsed = schema.safeParse(value);
  return parsed.success
    ? ok(parsed.data)
    : err(corrupt(what, z.prettifyError(parsed.error)));
}

function jsonColumn(text: string | null, what: string): Result<unknown> {
  if (text === null) return ok(null);
  try {
    const value: unknown = JSON.parse(text);
    return ok(value);
  } catch {
    return err(corrupt(what, "not JSON"));
  }
}

/** Every row mapped, or the first that does not fit. */
function mapAll<R, T>(
  rows: readonly R[],
  map: (row: R) => Result<T>,
): Result<T[]> {
  const mapped = rows.map(map);
  const failed = mapped.find((m) => !m.ok);
  if (failed !== undefined && !failed.ok) return failed;
  return ok(mapped.flatMap((m) => (m.ok ? [m.value] : [])));
}

export function toTicketView(
  row: TicketRow,
  prefix: string,
  /** Its open questions to the operator, counted live (openQuestionCounts). */
  openQuestions: number,
): Result<TicketView> {
  const what = `ticket ${row.id}`;
  const factors = jsonColumn(
    row.complexity_factors_json,
    `${what} complexity factors`,
  );
  if (!factors.ok) return factors;
  return parseAs(
    TicketView,
    {
      ...row,
      key: ticketKey(prefix, row.num),
      needs_human: row.needs_human === 1,
      open_questions: openQuestions,
      non_trivial: row.non_trivial === 1,
      complexity_factors: factors.value,
    },
    what,
  );
}

/** One ticket's view, its open questions read now: every door's single-ticket answer. */
export async function ticketViewOf(
  db: Db,
  row: TicketRow,
  prefix: string,
): Promise<Result<TicketView>> {
  const counts = await openQuestionCounts(db, [row.id]);
  return counts.ok
    ? toTicketView(row, prefix, counts.value.get(row.id) ?? 0)
    : counts;
}

/**
 * A page's board cards: each ticket with its review rounds, its open questions and whether it waits
 * on the operator, each read for the whole page at once.
 */
export async function summariesOf(
  db: Db,
  rows: readonly TicketRow[],
  prefix: string,
): Promise<Result<TicketSummary[]>> {
  const ids = rows.map((row) => row.id);
  const rounds = await listTicketReviewRounds(db, ids);
  if (!rounds.ok) return rounds;
  const open = await openQuestionCounts(db, ids);
  if (!open.ok) return open;
  const waits = await listWaitFacts(db, ids);
  if (!waits.ok) return waits;
  return mapAll(rows, (row) => {
    const view = toTicketView(row, prefix, open.value.get(row.id) ?? 0);
    return view.ok
      ? toSummary(
          view.value,
          rounds.value.get(row.id) ?? 0,
          waitOf(waits.value.get(row.id)),
        )
      : view;
  });
}

/** A card's wait, or none: a row the pass did not return (deleted mid-page) waits on nobody. */
const waitOf = (facts: WaitFacts | undefined): Wait | null =>
  facts === undefined ? null : waitingOnYou(facts);

/** A board card: the ticket, its round count from v_ticket_economics (M3 amendment b), its wait. */
export const toSummary = (
  view: TicketView,
  reviewRounds: number,
  wait: Wait | null,
): Result<TicketSummary> =>
  parseAs(
    TicketSummary,
    {
      ...view,
      review_rounds: reviewRounds,
      waiting_on_you: wait !== null,
      waiting_reason: wait?.reason ?? null,
    },
    `ticket ${view.id}`,
  );

export function toEventView(row: TicketEventRow): Result<TicketEventView> {
  const what = `ticket event ${row.id}`;
  const payload = jsonColumn(row.payload_json, `${what} payload`);
  return payload.ok
    ? parseAs(TicketEventView, { ...row, payload: payload.value }, what)
    : payload;
}

export const toEventViews = (rows: readonly TicketEventRow[]) =>
  mapAll(rows, toEventView);

export const toLinkViews = (rows: readonly TicketLinkRow[]) =>
  mapAll(rows, (row) =>
    parseAs(TicketLinkView, row, `link of ${row.ticket_id}`),
  );

export const toFindingView = (f: FindingRow): Result<FindingView> =>
  parseAs(FindingView, f, `finding ${f.id}`);

/** A gate's columns as its view carries them, without findings. */
function gateFields(gate: GateRow, sessions: readonly GateSession[]) {
  const evidence = jsonColumn(gate.evidence_json, `gate ${gate.id} evidence`);
  if (!evidence.ok) return evidence;
  // Decided: the reviewer the decision names. Running: the newest session spawned for it.
  const session =
    gate.reviewer_session_id ??
    sessions.find((s) => s.gate_id === gate.id)?.session_id ??
    null;
  return ok({
    ...gate,
    required: gate.required === 1,
    findings_total: gate.findings_total ?? 0,
    findings_unresolved: gate.findings_unresolved ?? 0,
    session_id: session,
    reason: gateReason(gate.evidence_json),
    evidence: evidence.value,
  });
}

export function toGateViews(
  gates: readonly GateRow[],
  findings: readonly FindingRow[],
  /** Sessions spawned for these gates (sessions.gate_id), newest first. */
  sessions: readonly GateSession[] = [],
): Result<GateView[]> {
  return mapAll(gates, (gate) => {
    const own = mapAll(
      findings.filter((f) => f.gate_id === gate.id),
      toFindingView,
    );
    if (!own.ok) return own;
    const fields = gateFields(gate, sessions);
    if (!fields.ok) return fields;
    return parseAs(
      GateView,
      { ...fields.value, findings: own.value },
      `gate ${gate.id}`,
    );
  });
}

/** One row of GET /gates and of the `gates` topic: the gate and its ticket. */
export function toGateSummary(
  row: GateListRow,
  prefix: string,
  sessions: readonly GateSession[],
): Result<GateSummary> {
  const fields = gateFields(row, sessions);
  if (!fields.ok) return fields;
  return parseAs(
    GateSummary,
    {
      ...fields.value,
      ticket: {
        id: row.ticket_id,
        num: row.ticket_num,
        key: ticketKey(prefix, row.ticket_num),
        title: row.ticket_title,
        status: row.ticket_status,
      },
    },
    `gate ${row.id}`,
  );
}

export const toGateSummaries = (
  rows: readonly GateListRow[],
  prefix: string,
  sessions: readonly GateSession[],
) => mapAll(rows, (row) => toGateSummary(row, prefix, sessions));

export const toRoleBindingView = (row: RoleBindingRow) =>
  parseAs(RoleBindingView, row, `role binding ${row.role}`);

export const toRoleBindingViews = (rows: readonly RoleBindingRow[]) =>
  mapAll(rows, toRoleBindingView);

export const toHandoffViews = (rows: readonly HandoffRow[]) =>
  mapAll(rows, (row) => parseAs(HandoffView, row, `handoff ${row.id}`));

export const toExportViews = (rows: readonly TicketExportRow[]) =>
  mapAll(rows, (row) =>
    parseAs(TicketExportView, row, `export ${row.target} of ${row.ticket_id}`),
  );

export const toEconomics = (row: TicketEconomicsRow): Result<TicketEconomics> =>
  parseAs(TicketEconomics, row, `economics of ${row.id}`);
