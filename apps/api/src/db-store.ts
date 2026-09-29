import { FrmError, ok, sha256Hex, type Result } from "@bayon/core";
import {
  getAgent,
  getEventsSince,
  getFleet,
  getInboxRequest,
  getMissionHistory,
  getMissionVersion,
  getSession,
  getSessionContext,
  getSpendReport,
  getSpendSummary,
  inboxAfter,
  listBudgets,
  listInboxRequests,
  listTicketEvents,
  toCanonical,
  type CommandRow,
  type Db,
  type EventRow,
  type InboxRow,
  type MissionRow,
} from "@bayon/db";
import {
  answerHumanRequest,
  deleteBudget,
  dismissHumanRequest,
  getBudgetCap,
  getCommandByIdempotencyKey,
  getCommandQueued,
  getFleetOverview,
  insertCommand,
  insertMissionVersion,
  putBudget,
  setBudgetCap,
  type AuditEntry,
  type QueuedCommandRow,
} from "@bayon/db/api";
import {
  BudgetSettings,
  BudgetView,
  BudgetsView,
  CommandView,
  Fleet,
  GATES_TOPIC_LIMIT,
  InboxItem,
  MissionVersion,
  MissionView,
  QueuedCommand,
  SessionView,
  SpendReport,
  SpendSummary,
  type EventItem,
} from "@bayon/proto";
import { jsonColumn, parseAs } from "./dto.js";
import { wireFields } from "./errors.js";
import { gatesPage } from "./gates/gate-views.js";
import { decodeInboxCursor, encodeInboxCursor } from "./inbox-cursor.js";
import { executorsStore } from "./executors-store.js";
import { fleetControlStore } from "./fleet-control-store.js";
import { handoffStore } from "./handoff-store.js";
import { modelsStore } from "./models-store.js";
import { runnersStore } from "./runners-store.js";
import { pulseStore } from "./pulse-store.js";
import type { ApiStore } from "./store.js";
import { workspacesStore } from "./workspaces-store.js";
import { toEventViews } from "./tickets/ticket-views.js";

// The ApiStore over @bayon/db: reads, plus the API's writes (§9.5): commands, the budget cap and
// mission versions. Rows are parsed into proto DTOs here; a row that does not fit is an internal
// error, never passed on.

/** REST callers are the operator (§12.1); agents never write missions. */
const OPERATOR = "operator";

/** A stored event: its canonical form (NULL columns absent) plus the id and truncation facts. */
export const toEventItem = (row: EventRow): EventItem => ({
  ...toCanonical(row),
  ...(row.truncated ? { truncated: true } : {}),
  ...(row.bytes_original === null
    ? {}
    : { bytes_original: row.bytes_original }),
  ...(row.payload_path === null ? {} : { payload_path: row.payload_path }),
});

/** One row of `ahead`: the queue says where it runs, so its payload travels with it. */
function toQueuedCommand(row: CommandRow): Result<QueuedCommand> {
  const payload = jsonColumn(row.payload_json, `command ${row.id} payload`);
  if (!payload.ok) return payload;
  return parseAs(
    QueuedCommand,
    {
      id: row.id,
      ts: row.ts,
      state: row.state,
      claimed_at: row.claimed_at,
      payload: payload.value,
    },
    `command ${row.id} ahead of another`,
  );
}

function toCommandView(queued: QueuedCommandRow): Result<CommandView> {
  const { row } = queued;
  const what = `command ${row.id}`;
  const payload = jsonColumn(row.payload_json, `${what} payload`);
  if (!payload.ok) return payload;
  const result = jsonColumn(row.result_json, `${what} result`);
  if (!result.ok) return result;
  const error = jsonColumn(row.error, `${what} error`);
  if (!error.ok) return error;
  const ahead: QueuedCommand[] = [];
  for (const other of queued.ahead) {
    const one = toQueuedCommand(other);
    if (!one.ok) return one;
    ahead.push(one.value);
  }
  // A stored FrmError leaves with its cause flattened, as a response's does (e.g. the gate).
  const stored = FrmError.safeParse(error.value);
  return parseAs(
    CommandView,
    {
      id: row.id,
      ts: row.ts,
      type: row.type,
      payload: payload.value,
      state: row.state,
      idempotency_key: row.idempotency_key,
      claimed_at: row.claimed_at,
      attempts: row.attempts ?? 0,
      result: result.value,
      error: stored.success
        ? {
            class: stored.data.class,
            message: stored.data.message,
            retryable: stored.data.retryable,
            ...wireFields(stored.data),
          }
        : error.value,
      now: queued.now,
      ahead,
    },
    what,
  );
}

