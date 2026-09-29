import { readFile } from "node:fs/promises";
import type { Clock } from "@bayon/core";
import { Module, type DynamicModule } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_PIPE } from "@nestjs/core";
import { AuditController } from "./audit.controller.js";
import { BearerGuard } from "./auth.js";
import { CommandsService } from "./commands.service.js";
import type { ApiConfig } from "./config.js";
import {
  BudgetsController,
  CommandsController,
  ExportsController,
  FleetController,
  HealthController,
  SessionsController,
  SettingsController,
  SpendController,
} from "./controllers.js";
import { ErrorFilter, validationPipe } from "./errors.js";
import type { ExecutorsCreateService } from "./executors/executors-create-service.js";
import { ExecutorsCreateController } from "./executors/executors-create.controller.js";
import { ExecutorsController } from "./executors.controller.js";
import { HandoffsController } from "./handoffs.controller.js";
import { InboxController } from "./inbox.controller.js";
import { McpController } from "./mcp/controller.js";
import type { GateService } from "./gates/gate-service.js";
import {
  FindingsController,
  GatesController,
  RoleBindingsController,
} from "./gates/gates.controller.js";
import { SessionDiffController } from "./diffs/session-diff.controller.js";
import type { SessionDiffService } from "./diffs/session-diff.js";
import { RunnersController } from "./runners.controller.js";
import type { McpDeps } from "./mcp/server.js";
import { MissionsController } from "./missions.controller.js";
import type { HistoryService } from "./history/history-service.js";
import {
  AgentSessionsController,
  ProjectHistoryController,
} from "./history/history.controller.js";
import { JiraController, JiraTokenController } from "./jira/jira.controller.js";
import type { JiraService } from "./jira/service.js";
import { NotificationsController } from "./notify/notifications.controller.js";
import type { NotificationsService } from "./notify/service.js";
import type { ProjectsService } from "./projects/projects-service.js";
import { FoldersController } from "./projects/folders/folders.controller.js";
import type { FoldersService } from "./projects/folders/folders-service.js";
import {
  AgentEditController,
  ProjectsController,
} from "./projects/projects.controller.js";
import { AgentsController, PulsesController } from "./pulses.controller.js";
import type { ApiStore } from "./store.js";
import type { TicketService } from "./tickets/ticket-service.js";
import { TicketsController } from "./tickets/tickets.controller.js";
import { WorkspacesController } from "./workspaces.controller.js";
import {
  API_CONFIG,
  API_STORE,
  CLOCK,
  DIFF_SERVICE,
  EXECUTORS_CREATE_SERVICE,
  GATE_SERVICE,
  HISTORY_SERVICE,
  JIRA_SERVICE,
  MCP_DEPS,
  NOTIFICATIONS_SERVICE,
  PAYLOAD_CONFIG,
  PROJECTS_SERVICE,
  FOLDERS_SERVICE,
  PTY_HUB,
  TICKET_SERVICE,
  WS_TUNING_TOKEN,
} from "./tokens.js";
import { PtyGateway } from "./pty/pty-gateway.js";
import { PtyHub } from "./pty/pty-hub.js";
import type { RelayClient } from "./relay/relay-client.js";
import { FeedGateway } from "./ws/gateway.js";
import type { WsTuning } from "./ws/hub.js";

export interface AppDeps {
  readonly config: ApiConfig;
  readonly store: ApiStore;
  readonly clock: Clock;
  readonly tuning: WsTuning;
  /** Where session payload files live (§11.3); null serves none. */
  readonly runtimeDir: string | null;
  /** The tickets module (§12.1); without it, /tickets is not served (tests of other routes). */
  readonly tickets?: TicketService;
  /** The gates module: /gates, /findings and /role-bindings; absent serves none. */
  readonly gates?: GateService;
  /** The MCP server; absent mounts no /mcp. */
  readonly mcp?: McpDeps;
  /** GET /sessions/:id/diff; absent serves none. */
  readonly diffs?: SessionDiffService;
  /** POST /projects, its agents and PATCH /agents/:id; absent mounts none. */
  readonly projects?: ProjectsService;
  /** /folders/check|allow|init; absent mounts none. */
  readonly folders?: FoldersService;
  /** POST /executors; absent mounts none. */
  readonly executorsCreate?: ExecutorsCreateService;
  /** A project's timeline and export, an agent's sessions; absent mounts none. */
  readonly history?: HistoryService;
  /** A project's Jira mirror: its status and sync; absent mounts none. */
  readonly jira?: JiraService;
  /** The notifier's channels, test send and outbox; absent mounts none. */
  readonly notifications?: NotificationsService;
  /** session:<id>:pty (§12.5 point 3): a connected relay client, one per API process.
   * Absent (no FRM_HOME to find the supervisor's relay socket at) mounts no /ws/pty. */
  readonly pty?: { readonly relay: RelayClient };
}

