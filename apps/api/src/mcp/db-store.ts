// The McpStore over @bayon/db. Reads are the shared surface; writes are the API's (§9.5), each
// with its audit entry in the writer's own transaction. The API never writes `sessions`.
import {
  NO_DOCS_SOURCE,
  ok,
  ticketRefOf,
  type DocsSourceFields,
  type Result,
} from "@bayon/core";
import {
  docsSourceOf,
  findLiveConformanceProbe,
  findLiveSessionByTokenHash,
  findPulseBySession,
  getAgent,
  getHandoff,
  getMission,
  getOpenRun,
  getProbe,
  getProfile,
  getTicket,
  getTicketByNum,
  getWorkspace,
  listInbox,
  listTicketHandoffs,
  listTicketHumanRequests,
  searchKnowledge,
  type Db,
} from "@bayon/db";
import {
  acceptHandoff,
  appendAudit,
  appendKnowledge,
  insertCommand,
  askHumanRequests,
  markMessagesRead,
  resolveFinding,
  sendMessage,
  writeHandoffJudgement,
} from "@bayon/db/api";
import { CONFORMANCE_ECHO_TOOL, CONFORMANCE_ROLE } from "@bayon/proto";
import { z } from "zod";
import { loadTicketSettings } from "../tickets/ticket-settings.js";
import type { McpSession, McpStore, TicketTarget } from "./store.js";

/** Who a conformance probe's calls are from: no agent, and so no mission, mail or ticket. */
const PROBE_AGENT = "conformance-probe";

const Allowlist = z.array(z.unknown());

/** The stored allowlist, or null when it is not a JSON array: that serves no tools. */
function allowlistOf(json: string): readonly unknown[] | null {
  try {
    const parsed = Allowlist.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // not JSON: the drift check then fails closed
  }
}

/**
 * A conformance probe's token (§15 test 11): the conformance role's one tool, until the
 * probe ends. The toolset hash is the supervisor's, so a drifted catalogue still serves nothing.
 */
async function probeByTokenHash(
  db: Db,
  hash: string,
): Promise<Result<McpSession | null>> {
  const found = await findLiveConformanceProbe(db, hash);
  if (!found.ok) return found;
  const probe = found.value;
  if (probe === null) return ok(null);
  return ok({
    id: probe.id,
    role: CONFORMANCE_ROLE,
    agentId: PROBE_AGENT,
    agentName: PROBE_AGENT,
    ticketId: null,
    workspaceId: null,
    toolsetHash: probe.toolset_hash,
    allowlist: [CONFORMANCE_ECHO_TOOL],
  });
}

async function sessionByTokenHash(
  db: Db,
  hash: string,
): Promise<Result<McpSession | null>> {
  const found = await findLiveSessionByTokenHash(db, hash);
  if (!found.ok) return found;
  const s = found.value;
  if (s === null) return probeByTokenHash(db, hash);
  const agent = await getAgent(db, s.agent_id);
  if (!agent.ok) return agent;
  const profileId = agent.value.profile_id;
  const profile = profileId === null ? null : await getProfile(db, profileId);
  if (profile !== null && !profile.ok) return profile;
  return ok({
    id: s.id,
    role: s.role,
    agentId: s.agent_id,
    agentName: agent.value.name,
    ticketId: s.ticket_id,
    workspaceId: agent.value.workspace_id,
    toolsetHash: s.toolset_hash,
    // Only a probe token holds the conformance role's tool; a session claiming it is served nothing.
    allowlist:
      s.role === CONFORMANCE_ROLE
        ? null
        : profile === null
          ? []
          : allowlistOf(profile.value.tool_allowlist_json),
  });
}

/**
 * Where a project's documentation lives. A project that is gone reads as no source
 * rather than as an error: a session outliving its project has nothing to read, which is exactly
 * what the tool refuses with.
 */
