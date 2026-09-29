import { join } from "node:path";
import { err, ok, type Clock, type Result } from "@bayon/core";
import { Logger } from "@nestjs/common";
import {
  getSettings,
  migrationStatus,
  openDb,
  type Db,
  type MigrationRef,
  type MigrationStatus,
} from "@bayon/db";
import {
  loadArtifactsDir,
  loadConfig,
  loadDbPath,
  loadFrmHome,
  loadMirrorsRoot,
  loadRuntimeDir,
  loadWorkRoot,
} from "./config.js";
import { dbStore } from "./db-store.js";
import { SessionDiffService } from "./diffs/session-diff.js";
import { ExecutorsCreateService } from "./executors/executors-create-service.js";
import { mcpDbStore } from "./mcp/db-store.js";
import { MCP_SETTING_KEYS, mcpLimits, type McpLimits } from "./mcp/limits.js";
import { connectRelay, type RelayClient } from "./relay/relay-client.js";
import { startApi, type ApiDeps, type RunningApi } from "./server.js";
import { GateService } from "./gates/gate-service.js";
import { HistoryService } from "./history/history-service.js";
import { DocsReader } from "./docs/reader.js";
import { JiraPusher } from "./jira/pusher.js";
import { JiraScheduler } from "./jira/scheduler.js";
import { JiraService } from "./jira/service.js";
import { JiraSync, type JiraLogger } from "./jira/sync.js";
import { jiraTokenStore } from "./jira/token.js";
import { buildChannels } from "./notify/channels/index.js";
import type { NotifyLogger } from "./notify/deliver.js";
import { Notifier } from "./notify/notifier.js";
import { NotificationsService } from "./notify/service.js";
import { mailParties } from "./notify/settings.js";
import { ProjectsService } from "./projects/projects-service.js";
import { TicketService } from "./tickets/ticket-service.js";

/** The relay socket's path under FRM_HOME (apps/supervisor/src/paths.ts's relaySocketPath): a
 * sibling to the control socket, one per FRM_HOME. Duplicated, not imported — apps/api has no
 * dependency on apps/supervisor, only on the shared packages/* both sides import. */
const relaySocketPath = (home: string): string => join(home, "relay.sock");

export interface BootedApi {
  readonly api: RunningApi;
  /** Stops the API, then closes its database connection. */
  close(): Promise<void>;
}

const tag = (m: MigrationRef) =>
  `${String(m.version).padStart(3, "0")}_${m.name}`;

/**
 * The API serves only a fully migrated database: the supervisor owns migrations (it runs them at
 * boot), so pending or drifted files mean this API and that DB do not belong together yet.
 */
export function checkMigrations(status: MigrationStatus): Result<void> {
  if (status.drifted.length > 0)
    return err({
      class: "validation",
      message: `migrations drifted: ${status.drifted.map(tag).join(", ")}; restore the applied files`,
      retryable: false,
    });
  if (status.pending.length > 0)
    return err({
      class: "validation",
      message: `migrations pending: ${status.pending.map(tag).join(", ")}; start the supervisor or run migrate:up`,
      retryable: false,
    });
  return ok(undefined);
}

async function migrated(db: Db): Promise<Result<void>> {
  const status = await migrationStatus(db);
  return status.ok ? checkMigrations(status.value) : status;
}

/** The MCP limits from `settings` (mcp.*), each absent one at its default. */
async function loadMcpLimits(db: Db): Promise<Result<McpLimits>> {
  const rows = await getSettings(db, [...MCP_SETTING_KEYS]);
  return rows.ok ? mcpLimits(Object.fromEntries(rows.value)) : rows;
}

/** Nest's logger under `jira`: silent when the app's logger is (tests pass `logger: false`). */
function jiraLogger(): JiraLogger {
  const log = new Logger("jira");
  return {
    warn: (message) => log.warn(message),
    error: (message) => log.error(message),
  };
}

/** Nest's logger under `notify`, as the Jira timer's. */
function notifyLogger(): NotifyLogger {
  const log = new Logger("notify");
  return {
    warn: (message) => log.warn(message),
    error: (message) => log.error(message),
  };
}

