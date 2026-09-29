import type { EventKind, OperatorSettingsPatch, Result } from "@bayon/core";
import type {
  AgentPulsesPage,
  AttentionAck,
  AuditPage,
  AuditQuery,
  BudgetSettings,
  BudgetView,
  BudgetsView,
  FleetPauseState,
  OperatorSettingsView,
  Command,
  CommandView,
  EventsPage,
  ExecutorsView,
  Fleet,
  HandoffDetail,
  HandoffsPage,
  InboxItem,
  MissionSaveRequest,
  MissionVersion,
  MissionView,
  PulseDetail,
  PulsePolicy,
  PulsePolicyPatch,
  PulsesPage,
  PutBudget,
  RunnersView,
  RunnerUpdateDismissed,
  ModelCreateRequest,
  ModelPatchRequest,
  ModelWriteReply,
  SessionView,
  SpendQuery,
  SpendReport,
  WorkspacesView,
} from "@bayon/proto";
import type { FeedSource } from "./ws/hub.js";

/** A stored `commands` row, as much of it as an Idempotency-Key lookup needs. */
export interface StoredCommand {
  readonly id: string;
  readonly type: string;
  readonly payload: unknown;
}

/**
 * Everything the API reads, plus its writes: `commands` (§9.5), the budget cap (§12.1) and mission
 * versions (M1 contract 7). The real implementation sits over `@bayon/db/api`; every value it
 * returns is already a proto DTO.
 */