const toMissionVersion = (row: MissionRow): Result<MissionVersion> =>
  parseAs(MissionVersion, row, `mission ${row.agent_name} v${row.version}`);

function toInboxItem(row: InboxRow): Result<InboxItem> {
  const what = `human request ${row.id}`;
  const options = jsonColumn(row.options_json, `${what} options`);
  if (!options.ok) return options;
  const answer = jsonColumn(row.answer_json, `${what} answer`);
  if (!answer.ok) return answer;
  const proposal = jsonColumn(row.proposal_json, `${what} proposal`);
  if (!proposal.ok) return proposal;
  return parseAs(
    InboxItem,
    {
      id: row.id,
      status: row.status,
      kind: row.kind,
      question: row.question,
      context_md: row.context_md,
      options: options.value,
      batch_id: row.batch_id,
      asked_at: row.asked_at,
      expires_at: row.expires_at,
      answer: answer.value,
      answered_by: row.answered_by,
      answered_at: row.answered_at,
      ticket:
        row.ticket_id === null
          ? null
          : {
              id: row.ticket_id,
              num: row.ticket_num,
              title: row.ticket_title,
              status: row.ticket_status,
            },
      session:
        row.session_id === null
          ? null
          : {
              id: row.session_id,
              agent: row.agent_name,
              role: row.session_role,
              state: row.session_state,
            },
      proposal: proposal.value,
    },
    what,
  );
}

function toInboxItems(rows: readonly InboxRow[]): Result<InboxItem[]> {
  const items: InboxItem[] = [];
  for (const row of rows) {
    const item = toInboxItem(row);
    if (!item.ok) return item;
    items.push(item.value);
  }
  return ok(items);
}

/** The operator's answer as an audit row: which request, and a digest of the text, never the text. */
async function answerAudit(id: string, answer: string): Promise<AuditEntry> {
  return {
    actor: OPERATOR,
    action: "rest.inbox_answer",
    target_kind: "human_request",
    target_id: id,
    payload: {
      answer_sha256: await sha256Hex(answer),
      bytes: Buffer.byteLength(answer, "utf8"),
    },
  };
}

