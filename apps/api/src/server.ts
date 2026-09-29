import "reflect-metadata";
import type { Clock } from "@bayon/core";
import {
  RequestMethod,
  type LoggerService,
  type LogLevel,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { z } from "zod";
import { AppModule } from "./app.module.js";
import type { ApiConfig } from "./config.js";
import type { SessionDiffService } from "./diffs/session-diff.js";
import { DEFAULT_MCP_LIMITS, type McpLimits } from "./mcp/limits.js";
import type { McpStore } from "./mcp/store.js";
import type { ApiStore } from "./store.js";
import type { GateService } from "./gates/gate-service.js";
import type { ExecutorsCreateService } from "./executors/executors-create-service.js";
import type { HistoryService } from "./history/history-service.js";
import type { DocsReader } from "./docs/reader.js";
import type { JiraService } from "./jira/service.js";
import type { NotificationsService } from "./notify/service.js";
import type { ProjectsService } from "./projects/projects-service.js";
import type { TicketService } from "./tickets/ticket-service.js";
import type { RelayClient } from "./relay/relay-client.js";
import { BearerWsAdapter } from "./ws/adapter.js";
import { WS_PATH } from "./ws/gateway.js";
import { WS_TUNING, type WsTuning } from "./ws/hub.js";

/** With the leading slash: Express 5 mounts Nest's JSON 404 handler at exactly this path. */
export const API_PREFIX = "/api/v1";

export interface ApiDeps {
  readonly config: ApiConfig;
  readonly store: ApiStore;
  readonly clock: Clock;
  readonly tuning?: WsTuning;
  /** Session payload files (§11.3) for the full-text route; absent or null serves none. */
  readonly runtimeDir?: string | null;
  /** Nest's logger; `false` silences it (tests). */
  readonly logger?: false | LoggerService | LogLevel[];
  /** The tickets module; boot always passes it, tests of other routes may leave it out. */
  readonly tickets?: TicketService;
  /** The gates module: /gates, /findings, /role-bindings; boot always passes it. */
  readonly gates?: GateService;
  /** The MCP server at /mcp; absent mounts none. */
  readonly mcp?: {
    readonly store: McpStore;
    readonly limits?: Partial<McpLimits>;
    /** doc_search and doc_get; absent leaves both failing, never served data. */
    readonly docs?: DocsReader;
  };
  /** GET /sessions/:id/diff; boot always passes it. */
  readonly diffs?: SessionDiffService;
  /** POST /projects; boot always passes it. */
  readonly projects?: ProjectsService;
  /** POST /executors; boot always passes it. */
  readonly executorsCreate?: ExecutorsCreateService;
  /** A project's timeline and export, an agent's sessions; boot always passes it. */
  readonly history?: HistoryService;
  /** A project's Jira mirror; boot always passes it. */
  readonly jira?: JiraService;
  /** The notifier's REST door; boot always passes it. */
  readonly notifications?: NotificationsService;
  /** session:<id>:pty (§12.5 point 3); absent (no FRM_HOME) mounts no /ws/pty. */
  readonly pty?: { readonly relay: RelayClient };
}

/** Outside /api/v1: session tokens live here, the operator bearer there. */
export const MCP_PATH = "/mcp";

export interface RunningApi {
  /** e.g. `http://127.0.0.1:3010/api/v1` */
  readonly url: string;
  /** e.g. `http://127.0.0.1:3010/mcp` */
  readonly mcpUrl: string;
  /** e.g. `ws://127.0.0.1:3010/ws` */
  readonly wsUrl: string;
  close(): Promise<void>;
}

const ListeningAddress = z.object({ port: z.int().positive() });

/** Builds the Nest app and listens on `config.host:config.port` (0 picks a free port). */
export async function startApi(deps: ApiDeps): Promise<RunningApi> {
  const app = await NestFactory.create(
    AppModule.register({
      config: deps.config,
      store: deps.store,
      clock: deps.clock,
      tuning: deps.tuning ?? WS_TUNING,
      runtimeDir: deps.runtimeDir ?? null,
      ...(deps.tickets === undefined ? {} : { tickets: deps.tickets }),
      ...(deps.gates === undefined ? {} : { gates: deps.gates }),
      ...(deps.diffs === undefined ? {} : { diffs: deps.diffs }),
      ...(deps.projects === undefined ? {} : { projects: deps.projects }),
      ...(deps.history === undefined ? {} : { history: deps.history }),
      ...(deps.jira === undefined ? {} : { jira: deps.jira }),
      ...(deps.notifications === undefined
        ? {}
        : { notifications: deps.notifications }),
      ...(deps.executorsCreate === undefined
        ? {}
        : { executorsCreate: deps.executorsCreate }),
      ...(deps.pty === undefined ? {} : { pty: deps.pty }),
      ...(deps.mcp === undefined
        ? {}
        : {
            mcp: {
              store: deps.mcp.store,
              limits: { ...DEFAULT_MCP_LIMITS, ...deps.mcp.limits },
              runtimeDir: deps.runtimeDir ?? null,
              ...(deps.tickets === undefined ? {} : { tickets: deps.tickets }),
              ...(deps.mcp.docs === undefined ? {} : { docs: deps.mcp.docs }),
            },
          }),
    }),
    {
      abortOnError: false,
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    },
  );
  app.setGlobalPrefix(API_PREFIX, {
    exclude: [{ path: MCP_PATH.slice(1), method: RequestMethod.ALL }],
  });
  app.useWebSocketAdapter(new BearerWsAdapter(app, deps.config.token));
  try {
    await app.listen(deps.config.port, deps.config.host);
  } catch (cause) {
    await app.close();
    throw new Error(
      `API could not listen on ${deps.config.host}:${deps.config.port}`,
      {
        cause,
      },
    );
  }
  const { port } = ListeningAddress.parse(app.getHttpServer().address());
  const origin = `${deps.config.host}:${port}`;
  return {
    url: `http://${origin}${API_PREFIX}`,
    mcpUrl: `http://${origin}${MCP_PATH}`,
    wsUrl: `ws://${origin}${WS_PATH}`,
    close: () => app.close(),
  };
}
