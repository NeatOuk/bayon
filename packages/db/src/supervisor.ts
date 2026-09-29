// @bayon/db/supervisor: migrations and the supervisor's writers (§9.5). apps/api must not import it.
export { migrateDown, migrateUp } from "./migrate.js";
export type { AttachIntent, AttachReleased } from "./repos/attach.js";
// a pending "take over after this step", set and cleared by the supervisor alone.
export {
  clearAttachIntent,
  recordAttachRelease,
  setAttachIntent,
} from "./repos/attach.js";
export type { EventInsert } from "./repos/events.js";
export { insertEventsBatch } from "./repos/events.js";
export type {
  NewSession,
  PendingPins,
  SessionCas,
  SessionPatch,
} from "./repos/sessions.js";
export {
  createSession,
  releaseExpiredLeases,
  renewAttachLease,
  // A pending session re-pinned by its re-admission (M4).
  repinPendingSession,
  setSessionTokenHash,
  updateSessionState,
} from "./repos/sessions.js";
export { setExecutorHealth } from "./repos/config.js";
// deliveries: what one ticket's work reached on its project's own remote, plus the two
// ticket writes that go with it (§9.5 amendment: the design §1.6).
export type {
  DeliveredPr,
  DeliveryCommit,
  DeliveryCommitted,
  DeliveryRecord,
} from "./repos/delivery-writes.js";
export {
  DELIVERY_ACTION,
  DELIVERY_ACTOR_ID,
  DELIVERY_ERROR_MAX,
  PR_LINK_KIND,
  commitDelivery,
  recordDelivery,
} from "./repos/delivery-writes.js";
// pull requests: what the pull-request sweep read from the forge — merged, closed or
// unreadable — and, in the same transaction, merge_close through advanceTicketIn.
export type {
  PullRequestSeen,
  PullRequestSettle,
  PullRequestsSettled,
} from "./repos/pull-request-writes.js";
export {
  PULL_REQUESTS_ACTION,
  settlePullRequests,
} from "./repos/pull-request-writes.js";
// CI progress: how far a CI gate's pull requests' checks have got, on the supervisor's
// own `deliveries` rows, written only when it changed. The decision is decideGate's.
export type { CiProgressRecord, CiRead } from "./repos/ci-gates.js";
export { recordCiProgress } from "./repos/ci-gates.js";
// backups: one row per finished attempt (M4); the nightly job writes it, and
// the encrypted file with writeBackup.
export type { NewBackup } from "./repos/backups.js";
export { recordBackup } from "./repos/backups.js";
export type { WriteBackupOptions, WrittenBackup } from "./backup/backup.js";
export { writeBackup } from "./backup/backup.js";
// Event retention: archived rows leave events, a batch per transaction.
export { deleteArchivedEvents } from "./repos/retention.js";
export type {
  NewWorktree,
  WorktreeReassign,
  WorktreesReassign,
} from "./repos/worktrees.js";
export {
  insertWorktree,
  reassignWorktree,
  reassignWorktrees,
  setWorktreeState,
  setWorktreeSubmodules,
} from "./repos/worktrees.js";
// The worktree sweep's writers (M4): its flag, and its one state write, `removed`,
// each a compare-and-set.
export type { SweptRow } from "./repos/worktree-sweep.js";
export {
  clearWorktreeFlag,
  flagWorktree,
  markWorktreeRemoved,
} from "./repos/worktree-sweep.js";
export type { NewRun, RunFinish } from "./repos/runs.js";
export { appendRun, finishRun } from "./repos/runs.js";
export type { NewSpend } from "./repos/spend.js";
export { insertSpend } from "./repos/spend.js";
// The in-flight ceilings' mid-run cost and context peak.
export type { InFlight } from "./repos/in-flight.js";
export { setSessionInFlight } from "./repos/in-flight.js";
export type {
  CompleteCommand,
  RequeueClaimed,
  Requeued,
} from "./repos/commands.js";
// requeueClaimedCommands: claimed commands requeued or failed, audited (M4, rule 2).
export {
  claimCommand,
  completeCommand,
  requeueClaimedCommands,
} from "./repos/commands.js";
export type {
  NewExecutor,
  NewModel,
  NewRunner,
  Registration,
} from "./repos/registration.js";
export { upsertExecutor, upsertRegistration } from "./repos/registration.js";
export type { NewPromptTemplate } from "./repos/prompt-templates.js";
export { upsertPromptTemplates } from "./repos/prompt-templates.js";
export { heartbeat } from "./repos/fleet.js";
export { setSupervisorState } from "./repos/state.js";
// handoffs: the facts columns, each write audited with actor_kind='supervisor' (rule 2).
export type {
  FinalizeHandoff,
  InsertedHandoff,
  NewHandoffFacts,
  RenderedPacket,
  SealHandoff,
  Sealed,
} from "./repos/handoffs.js";
export {
  finalizeHandoffPacket,
  insertHandoffFacts,
  sealHandoff,
} from "./repos/handoffs.js";
// pulse_checks: the probe runner's results (M2).
export type { NewPulseCheck } from "./repos/pulse-checks.js";
export { insertPulseChecks } from "./repos/pulse-checks.js";
// ticket_exports: the exporter's script runner reports, the supervisor writes (M1 amendment 5).
export type { TicketExportUpsert } from "./repos/ticket-exports.js";
export { upsertTicketExport } from "./repos/ticket-exports.js";
// pulses: the scheduler's lease, report, settle and expiry (M2).
export type {
  ExpiredPulse,
  LeaseOutcome,
  NewLease,
  PulseCas,
  PulsePatch,
  PulseReport,
  PulseRunFacts,
  SettlePulse,
} from "./repos/pulse-writes.js";
export {
  applyPulseReport,
  leasePulse,
  releaseExpiredPulseLeases,
  resumPulseCosts,
  settlePulse,
  updatePulse,
} from "./repos/pulse-writes.js";
// gates and findings: decideGate, the supervisor's one gate writer (M3 rule 2). It runs
// verdict() itself and may reopen a timed-out gate in the same transaction.
export type { Decided, GateDecision } from "./repos/gate-decide.js";
export {
  FINDING_DETAIL_CAP,
  FINDING_SUMMARY_CAP,
  decideGate,
} from "./repos/gate-decide.js";
// Conformance per (runner, executor) and its probe tokens (M3).
export type {
  Decertification,
  NewCertification,
  NewConformanceProbe,
} from "./repos/certifications.js";
export {
  closeConformanceProbe,
  decertifyPairs,
  openConformanceProbe,
  storeCertification,
} from "./repos/certifications.js";
export type { ScratchIdentity } from "./repos/conformance-scratch.js";
export { seedConformanceScratch } from "./repos/conformance-scratch.js";
// The watchdog's two writers to API-owned tables (M4, rule 2): system human_requests,
// keyed so one condition and window gives one row, and the circuit breaker's block, through core's
// laws, with its request in the same transaction. Both audited actor 'supervisor'.
export type { SystemRequestWritten } from "./repos/system-requests.js";
export { insertSystemHumanRequest } from "./repos/system-requests.js";
export type { BlockOutcome, BlockTicket } from "./repos/block-ticket.js";
export { blockTicket } from "./repos/block-ticket.js";
// The machine steps (rule 2's second ticket write): after a gate decides, the one edge
// its stored facts settle, through core's laws as the supervisor; decideGate runs it in its own
// transaction. Audited actor 'supervisor'.
export type { AdvanceCause, AdvanceOutcome } from "./repos/advance-ticket.js";
export { advanceTicket } from "./repos/advance-ticket.js";
// the QA gate a ticket already at qa_harness is owed (it crossed pass_review while its
// project ran no QA), opened by the machine sweep as pass_review would have opened it.
export type { HarnessOpened } from "./repos/harness-open.js";
export { OPEN_HARNESS_ACTION, openOwedHarness } from "./repos/harness-open.js";
// The runner update check's job (051): upserts by (runner_id, latest) on every check.
export { recordRunnerUpdate } from "./repos/runner-updates.js";