export function dbStore(db: Db): ApiStore {
  return {
    ...pulseStore(db),
    ...handoffStore(db),
    ...runnersStore(db),
    ...modelsStore(db),
    ...executorsStore(db),
    ...workspacesStore(db),
    ...fleetControlStore(db),
    // The `gates` topic: the review queue, latest running and failed attempts.
    gates: () =>
      gatesPage(db, {
        states: ["running", "failed"],
        latest: true,
        limit: GATES_TOPIC_LIMIT,
      }),
    async fleet(filter = {}) {
      const rows = await getFleet(
        db,
        filter.project === undefined ? {} : { workspaceId: filter.project },
      );
      if (!rows.ok) return rows;
      const overview = await getFleetOverview(db);
      if (!overview.ok) return overview;
      return parseAs(
        Fleet,
        { sessions: rows.value, ...overview.value },
        "fleet",
      );
    },
    async session(id) {
      const row = await getSession(db, id);
      if (!row.ok) return row;
      const agent = await getAgent(db, row.value.agent_id);
      if (!agent.ok) return agent;
      // Its runs' context compression totals: only a session that pinned a ruleset has
      // any, so any other skips the read.
      const context =
        row.value.context_ruleset === null
          ? ok(null)
          : await getSessionContext(db, id);
      if (!context.ok) return context;
      return parseAs(
        SessionView,
        { ...row.value, agent_name: agent.value.name, context: context.value },
        `session ${id}`,
      );
    },
    async eventsSince({ sessionId, since, limit, kinds }) {
      const page = await getEventsSince(db, { sessionId, since, limit, kinds });
      if (!page.ok) return page;
      return ok({
        items: page.value.rows.map(toEventItem),
        next_cursor: page.value.nextCursor,
        has_more: page.value.hasMore,
      });
    },
    async ticketEventsSince({ since, limit }) {
      const page = await listTicketEvents(db, { since, limit });
      if (!page.ok) return page;
      const items = toEventViews(page.value.rows);
      return items.ok
        ? ok({
            items: items.value,
            next_cursor: page.value.nextCursor,
            has_more: page.value.hasMore,
          })
        : items;
    },
    insertCommand({ command, idempotencyKey }) {
      return insertCommand(db, {
        type: command.type,
        payload: command.payload,
        idempotencyKey,
      });
    },
    async command(id) {
      const queued = await getCommandQueued(db, id);
      return queued.ok ? toCommandView(queued.value) : queued;
    },
    async commandByIdempotencyKey(key) {
      const row = await getCommandByIdempotencyKey(db, key);
      if (!row.ok) return row;
      if (row.value === null) return ok(null);
      const payload = jsonColumn(
        row.value.payload_json,
        `command ${row.value.id} payload`,
      );
      return payload.ok
        ? ok({
            id: row.value.id,
            type: row.value.type,
            payload: payload.value,
          })
        : payload;
    },
    async getBudgetSettings() {
      const cap = await getBudgetCap(db);
      if (!cap.ok) return cap;
      return parseAs(
        BudgetSettings,
        { daily_cap_usd: cap.value },
        "budget settings",
      );
    },
    async setBudgetSettings({ daily_cap_usd }) {
      const cap = await setBudgetCap(db, daily_cap_usd, OPERATOR);
      if (!cap.ok) return cap;
      return parseAs(
        BudgetSettings,
        { daily_cap_usd: cap.value },
        "budget settings",
      );
    },
    async budgets() {
      const rows = await listBudgets(db);
      if (!rows.ok) return rows;
      return parseAs(BudgetsView, { budgets: rows.value }, "budgets");
    },
    async putBudget(b) {
      const row = await putBudget(db, b, OPERATOR);
      if (!row.ok) return row;
      return parseAs(BudgetView, row.value, "budget");
    },
    async deleteBudget(id) {
      const row = await deleteBudget(db, id, OPERATOR);
      if (!row.ok) return row;
      return parseAs(BudgetView, row.value, `budget ${id}`);
    },
    async missionHistory(agent) {
      const history = await getMissionHistory(db, agent);
      if (!history.ok) return history;
      return parseAs(
        MissionView,
        { agent, ...history.value },
        `mission history of ${agent}`,
      );
    },
    async missionVersion(agent, version) {
      const row = await getMissionVersion(db, agent, version);
      return row.ok ? toMissionVersion(row.value) : row;
    },
    async saveMission(agent, body) {
      const row = await insertMissionVersion(db, {
        ...body,
        agent_name: agent,
        created_by: OPERATOR,
      });
      return row.ok ? toMissionVersion(row.value) : row;
    },
    async spendReport({ group, project }) {
      const report = await getSpendReport(
        db,
        group,
        project === undefined ? {} : { workspaceId: project },
      );
      return report.ok
        ? parseAs(SpendReport, report.value, `spend report by ${group}`)
        : report;
    },
    async spendSummary() {
      const summary = await getSpendSummary(db);
      return summary.ok
        ? parseAs(SpendSummary, summary.value, "spend summary")
        : summary;
    },
    async inbox({ status, kind, project, ticket, cursor, limit }) {
      const after =
        cursor === undefined ? undefined : decodeInboxCursor(cursor);
      if (after !== undefined && !after.ok) return after;
      const page = await listInboxRequests(db, {
        ...(status === undefined ? {} : { status }),
        ...(kind === undefined ? {} : { kind }),
        ...(project === undefined ? {} : { workspaceId: project }),
        ...(ticket === undefined ? {} : { ticketNum: ticket }),
        ...(after === undefined ? {} : { after: after.value }),
        limit,
      });
      if (!page.ok) return page;
      const items = toInboxItems(page.value.rows);
      if (!items.ok) return items;
      const last = page.value.rows.at(-1);
      return ok({
        items: items.value,
        next_cursor:
          page.value.hasMore && last !== undefined
            ? encodeInboxCursor(inboxAfter(last))
            : null,
        has_more: page.value.hasMore,
      });
    },
    async answerHumanRequest(id, answer) {
      const answered = await answerHumanRequest(
        db,
        { id, answer, answered_by: OPERATOR },
        await answerAudit(id, answer),
      );
      if (!answered.ok) return answered;
      const row = await getInboxRequest(db, id);
      return row.ok ? toInboxItem(row.value) : row;
    },
    async dismissHumanRequest(id) {
      const dismissed = await dismissHumanRequest(
        db,
        {
          id,
          dismissed_by: OPERATOR,
          by: { actor_kind: OPERATOR, actor_id: OPERATOR },
        },
        {
          actor: OPERATOR,
          action: "rest.inbox_dismiss",
          target_kind: "human_request",
          target_id: id,
        },
      );
      if (!dismissed.ok) return dismissed;
      const row = await getInboxRequest(db, id);
      return row.ok ? toInboxItem(row.value) : row;
    },
    async inboxItem(id) {
      const row = await getInboxRequest(db, id);
      return row.ok ? toInboxItem(row.value) : row;
    },
  };
}