/** Config from `env`, the DB opened and checked, then the API listening. Refuses rather than half-starts. */
export async function bootApi(o: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock: Clock;
  readonly logger?: ApiDeps["logger"];
}): Promise<Result<BootedApi>> {
  const config = loadConfig(o.env);
  if (!config.ok) return config;
  const path = loadDbPath(o.env);
  if (!path.ok) return path;
  const opened = await openDb({ path: path.value, clock: o.clock });
  if (!opened.ok) return opened;
  const db = opened.value;
  const ready = await migrated(db);
  if (!ready.ok) {
    await db.close();
    return ready;
  }
  const limits = await loadMcpLimits(db);
  if (!limits.ok) {
    await db.close();
    return limits;
  }
  const frmHome = loadFrmHome(o.env);
  // Absent without FRM_HOME (e.g. FRM_DB set directly): no relay socket to find, so no /ws/pty —
  // matching how ExecutorsCreateService already degrades when frmHome is null.
  let relay: RelayClient | undefined;
  try {
    const runtimeDir = loadRuntimeDir(o.env);
    if (frmHome !== null) relay = connectRelay(relaySocketPath(frmHome));
    const logger = jiraLogger();
    // The host store JIRA_API_TOKEN is read from at each sync, built once as the supervisor's is.
    const token = jiraTokenStore(o.env);
    const jiraSync = new JiraSync({ db, token, logger });
    // The notifier's destinations are read from the same host store, at each send.
    const channels = buildChannels({
      secrets: token.secrets,
      parties: () => mailParties(db),
    });
    const api = await startApi({
      config: config.value,
      store: dbStore(db),
      clock: o.clock,
      runtimeDir,
      logger: o.logger,
      tickets: new TicketService({
        db,
        clock: o.clock,
        workRoot: loadWorkRoot(o.env),
      }),
      gates: new GateService({ db }),
      projects: new ProjectsService({
        db,
        clock: o.clock,
        mirrorsRoot: loadMirrorsRoot(o.env),
      }),
      history: new HistoryService({ db, clock: o.clock }),
      jira: new JiraService({ db, sync: jiraSync, token }),
      notifications: new NotificationsService({
        db,
        clock: o.clock,
        channels,
        store: { kind: token.kind, keychain: token.keychain },
        logger: notifyLogger(),
      }),
      executorsCreate: new ExecutorsCreateService({
        db,
        clock: o.clock,
        frmHome,
      }),
      diffs: new SessionDiffService({
        db,
        clock: o.clock,
        runtimeDir,
        workRoot: loadWorkRoot(o.env),
        artifactsDir: loadArtifactsDir(o.env),
      }),
      mcp: {
        store: mcpDbStore(db),
        limits: limits.value,
        // The documentation reader uses the mirror's own host-store token: one account, one
        // secret, two read-only surfaces (§14).
        docs: new DocsReader({ token }),
      },
      ...(relay === undefined ? {} : { pty: { relay } }),
    });
    // Started once the API listens; stopped first on close, so no sync outlives the DB handle.
    const jiraTimer = new JiraScheduler({
      db,
      clock: o.clock,
      sync: jiraSync,
      logger,
    });
    jiraTimer.start();
    const notifier = new Notifier({
      db,
      clock: o.clock,
      channels,
      logger: notifyLogger(),
    });
    notifier.start();
    // Jira follows the ticket: the mirror's own token, read at each tick that sends.
    const jiraPusher = new JiraPusher({
      db,
      clock: o.clock,
      token,
      logger,
    });
    jiraPusher.start();
    return ok({
      api,
      close: async () => {
        await jiraPusher.stop();
        await notifier.stop();
        await jiraTimer.stop();
        await api.close();
        relay?.close();
        await db.close();
      },
    });
  } catch (cause) {
    relay?.close();
    await db.close();
    return err({
      class: "internal",
      message:
        cause instanceof Error ? cause.message : "the API failed to start",
      retryable: false,
      cause,
    });
  }
}