export interface ApiStore extends FeedSource {
  /** Every live session, or one project's (`GET /fleet?project=`); the rest fleet-wide. */
  fleet(filter?: { readonly project?: string }): Promise<Result<Fleet>>;
  session(id: string): Promise<Result<SessionView>>;
  eventsSince(q: {
    readonly sessionId: string;
    readonly since: number;
    readonly limit: number;
    readonly kinds?: readonly EventKind[];
  }): Promise<Result<EventsPage>>;
  /** Idempotent on `idempotencyKey`: the same command again is `created: false`, another is `conflict`. */
  insertCommand(c: {
    readonly command: Command;
    readonly idempotencyKey?: string;
  }): Promise<Result<{ readonly id: string; readonly created: boolean }>>;
  command(id: string): Promise<Result<CommandView>>;
  /**
   * The command an Idempotency-Key created, or null: only what tells a repeated request from a
   * reused key. Not a `CommandView` — a key lookup answers nothing about the queue.
   */
  commandByIdempotencyKey(key: string): Promise<Result<StoredCommand | null>>;
  getBudgetSettings(): Promise<Result<BudgetSettings>>;
  setBudgetSettings(settings: BudgetSettings): Promise<Result<BudgetSettings>>;
  /** §13.4's budgets, each with its spend over the window holding now (§12.1 GET /budgets). */
  budgets(): Promise<Result<BudgetsView>>;
  /** Replaces the budget of its scope and period whole, audited; `kill` is refused. */
  putBudget(b: PutBudget): Promise<Result<BudgetView>>;
  /** Deletes one budget, audited; a missing id is not_found. */
  deleteBudget(id: string): Promise<Result<BudgetView>>;
  /** The agent's newest mission and its changelog; not_found for an unknown agent name. */
  missionHistory(agent: string): Promise<Result<MissionView>>;
  missionVersion(
    agent: string,
    version: number,
  ): Promise<Result<MissionVersion>>;
  /**
   * Saves `base_version + 1` and points the agent at it. A stale base is `conflict` whose cause
   * carries `current_version`.
   */
  saveMission(
    agent: string,
    body: MissionSaveRequest,
  ): Promise<Result<MissionVersion>>;
  /**
   * `GET /spend?group=&project=` (§8.9): the summary and one grouping's rows, one project's when
   * `project` is set. Spend is read, never written.
   */
  spendReport(query: SpendQuery): Promise<Result<SpendReport>>;
  /**
   * The operator's answer to an open human request, audited in the same transaction. Final: an
   * answered request is `conflict`, an unknown one `not_found`.
   */
  answerHumanRequest(id: string, answer: string): Promise<Result<InboxItem>>;
  /**
   * The operator dismisses an open question as no longer relevant, audited in the same
   * transaction: closed with no answer, as a last answer would close it. `conflict` once closed,
   * `not_found` unknown, `validation` for a staffing proposal (rejected instead).
   */
  dismissHumanRequest(id: string): Promise<Result<InboxItem>>;
  /** One human request as the inbox shows it; not_found for an unknown id. */
  inboxItem(id: string): Promise<Result<InboxItem>>;
  /** `GET /pulses` (M2): newest first, optionally one agent's. The supervisor writes pulses. */
  pulses(q: {
    readonly agentId?: string;
    readonly limit: number;
  }): Promise<Result<PulsesPage>>;
  /** `GET /pulses/:id`: the pulse and its probe checks. */
  pulse(id: string): Promise<Result<PulseDetail>>;
  /** An agent's kind (run-now pulses orchestrators only); not_found for an unknown id. */
  agentKind(id: string): Promise<Result<string>>;
  /** `PATCH /agents/:id/pulse-policy`: sets the given fields, audited as the operator's. */
  setPulsePolicy(
    agentId: string,
    patch: PulsePolicyPatch,
  ): Promise<Result<PulsePolicy>>;
  /** `GET /agents/pulse-policies`: every agent that pulses, its policy and next pulse as of `now`. */
  pulseAgents(now: number): Promise<Result<AgentPulsesPage>>;
  /** `GET /handoffs` (M2): oldest first; a ticket's by id or number; only pending ones on request. */
  handoffs(q: {
    readonly ticket?: string;
    readonly pending: boolean;
    readonly limit: number;
  }): Promise<Result<HandoffsPage>>;
  /** `GET /handoffs/:id`: the whole row, its facts and its judgement. */
  handoff(id: string): Promise<Result<HandoffDetail>>;
  /** `GET /runners`: every runner with its certification per (executor, model). */
  runners(): Promise<Result<RunnersView>>;
  /**
   * The rows exist and fit: what runner.conformance may name. An unknown runner or executor is
   * `not_found`; a model that is not an active model of that runner is `validation`; a
   * compression run on an executor that is not local is `validation` (the context proxy
   * runs beside the supervisor).
   */
  conformanceTarget(
    runnerId: string,
    executorId: string,
    modelId: string,
    compression?: boolean,
  ): Promise<Result<void>>;
  /**
   * `POST /runners/:id/models`: a new operator model, judged by the runner's adapter,
   * the tier rule the writer's, audited. Settings are shell-only (`frm config apply --yes`).
   */
  createModel(
    runnerId: string,
    body: ModelCreateRequest,
  ): Promise<Result<ModelWriteReply>>;
  /** `PATCH /runners/:id/models/:model`: tier, effort, prices, context or active; audited. */
  patchModel(
    runnerId: string,
    modelId: string,
    body: ModelPatchRequest,
  ): Promise<Result<ModelWriteReply>>;
  /** `DELETE /runners/:id/models/:model`: turned off (never deleted), the operator's; audited. */
  deactivateModel(
    runnerId: string,
    modelId: string,
  ): Promise<Result<ModelWriteReply>>;
  /**
   * `POST /runners/:id/updates/:version/dismiss`: the operator dismisses one open
   * update check, audited. Idempotent; `not_found` for a (runner, latest) pair never seen.
   */
  dismissRunnerUpdate(
    runnerId: string,
    latest: string,
  ): Promise<Result<RunnerUpdateDismissed>>;
  /** `GET /executors`: every executor row, its health detail and config parsed. */
  executors(): Promise<Result<ExecutorsView>>;
  /** The row exists: what executor.health may name. An unknown one is `not_found`. */
  executorExists(id: string): Promise<Result<void>>;
  /** `GET /workspaces`: every workspace row, for the New ticket dialog's picker. */
  workspaces(): Promise<Result<WorkspacesView>>;
  /** `POST /fleet/pause|resume` (M4): sets fleet.paused, audited as the operator's; idempotent. */
  setFleetPaused(paused: boolean): Promise<Result<FleetPauseState>>;
  /**
   * `POST /fleet/attention/:sessionId/ack`: dismisses a finished session's error from
   * the strip for good, audited. Refuses anything but an error exit; idempotent.
   */
  ackAttention(sessionId: string): Promise<Result<AttentionAck>>;
  /** `GET /settings` (M4): every whitelisted key with its value, default and last write. */
  operatorSettings(): Promise<Result<OperatorSettingsView>>;
  /** `PUT /settings`: checked against the whitelist, each change audited; answers the new view. */
  putOperatorSettings(
    patch: OperatorSettingsPatch,
  ): Promise<Result<OperatorSettingsView>>;
  /** `GET /audit` (M4): audit_log newest first, filtered by actor and action. */
  audit(q: AuditQuery): Promise<Result<AuditPage>>;
}
