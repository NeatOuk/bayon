// @bayon/db: the shared, read-side surface. Writers are split by owner (§9.5): the supervisor's
// in @bayon/db/supervisor, the API's in @bayon/db/api. no-sql.test.ts enforces the split.
export type { Db, OpenOptions, R } from "./connection.js";
export { openDb, openDbReadOnly } from "./connection.js";
export type {
  AppliedMigration,
  MigrationRef,
  MigrationStatus,
} from "./migrate.js";
export { migrationStatus, migrationTag } from "./migrate.js";
export type {
  AgentRow,
  CommandRow,
  CommandState,
  EventRow,
  ExecutorRow,
  FleetRow,
  MissionRow,
  ModelRow,
  ProfileRow,
  RepoRow,
  RunClassRow,
  RunnerRow,
  RunRow,
  SessionRow,
  SpendRow,
  TicketRow,
  WorkspaceRow,
  WorktreeRow,
  WorktreeState,
} from "./schema.js";
// 003_work reads (M1). Their writers: @bayon/db/api, and upsertTicketExport in /supervisor.
export type {
  AttentionWhy,
  FindingRow,
  FindingSeverity,
  GateKind,
  GateRow,
  HandoffRow,
  HumanRequestRow,
  KnowledgeRow,
  MessageRow,
  NeedsAttentionRow,
  RoleBindingRow,
  TicketEconomicsRow,
  TicketEventRow,
  TicketExportRow,
  TicketExportState,
  TicketLinkRow,
} from "./schema-work.js";
// 004_pulse reads (M2). pulses and pulse_checks are the supervisor's to write (§9.5); probes are
// operator config.
export type {
  ProbeKind,
  ProbeRow,
  PulseCheckRow,
  PulseCheckState,
  PulseRow,
  PulseState,
  PulseTrigger,
} from "./schema-pulse.js";
export type { PulseQuery } from "./repos/pulses.js";
export {
  LIVE_PULSE_STATES,
  findLivePulse,
  findPulseBySession,
  getProbe,
  getPulse,
  listProbes,
  listPulseChecks,
  listPulses,
} from "./repos/pulses.js";
export type {
  ContextPackInputs,
  ContextPackQuery,
  PackAttentionGroup,
  PackAttentionItem,
  PackCount,
  PackHandoff,
  PackHumanRequest,
  PackKnowledge,
  PackList,
  PackMessage,
  PackPulse,
  PackTicket,
} from "./repos/context-pack.js";
export {
  CONTEXT_PACK_LIMITS,
  getContextPackInputs,
} from "./repos/context-pack.js";
// The named queries sql probes run (Invariant 6: a probe row names one, never SQL).
export type { ProbeFinding } from "./repos/probe-queries.js";
export {
  PROBE_QUERY_IDS,
  PROBE_QUERY_ROWS,
  runProbeQuery,
} from "./repos/probe-queries.js";
// What the pulse scheduler reads to decide.
export type {
  Completion,
  CompletionCursor,
  CompletionKind,
  PulseHistoryRow,
} from "./repos/pulse-reads.js";
export {
  COMPLETION_KINDS,
  completionsSince,
  getDailyBudget,
  hasPulseWork,
  listLivePulses,
  listPulseAgents,
  pulseHistory,
  pulseIdForSession,
} from "./repos/pulse-reads.js";
// Whose work a project's orchestrator reads.
export type { PulseScope } from "./repos/project-scope.js";
export { pulseScopeOf } from "./repos/project-scope.js";
// The reconciler's machine-step sweep: tickets resting where a gate decides.
export type {
  MachineCandidate,
  MachineCursor,
} from "./repos/machine-candidates.js";
export { listMachineCandidates } from "./repos/machine-candidates.js";
// The reconciler's delivery sweep: tickets whose project delivers and which have
// reached its moment, and everything one ticket's delivery needs.
export type {
  DeliveryCandidate,
  DeliveryCursor,
  DeliveryPlan,
  DeliveryRepo,
} from "./repos/delivery-reads.js";
export {
  deliveryPlan,
  listDeliveryCandidates,
} from "./repos/delivery-reads.js";
// The CI sweep's reads: the running gates that wait on CI, and one gate's plan.
export type {
  CiGateCandidate,
  CiGateCursor,
  CiGatePlan,
} from "./repos/ci-gates.js";
export { ciGatePlan, listCiGates } from "./repos/ci-gates.js";
// The pull-request sweep's reads: its candidates, and one ticket's open requests.
export type {
  PullRequestCandidate,
  PullRequestWatch,
  WatchedPullRequest,
} from "./repos/pull-request-reads.js";
export {
  listPullRequestCandidates,
  pullRequestWatch,
} from "./repos/pull-request-reads.js";
export type { TicketPage, TicketQuery } from "./repos/tickets.js";
export {
  findTicketByFingerprint,
  getTicket,
  getTicketByNum,
  listTickets,
} from "./repos/tickets.js";
export type {
  TicketEventsPage,
  TicketEventsQuery,
} from "./repos/ticket-events.js";
export { listTicketEvents, listTicketLinks } from "./repos/ticket-events.js";
export type {
  TicketFactsSnapshot,
  TicketWorktree,
} from "./repos/ticket-facts.js";
export { getTicketFacts, listTicketWorktrees } from "./repos/ticket-facts.js";
// Rows as the laws read them: pure mappers the API's transitions and blockTicket share.
export {
  gateFacts,
  isMultiRepo,
  lawFacts,
  lawFactsWith,
  lawTicket,
  lintGateRepos,
  parseStatus,
  sessionFact,
} from "./repos/law-facts.js";
export type { InboxQuery } from "./repos/coordination.js";
export {
  getHumanRequest,
  listInbox,
  listTicketHumanRequests,
} from "./repos/coordination.js";
// A ticket's questions to the operator: what a session staffed onto it is told.
export type { TicketQuestion } from "./repos/open-questions.js";
export {
  TICKET_QUESTIONS_SHOWN,
  listTicketQuestions,
  openQuestionCounts,
} from "./repos/open-questions.js";
// Why a ticket waits: the board's set-based pass, and one ticket's next-step facts.
export type {
  NextStepDbFacts,
  TicketHolderFact,
  TicketReviewingFact,
} from "./repos/ticket-waits.js";
export { getNextStepFacts, listWaitFacts } from "./repos/ticket-waits.js";
export type {
  InboxAfter,
  InboxRequestsPage,
  InboxRequestsQuery,
  InboxRow,
} from "./repos/inbox.js";
export {
  getInboxRequest,
  inboxAfter,
  listInboxRequests,
} from "./repos/inbox.js";
export type { AuditRow } from "./repos/attribution.js";
export {
  listAuditByActor,
  listSessionHumanRequests,
} from "./repos/attribution.js";
// GET /audit (M4): newest first, paged by id, filtered by actor and action.
export type { AuditPage, AuditPageQuery } from "./repos/audit-page.js";
export { auditMatch, listAuditPage } from "./repos/audit-page.js";
export type { KnowledgeSearch } from "./repos/knowledge.js";
export { searchKnowledge } from "./repos/knowledge.js";
export { listTicketExports } from "./repos/ticket-exports.js";
export {
  getTicketEconomics,
  listNeedsAttention,
  listTicketFindings,
  listTicketGates,
  listTicketHandoffs,
  listTicketReviewRounds,
} from "./repos/work-views.js";
// 007_gates reads (M3). Their writers: the API's gate routes and the supervisor's decideGate.
export type {
  FindingsQuery,
  GateCursor,
  GateListRow,
  GateSession,
  GatesPage,
  GatesQuery,
} from "./repos/gates.js";
export {
  getGate,
  getRoleBinding,
  listGateFindings,
  listGateSessions,
  listGates,
  listGatesInState,
  listReviewerAgents,
  listRoleBindings,
  listUtilAgents,
  projectReviewerRunners,
} from "./repos/gates.js";
export {
  GATE_RUN,
  SESSION_STOP,
  gateReason,
  gateRunKey,
} from "./repos/gate-common.js";
// The gate engine finds a gate's gate.run by its key (§9): a read.
export { getCommandByIdempotencyKey } from "./repos/commands.js";
export type { OpenFinding } from "./repos/ticket-facts.js";
export {
  listExecutors,
  listModels,
  listRepos,
  listRunners,
  listWorkspaces,
} from "./repos/registry-reads.js";
// The Jira mirror's reads: a project's unstarted mirrored tickets, its last sync.
export type { JiraSyncRow, MirroredOpen } from "./repos/jira-reads.js";
export { lastJiraSync, mirroredOpenFingerprints } from "./repos/jira-reads.js";
// Jira follows the ticket: the pusher's reads past its watermarks, and its due pushes.
export type {
  JiraPushCursors,
  JiraPushSource,
  JiraPushSourceRows,
} from "./repos/jira-push-sources.js";
export {
  JIRA_PUSH_SOURCES,
  JIRA_PUSH_SOURCE_LIMIT,
  jiraPushSources,
} from "./repos/jira-push-sources.js";
export type { DueJiraPush } from "./repos/jira-pushes.js";
export { dueJiraPushes, jiraPushesOf } from "./repos/jira-pushes.js";
export type { JiraPushRow } from "./schema-jira-push.js";
export {
  deliveryConfigOf,
  docsSourceOf,
  jiraPushOf,
  jiraSourceOf,
  qaConfigOf,
} from "./repos/project-settings.js";
export type { DeliveryRow, DeliveryState } from "./schema-work.js";
export type { QaRunRow, QaRunSource, QaRunState } from "./schema-work.js";
export { latestQaRun, listQaRuns } from "./repos/qa-runs.js";
// GET /projects: workspaces with their repos, agents and open tickets.
export {
  listProjects,
  type ProjectAgent,
  type ProjectListing,
} from "./repos/project-reads.js";
// GET /projects/:id/timeline and its export: a project's history, one UNION, keyset-paged.
export type {
  TimelineAfter,
  TimelinePage,
  TimelineQuery,
  TimelineRow,
} from "./repos/timeline.js";
export { listTimeline, timelineAfter } from "./repos/timeline.js";
// GET /agents/:id/sessions: an agent's sessions newest first, for the replay list.
export type {
  AgentSessionRow,
  AgentSessionsAfter,
  AgentSessionsPage,
  AgentSessionsQuery,
} from "./repos/agent-sessions.js";
export {
  agentSessionsAfter,
  listAgentSessions,
} from "./repos/agent-sessions.js";
// 009_conformance reads (M3); the supervisor writes both tables.
export type {
  ConformanceProbeRow,
  RunnerCertificationRow,
  RunnerEligibility,
} from "./repos/certifications.js";
export {
  findLiveConformanceProbe,
  getLiveCertification,
  listRunnerCertifications,
  listRunnerEligibility,
} from "./repos/certifications.js";
// The models role bindings and agents run: what certification per model is checked on.
export type {
  AgentModel,
  BoundModel,
  SpawnModel,
} from "./repos/role-models.js";
export {
  agentModels,
  bindingModelOn,
  listBoundModels,
} from "./repos/role-models.js";
// The models enabled agents run, per role: uses beside the bindings' and step tiers'.
export type { AgentBoundModel } from "./repos/agent-bound-models.js";
export {
  agentBoundLabel,
  agentBoundModels,
} from "./repos/agent-bound-models.js";
// A project's tier per step (048): what bindingModelOn reads beside the binding's.
export type { StepRef } from "./repos/step-tiers.js";
export { stepTiersOf } from "./repos/step-tiers.js";
// Admission's facts (M4): the drain's counts and the retry-storm scan.
export {
  ADMITTED_STATES,
  countAdmittedSessions,
  countLiveSessionsOfRunner,
  listPairFailuresSince,
} from "./repos/admission.js";
// The watchdog's reads (M4): storm pairs, the breaker's facts, the split question.
export type {
  CircuitFacts,
  CircuitTicket,
  SplitAsk,
  StormPair,
  TicketFailureRow,
} from "./repos/watchdog-reads.js";
export {
  hasOpenSystemRequest,
  lastPairOkRunAt,
  listCircuitFacts,
  listSplitAsks,
  listStormPairs,
} from "./repos/watchdog-reads.js";
// 012_fleet reads (M4): budgets with their spend computed at read time, and the last
// backup. Budgets are the API's to write; backups the supervisor's.
export type { BackupOutcome, BackupRow, BudgetRow } from "./schema-fleet.js";
export type { BudgetStatus } from "./repos/budgets.js";
export { listBudgets } from "./repos/budgets.js";
export { getLastBackup, hasOkBackup } from "./repos/backups.js";
// Encrypted backups: the key (only its id is ever shown), the file header and names.
// The writers: writeBackup in /supervisor and /operator, restoreBackup in /operator.
export {
  BACKUP_KEY_NAME,
  BackupKey,
  backupKeyEnvWarning,
  backupKeyId,
  rotatedKeyName,
} from "./backup/key.js";
export type { OpenedBackup } from "./backup/format.js";
export {
  BACKUP_MAGIC,
  BackupHeader,
  readBackupHeader,
} from "./backup/format.js";
export type { Pruned } from "./backup/files.js";
export {
  BACKUPS_DIR,
  backupFileName,
  isBackupFileName,
  listBackupFiles,
} from "./backup/files.js";
// What a dead backup or restore left (plaintext temp files), swept at boot and by frm.
export type { Swept } from "./backup/sweep.js";
export {
  BACKUP_TEMP,
  RESTORE_TEMP,
  STALE_TEMP_MS,
  sweepBackupTemps,
  sweepRestoreTemps,
} from "./backup/sweep.js";
// Event retention: which events the supervisor's sweep may archive.
export type { ArchivableEvent } from "./repos/retention.js";
export {
  ARCHIVABLE_SESSION_STATES,
  ArchivableQuery,
  CLOSED_TICKET_STATUSES,
  MAX_RETENTION_BATCH,
  listArchivableEvents,
} from "./repos/retention.js";
export type {
  ExecutorHealth,
  SettingRow,
  WorkspaceRepo,
} from "./repos/config.js";
export {
  getActiveModel,
  getAgent,
  getModel,
  getExecutor,
  getMission,
  getProfile,
  getRepo,
  getRunner,
  getSettingRows,
  getSettings,
  getWorkspace,
  getWorkspaceRepos,
} from "./repos/config.js";
export type { MissionHistory, MissionSummary } from "./repos/missions.js";
export { getMissionHistory, getMissionVersion } from "./repos/missions.js";
export { getOpenRun, listRuns } from "./repos/runs.js";
export type { PromptTemplateRow } from "./repos/prompt-templates.js";
export { getPromptTemplate } from "./repos/prompt-templates.js";
// The worktree sweep's read and the arms no pulse runs for (§9, M4).
export type { SweepWorktree } from "./repos/worktree-sweep.js";
export {
  everHadWorktree,
  getSweepWorktree,
  listSweepWorktrees,
} from "./repos/worktree-sweep.js";
export { ATTENTION_ARMS, HUMAN_ONLY_ARMS, PULSE_ARMS } from "./schema-work.js";
// The notifier's reads: the rows past its watermarks and the arms standing, in one
// snapshot; the due deliveries; the outbox as the GUI pages it; each channel's last send and error.
export type {
  BlockRow,
  NotifyCursors,
  NotifySource,
  NotifySourceRows,
} from "./repos/notify-sources.js";
export {
  NOTIFY_SOURCES,
  NOTIFY_SOURCE_LIMIT,
  notifySources,
} from "./repos/notify-sources.js";
// The runner update check (051): the one read, shared by the Fleet and the notifier.
export type {
  OpenRunnerUpdate,
  RunnerUpdateSighting,
} from "./repos/runner-updates.js";
export { openRunnerUpdates } from "./repos/runner-updates.js";
export type { RunnerUpdateRow } from "./schema-runner-updates.js";
export type {
  ChannelStat,
  DueDelivery,
  NotificationWithDeliveries,
  NotificationsPageRows,
} from "./repos/notifications.js";
export {
  dueDeliveries,
  listNotifications,
  notifyChannelStats,
} from "./repos/notifications.js";
export type {
  NotificationDeliveryRow,
  NotificationRow,
} from "./schema-notify.js";
// The three destination settings as they stand; the writer is @bayon/db/api's.
export { getNotifyConfig } from "./repos/notify-config.js";
export type { HeldWorktree } from "./repos/worktrees.js";
export {
  countHandoffWorktreeRows,
  listHandoffWorktrees,
  listSessionWorktrees,
} from "./repos/worktrees.js";
export type { EventsQuery } from "./repos/events.js";
export {
  SUPERVISOR_RUNNER_TYPE,
  getEventsSince,
  getFirstTerminal,
  getMaxRawOffset,
  toCanonical,
} from "./repos/events.js";
export { getRun } from "./repos/runs.js";
export type {
  HandoffPage,
  HandoffQuery,
  StrandedHandoff,
} from "./repos/handoffs.js";
export {
  HANDOFF_ACCEPT_COLUMNS,
  HANDOFF_FACT_COLUMNS,
  HANDOFF_JUDGEMENT_COLUMNS,
  getHandoff,
  listHandoffs,
  listPendingHandoffs,
  listStrandedHandoffs,
  wherePendingHandoff,
} from "./repos/handoffs.js";
export type { EventRange } from "./repos/session-facts.js";
export {
  countRunTurnStarts,
  getSessionEventRange,
  listSessionCommands,
} from "./repos/session-facts.js";
// A session's context compression totals, from its terminals (049).
export type { SessionContext } from "./repos/session-context.js";
export { getSessionContext } from "./repos/session-context.js";
export { getRunSpend } from "./repos/spend.js";
export { getRunnerModel } from "./repos/in-flight.js";
export type { BurnMove } from "./repos/spend-math.js";
export type {
  ClassSpend,
  DailySpend,
  SpendGroup,
  SpendReport,
  SpendScope,
  SpendSettings,
  SpendSummary,
  TierSpend,
} from "./repos/spend-rollups.js";
export {
  ALARM_PCT_KEY,
  BASELINE_DAYS_KEY,
  SPEND_DEFAULTS,
  getSpendReport,
  getSpendSummary,
} from "./repos/spend-rollups.js";
export { getSupervisorState } from "./repos/state.js";
export type { FleetFilter, FleetListing, Heartbeat } from "./repos/fleet.js";
export {
  HEARTBEAT_KEY,
  getFleet,
  listRunClasses,
  readHeartbeat,
} from "./repos/fleet.js";
export {
  ENDED_STATES,
  findLiveByAgent,
  findLiveByRunnerSessionId,
  findLiveSessionByTokenHash,
  getSession,
  listLiveSessions,
  listSessionsInStates,
} from "./repos/sessions.js";
export { getCommand } from "./repos/commands.js";
// The reconciler's sweep of pending takeovers.
export { listAttachIntents } from "./repos/attach.js";
// The supervisor's read of §7.1's phase-boundary ask, and the key it is stored under.
export { askedPhaseHandoff, phaseHandoffKey } from "./repos/phase-handoff.js";
export { listMissionsForExport } from "./repos/exports-read.js";
