// @bayon/db/api: the API's writers (§9.5, amendment 10): commands, the budget cap, mission
// versions (with `agents.mission_id`, M1 amendment 6), the work tables (M1, contract 1) and
// audit_log, plus its command reads and the Fleet overview. apps/supervisor
// must not import it.
export type { AuditEntry } from "./repos/audit.js";
export { appendAudit } from "./repos/audit.js";
export type { NewCommand } from "./repos/commands.js";
export type { NewMissionVersion } from "./repos/missions.js";
export { insertMissionVersion } from "./repos/missions.js";
export { getBudgetCap, setBudgetCap } from "./repos/budget.js";
// `POST /projects`: the repo/workspace/profile/agent rows a project needs, one door.
export type { NewProject } from "./repos/project-create.js";
export { createProject } from "./repos/project-create.js";
// `POST /projects/:id/agents` and `PATCH /agents/:id`: one more builder, reviewer or
// orchestrator for a project, at most one of those enabled, and an agent's
// enabled/max_concurrency — never its mission, kind, runner or project.
export type { CreatedAgent, NewProjectAgent } from "./repos/agent-create.js";
export { createProjectAgent } from "./repos/agent-create.js";
export type { AgentApiPatch, AgentChange } from "./repos/agent-set.js";
export { setAgentFromApi } from "./repos/agent-set.js";
// `POST /projects/:id/pause|resume`: one project's hold, workspaces.paused, audited.
export type { ProjectPauseChange } from "./repos/project-pause.js";
export { setProjectPaused } from "./repos/project-pause.js";
// `PATCH /projects/:id`: whether a project's
// orchestrator only proposes its staffing, its Jira source, its QA harness, and its delivery —
// whose audited change is the standing §14 approval for the supervisor's network writes.
export type {
  ProjectSettingsChange,
  ProjectSettingsPatch,
} from "./repos/project-settings.js";
export { setProjectSettings } from "./repos/project-settings.js";
export type { PushTarget, PushTargetPatch } from "./repos/push-targets.js";
// The Jira mirror: one page of issues into a project's tickets, and the parking of the
// unstarted ones whose issues left its query.
export type {
  JiraDeparted,
  JiraMirrored,
  JiraMirrorPage,
  JiraParkRequest,
  JiraSkipped,
} from "./repos/jira-mirror.js";
export { mirrorJiraPage, parkDepartedJira } from "./repos/jira-mirror.js";
// Jira follows the ticket (§9.5 amendment): pushes filed once by key with their
// watermarks, each claimed before its send and settled after.
export type { JiraPushFiling, JiraPushOutcome } from "./repos/jira-pushes.js";
export {
  claimJiraPush,
  fileJiraPushes,
  settleJiraPush,
} from "./repos/jira-pushes.js";
// `POST /executors`: one executor row, the second, narrower door beside createProject.
export type { NewExecutor } from "./repos/executor-create.js";
export { createExecutor } from "./repos/executor-create.js";
// The operator's models: POST/PATCH/DELETE /runners/:id/models, each audited; the tier
// rule and the source rule are the writer's (operator-models.ts).
export type {
  ModelPut,
  ModelWrite,
  OperatorModel,
} from "./repos/operator-models.js";
export {
  deactivateOperatorModel,
  putOperatorModel,
} from "./repos/operator-models.js";
// budgets (M4): the operator's PUT and DELETE (§12.1), each audited; `kill` is refused.
export type { BudgetPut } from "./repos/budgets.js";
export { deleteBudget, putBudget } from "./repos/budgets.js";
// The operator's dismissal of a finished session's error from the strip.
export { ackAttention } from "./repos/attention-ack.js";
export type {
  AttentionItem,
  ExecutorDisk,
  ExecutorSlots,
  FleetBudget,
  FleetOverview,
} from "./repos/fleet-overview.js";
export {
  DAILY_CAP_KEY,
  ERRORED_WITHIN_MS,
  STALE_AFTER_MS,
  getFleetOverview,
} from "./repos/fleet-overview.js";
// `POST /runners/:id/updates/:version/dismiss`: the operator's dismissal, audited.
export { dismissRunnerUpdate } from "./repos/runner-updates.js";
export type { QueuedCommandRow } from "./repos/commands.js";
export {
  getCommand,
  getCommandByIdempotencyKey,
  getCommandQueued,
  insertCommand,
} from "./repos/commands.js";
// Tickets: create, compare-and-set update, and transitions whose laws are the caller's `decide`.
export type {
  NewTicket,
  TicketActor,
  TicketPatch,
  TicketUpdate,
} from "./repos/ticket-writes.js";
export { createTicket, updateTicketCas } from "./repos/ticket-writes.js";
export type {
  Decide,
  TransitionFacts,
  TransitionRequest,
} from "./repos/ticket-transition.js";
export { transitionTicket } from "./repos/ticket-transition.js";
// The phase-boundary hand-off a transition ships with its move (§7.1).
export type { PhaseHolder, PlanHandoff } from "./repos/phase-handoff.js";
export { PHASE_CHANGE, phaseHandoffKey } from "./repos/phase-handoff.js";
export type { NewTicketEvent, NewTicketLink } from "./repos/ticket-events.js";
export { appendTicketEvent, linkTicket } from "./repos/ticket-events.js";
// The mailbox, human requests and knowledge (§11).
export type {
  AskedHumanRequests,
  NewHumanRequest,
  NewMessage,
} from "./repos/coordination.js";
export {
  askHumanRequests,
  insertHumanRequest,
  insertHumanRequests,
  markMessagesRead,
  sendMessage,
} from "./repos/coordination.js";
export type { HumanAnswer, HumanDismissal } from "./repos/inbox.js";
export { answerHumanRequest, dismissHumanRequest } from "./repos/inbox.js";
export type { NewKnowledge } from "./repos/knowledge.js";
export { appendKnowledge } from "./repos/knowledge.js";
// handoffs: the judgement columns (handoff_write); refused once the session is sealed.
export type { HandoffJudgement } from "./repos/handoffs.js";
export { writeHandoffJudgement } from "./repos/handoffs.js";
// handoffs: the accept columns and tickets.owner_session_id, which only this writes.
export type {
  AcceptHandoffRequest,
  AcceptOutcome,
} from "./repos/handoff-accept.js";
export { acceptHandoff } from "./repos/handoff-accept.js";
// M2: ticket_staff's move + spawn in one transaction, and the agents' pulse policy.
export type { StaffOutcome, StaffTicketRequest } from "./repos/staffing.js";
export { staffTicket } from "./repos/staffing.js";
// The operator's answer to an orchestrator's staffing proposal: approve staffs it.
export type { ProposalFiled } from "./repos/staff-proposal.js";
export type {
  StaffProposalAnswer,
  StaffProposalAnswered,
} from "./repos/staff-proposal-answer.js";
export { answerStaffProposal } from "./repos/staff-proposal-answer.js";
export type { PulsePolicyUpdate } from "./repos/pulse-policy.js";
export { setPulsePolicy } from "./repos/pulse-policy.js";
// M3: gates and findings. Rounds open inside transitionTicket (its `gates` argument);
// these are the operator's rerun and waive, and the resolve/waive of a finding.
export type {
  OpenedGate,
  PlanGates,
  RerunGate,
  ResolveFinding,
  WaiveFinding,
  WaiveGate,
} from "./repos/gate-writes.js";
export {
  rerunGate,
  resolveFinding,
  waiveFinding,
  waiveGate,
} from "./repos/gate-writes.js";
// Who runs what (§9.8): one role per PUT; no certification check here (pickReviewer does).
export type { RoleBindingPut } from "./repos/role-bindings.js";
export { putRoleBinding } from "./repos/role-bindings.js";
// The kill switch and the operator's whitelisted settings (M4 §12.1), each change audited.
export type {
  FleetPauseChange,
  PauseRequest,
  PauseVia,
  SettingChange,
} from "./repos/fleet-control.js";
export { putOperatorSettings, setFleetPaused } from "./repos/fleet-control.js";
// The notifier's outbox (§9.5 amendment): notifications filed once by key with their
// watermarks, and each channel's delivery claimed, settled or deferred by quiet hours.
export type {
  DeliveryOutcome,
  NotifyFiled,
  NotifyFiling,
} from "./repos/notifications.js";
export {
  claimDelivery,
  deferDelivery,
  insertNotifications,
  settleDelivery,
} from "./repos/notifications.js";
// `projects.local_roots` from the GUI (§14 amendment): append one folder, never replace,
// audited as the operator's; the API calls it only for a request from a browser on this host.
export type { LocalRootAdded } from "./repos/local-roots.js";
export { LOCAL_ROOTS_VIA_GUI, addLocalRoot } from "./repos/local-roots.js";
// The notifier's three destination settings (§14): the one API door to them, each change
// audited as `notify.config` with both values, in the transaction that writes the setting.
export type { NotifyConfigChange } from "./repos/notify-config.js";
export {
  NOTIFY_CONFIG_ACTION,
  putNotifyConfig,
} from "./repos/notify-config.js";
