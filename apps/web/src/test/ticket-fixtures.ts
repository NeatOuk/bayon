import type {
  FindingView,
  GateView,
  HandoffView,
  TicketDetail,
  TicketEconomics,
  TicketEventView,
  TicketSummary,
  TicketView,
  TicketsPage,
} from "@bayon/proto";

// Wire-shaped ticket data (DTOs): every value here would pass its proto schema.

const T0 = 1_800_000_000_000;

export const ticketView = (
  ticket: Partial<TicketView> & Pick<TicketView, "num">,
): TicketView => ({
  id: `ticket-${ticket.num}`,
  key: `FRM-${ticket.num}`,
  title: `ticket ${ticket.num}`,
  body_md: "",
  acceptance_md: "",
  type: "feature",
  status: "backlog",
  priority: 3,
  needs_human: false,
  open_questions: 0,
  non_trivial: false,
  complexity_score: 0,
  complexity_tier: "cheap",
  complexity_factors: null,
  workspace_id: null,
  epic_id: null,
  parent_ticket_id: null,
  origin: "operator",
  origin_ref: null,
  blocked_reason: null,
  unblock_condition: null,
  owner_session_id: null,
  branch: null,
  plan_path: null,
  pr_url: null,
  split_depth: 0,
  children_total: 0,
  children_done: 0,
  version: 1,
  created_at: T0,
  updated_at: T0,
  closed_at: null,
  ...ticket,
});

export const ticketSummary = (
  ticket: Partial<TicketView> & Pick<TicketView, "num">,
  reviewRounds = 0,
  /** Why it waits on the operator; null when it does not. */
  waiting: string | null = null,
): TicketSummary => {
  const view = ticketView(ticket);
  return {
    id: view.id,
    key: view.key,
    num: view.num,
    title: view.title,
    type: view.type,
    status: view.status,
    priority: view.priority,
    needs_human: view.needs_human,
    open_questions: view.open_questions,
    complexity_tier: view.complexity_tier,
    owner_session_id: view.owner_session_id,
    workspace_id: view.workspace_id,
    origin: view.origin,
    origin_ref: view.origin_ref,
    version: view.version,
    updated_at: view.updated_at,
    review_rounds: reviewRounds,
    waiting_on_you: waiting !== null,
    waiting_reason: waiting,
  };
};

export const ticketsPage = (
  items: readonly TicketSummary[],
  hasMore = false,
): TicketsPage => ({
  items: [...items],
  next_cursor: items.at(-1)?.num ?? 0,
  has_more: hasMore,
});

export const ticketEvent = (
  id: number,
  event: Partial<TicketEventView> = {},
): TicketEventView => ({
  id,
  ticket_id: "ticket-812",
  ts: T0 + id * 1_000,
  actor_kind: "operator",
  actor_id: null,
  kind: "transition",
  from_status: "backlog",
  to_status: "prioritized",
  reason: null,
  payload: {},
  ...event,
});

export const finding = (
  f: Partial<FindingView> & Pick<FindingView, "summary">,
): FindingView => ({
  id: `finding-${f.summary}`,
  severity: "major",
  category: null,
  file: null,
  line: null,
  detail_md: null,
  status: "open",
  resolution_note: null,
  created_at: T0,
  resolved_by_run_id: null,
  resolved_by: null,
  resolved_at: null,
  waived_by: null,
  waive_reason: null,
  ...f,
});

export const gateView = (
  gate: Partial<GateView> & Pick<GateView, "kind">,
): GateView => ({
  id: `gate-${gate.kind}`,
  state: "pending",
  attempt: 1,
  repo_id: null,
  required: true,
  findings_total: 0,
  findings_unresolved: 0,
  waive_reason: null,
  decided_at: null,
  session_id: null,
  started_at: null,
  reason: null,
  evidence: null,
  findings: [],
  ...gate,
});

export const handoffView = (
  handoff: Partial<HandoffView> & Pick<HandoffView, "id">,
): HandoffView => ({
  reason: "context_ceiling",
  from_session_id: "s1",
  to_session_id: null,
  quality: "full",
  goal_line: null,
  accepted_at: null,
  created_at: T0,
  ...handoff,
});

export const ZERO_ECONOMICS: TicketEconomics = {
  cost_usd: 0,
  cost_wasted_usd: 0,
  review_rounds: 0,
  handoff_count: 0,
  phase_handoff_count: 0,
  sessions: 0,
  tokens: 0,
  cache_ratio: null,
};

export const ticketDetail = (
  ticket: TicketView,
  rest: Partial<Omit<TicketDetail, "ticket">> = {},
): TicketDetail => ({
  ticket,
  transitions: [],
  next_step: {
    waiting_on: "orchestrator",
    reason: "Waiting for the orchestrator to prioritise it",
  },
  links: [],
  gates: [],
  handoffs: [],
  exports: [],
  economics: ZERO_ECONOMICS,
  events: { items: [], next_cursor: 0, has_more: false },
  ...rest,
});
