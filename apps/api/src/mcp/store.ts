// What /mcp reads and writes itself: the session behind a token, the
// non-ticket tools' rows and the audit log. Ticket writes go through TicketService.
import type { DocsSourceFields, Result } from "@bayon/core";
import type {
  FindingRow,
  HandoffRow,
  HumanRequestRow,
  KnowledgeRow,
  MessageRow,
} from "@bayon/db";
import type {
  AcceptOutcome,
  AskedHumanRequests,
  AuditEntry,
  HandoffJudgement,
  NewHumanRequest,
  NewKnowledge,
  NewMessage,
  ResolveFinding,
} from "@bayon/db/api";
import type { Command } from "@bayon/proto";

/** The live session a token belongs to, with what its tool set is computed from. */
export interface McpSession {
  readonly id: string;
  readonly role: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly ticketId: string | null;
  /**
   * The project (workspace) of the session's agent, or null: the fleet. An orchestrator
   * with one sees and acts on only that project's tickets.
   */
  readonly workspaceId: string | null;
  /** What the supervisor hashed at resolve: the only tool set ever served. */
  readonly toolsetHash: string | null;
  /** The profile's allowlist now; null when it cannot be read, which serves nothing. */
  readonly allowlist: readonly unknown[] | null;
}

export interface McpMission {
  readonly version: number;
  readonly text: string;
}

/**
 * A ticket as a write's target: its id to scope by, its number to name it to the service, and its
 * project to hold a project's orchestrator to.
 */
export interface TicketTarget {
  readonly id: string;
  readonly num: number;
  readonly workspaceId: string | null;
}

export interface McpStore {
  /** The live session holding `hash`, or null: unknown, ended or re-minted. */
  sessionByTokenHash(hash: string): Promise<Result<McpSession | null>>;
  /** The agent's current mission, or null without one. */
  mission(agentId: string): Promise<Result<McpMission | null>>;
  /** Where project `workspaceId`'s documentation lives; `kind: "none"` for a project with none. */
  docsSource(workspaceId: string): Promise<Result<DocsSourceFields>>;
  inbox(
    agentName: string,
    o: { readonly unreadOnly: boolean; readonly limit: number },
  ): Promise<Result<MessageRow[]>>;
  /** Marks those of `ids` addressed to `agentName` read; returns how many were unread. */
  markRead(agentName: string, ids: readonly string[]): Promise<Result<number>>;
  sendMessage(m: NewMessage, audit: AuditEntry): Promise<Result<MessageRow>>;
  searchKnowledge(q: string, limit: number): Promise<Result<KnowledgeRow[]>>;
  appendKnowledge(
    k: NewKnowledge,
    audit: AuditEntry,
  ): Promise<Result<KnowledgeRow>>;
  /** human_ask's batch: each request new, or the same question still open on the ticket. */
  askHuman(
    batch: readonly NewHumanRequest[],
    audit: AuditEntry,
  ): Promise<Result<AskedHumanRequests>>;
  /** The ticket a ref names (its id, key, #n or n: core ticketRefOf), or null when none does. */
  ticketOf(ref: string): Promise<Result<TicketTarget | null>>;
  /** A ticket's human requests, newest first. */
  humanRequests(
    ticketId: string,
    limit: number,
  ): Promise<Result<HumanRequestRow[]>>;
  /** One audit row in its own transaction: a refused attempt, or a TicketService write. */
  audit(entry: AuditEntry): Promise<Result<void>>;
  /** The pulse `sessionId` runs, or null: how pulse_report and probe_run find their pulse. */
  pulseOfSession(
    sessionId: string,
  ): Promise<Result<{ readonly id: string; readonly state: string } | null>>;
  /** Whether the probe is enabled; null when no probe has that name. */
  probeEnabled(name: string): Promise<Result<boolean | null>>;
  /**
   * One command, with the call's audit entry in its transaction (§9.5: commands are the API's). A
   * repeated idempotency key returns the first command.
   */
  insertCommand(
    command: Command,
    audit: AuditEntry,
    idempotencyKey?: string,
  ): Promise<Result<{ readonly id: string; readonly created: boolean }>>;
  /** handoff_write: the judgement of the session's own writing row; `conflict` once it is sealed. */
  writeHandoff(
    sessionId: string,
    judgement: HandoffJudgement,
    audit: AuditEntry,
  ): Promise<Result<HandoffRow>>;
  /** handoff_accept: takes a pending hand-off, or claims the session's unowned ticket. */
  acceptHandoff(
    sessionId: string,
    handoffId: string | undefined,
    audit: AuditEntry,
  ): Promise<Result<AcceptOutcome>>;
  /** A hand-off by id, or null when none has it. */
  handoff(id: string): Promise<Result<HandoffRow | null>>;
  /** A ticket's hand-offs, oldest first: its chain. */
  ticketHandoffs(ticketId: string): Promise<Result<HandoffRow[]>>;
  /** The session's open run (its latest with no terminal event), or null: finding_resolve's fix. */
  openRun(sessionId: string): Promise<Result<string | null>>;
  /** finding_resolve: open → resolved; the writer refuses a run on another ticket. */
  resolveFinding(
    r: ResolveFinding,
    audit: AuditEntry,
  ): Promise<Result<FindingRow>>;
}