const GATE_CONTROLLERS = [
  GatesController,
  FindingsController,
  RoleBindingsController,
];

@Module({})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- a Nest module: decorated, with a static factory
export class AppModule {
  static register(deps: AppDeps): DynamicModule {
    const pty = deps.pty;
    return {
      module: AppModule,
      controllers: [
        HealthController,
        FleetController,
        SessionsController,
        CommandsController,
        ExportsController,
        SettingsController,
        SpendController,
        BudgetsController,
        MissionsController,
        InboxController,
        PulsesController,
        AgentsController,
        HandoffsController,
        RunnersController,
        ExecutorsController,
        WorkspacesController,
        AuditController,
        ...(deps.tickets === undefined ? [] : [TicketsController]),
        ...(deps.gates === undefined ? [] : GATE_CONTROLLERS),
        ...(deps.mcp === undefined ? [] : [McpController]),
        ...(deps.diffs === undefined ? [] : [SessionDiffController]),
        ...(deps.projects === undefined
          ? []
          : [ProjectsController, AgentEditController]),
        ...(deps.folders === undefined ? [] : [FoldersController]),
        ...(deps.executorsCreate === undefined
          ? []
          : [ExecutorsCreateController]),
        ...(deps.history === undefined
          ? []
          : [ProjectHistoryController, AgentSessionsController]),
        ...(deps.jira === undefined
          ? []
          : [JiraController, JiraTokenController]),
        ...(deps.notifications === undefined ? [] : [NotificationsController]),
      ],
      providers: [
        ...(deps.tickets === undefined
          ? []
          : [{ provide: TICKET_SERVICE, useValue: deps.tickets }]),
        ...(deps.gates === undefined
          ? []
          : [{ provide: GATE_SERVICE, useValue: deps.gates }]),
        ...(deps.mcp === undefined
          ? []
          : [{ provide: MCP_DEPS, useValue: deps.mcp }]),
        ...(deps.diffs === undefined
          ? []
          : [{ provide: DIFF_SERVICE, useValue: deps.diffs }]),
        ...(deps.projects === undefined
          ? []
          : [{ provide: PROJECTS_SERVICE, useValue: deps.projects }]),
        ...(deps.folders === undefined
          ? []
          : [{ provide: FOLDERS_SERVICE, useValue: deps.folders }]),
        ...(deps.history === undefined
          ? []
          : [{ provide: HISTORY_SERVICE, useValue: deps.history }]),
        ...(deps.jira === undefined
          ? []
          : [{ provide: JIRA_SERVICE, useValue: deps.jira }]),
        ...(deps.notifications === undefined
          ? []
          : [{ provide: NOTIFICATIONS_SERVICE, useValue: deps.notifications }]),
        ...(deps.executorsCreate === undefined
          ? []
          : [
              {
                provide: EXECUTORS_CREATE_SERVICE,
                useValue: deps.executorsCreate,
              },
            ]),
        ...(pty === undefined
          ? []
          : [
              {
                provide: PTY_HUB,
                useFactory: () =>
                  new PtyHub(pty.relay, deps.store, (path) => readFile(path)),
              },
              PtyGateway,
            ]),
        { provide: API_CONFIG, useValue: deps.config },
        { provide: API_STORE, useValue: deps.store },
        { provide: CLOCK, useValue: deps.clock },
        { provide: WS_TUNING_TOKEN, useValue: deps.tuning },
        { provide: PAYLOAD_CONFIG, useValue: { runtimeDir: deps.runtimeDir } },
        CommandsService,
        FeedGateway,
        { provide: APP_GUARD, useClass: BearerGuard },
        { provide: APP_FILTER, useClass: ErrorFilter },
        { provide: APP_PIPE, useValue: validationPipe },
      ],
    };
  }
}