async function docsSource(
  db: Db,
  workspaceId: string,
): Promise<Result<DocsSourceFields>> {
  const workspace = await getWorkspace(db, workspaceId);
  if (workspace.ok) return ok(docsSourceOf(workspace.value));
  return workspace.error.class === "not_found" ? ok(NO_DOCS_SOURCE) : workspace;
}

/** Every form a prompt shows: the id, the key by the prefix in force, #n and n. */
async function ticketOf(
  db: Db,
  ref: string,
): Promise<Result<TicketTarget | null>> {
  const settings = await loadTicketSettings(db);
  if (!settings.ok) return settings;
  const target = ticketRefOf(ref, settings.value["tickets.key_prefix"]);
  const found =
    "num" in target
      ? await getTicketByNum(db, target.num)
      : await getTicket(db, target.id);
  if (found.ok) {
    const { id, num, workspace_id } = found.value;
    return ok({ id, num, workspaceId: workspace_id });
  }
  return found.error.class === "not_found" ? ok(null) : found;
}

export function mcpDbStore(db: Db): McpStore {
  return {
    sessionByTokenHash: (hash) => sessionByTokenHash(db, hash),
    async mission(agentId) {
      const agent = await getAgent(db, agentId);
      if (!agent.ok) return agent;
      if (agent.value.mission_id === null) return ok(null);
      const mission = await getMission(db, agent.value.mission_id);
      return mission.ok
        ? ok({
            version: mission.value.version,
            text: mission.value.rendered_md,
          })
        : mission;
    },
    docsSource: (workspaceId) => docsSource(db, workspaceId),
    inbox: (agentName, o) =>
      listInbox(db, {
        to_kind: "agent",
        to_id: agentName,
        unread_only: o.unreadOnly,
        limit: o.limit,
      }),
    markRead: (agentName, ids) =>
      markMessagesRead(db, {
        to_kind: "agent",
        to_id: agentName,
        ids: [...ids],
      }),
    sendMessage: (m, audit) => sendMessage(db, m, audit),
    searchKnowledge: (q, limit) => searchKnowledge(db, { q, limit }),
    appendKnowledge: (k, audit) => appendKnowledge(db, k, audit),
    askHuman: (batch, audit) => askHumanRequests(db, batch, audit),
    ticketOf: (ref) => ticketOf(db, ref),
    humanRequests: (ticketId, limit) =>
      listTicketHumanRequests(db, ticketId, limit),
    async audit(entry) {
      const written = await appendAudit(db, entry);
      return written.ok ? ok(undefined) : written;
    },
    async pulseOfSession(sessionId) {
      const found = await findPulseBySession(db, sessionId);
      if (!found.ok) return found;
      return ok(
        found.value === null
          ? null
          : { id: found.value.id, state: found.value.state },
      );
    },
    async probeEnabled(name) {
      const found = await getProbe(db, name);
      if (found.ok) return ok(found.value.enabled === 1);
      return found.error.class === "not_found" ? ok(null) : found;
    },
    insertCommand: (command, audit, idempotencyKey) =>
      insertCommand(
        db,
        {
          type: command.type,
          payload: command.payload,
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        },
        audit,
      ),
    writeHandoff: (sessionId, judgement, audit) =>
      writeHandoffJudgement(db, sessionId, judgement, audit),
    acceptHandoff: (sessionId, handoffId, audit) =>
      acceptHandoff(
        db,
        {
          session_id: sessionId,
          ...(handoffId === undefined ? {} : { handoff_id: handoffId }),
        },
        audit,
      ),
    async handoff(id) {
      const found = await getHandoff(db, id);
      if (found.ok) return ok(found.value);
      return found.error.class === "not_found" ? ok(null) : found;
    },
    ticketHandoffs: (ticketId) => listTicketHandoffs(db, ticketId),
    async openRun(sessionId) {
      const run = await getOpenRun(db, sessionId);
      return run.ok ? ok(run.value?.id ?? null) : run;
    },
    resolveFinding: (r, audit) => resolveFinding(db, r, audit),
  };
}
