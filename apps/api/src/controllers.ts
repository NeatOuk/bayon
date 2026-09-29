import {
  AttachRequest,
  BudgetSettings,
  CommandAccepted,
  EventsQuery,
  FleetQuery,
  IDEMPOTENCY_HEADER,
  IdempotencyKey,
  PutBudget,
  PutOperatorSettings,
  SessionHandoffRequest,
  SpawnRequest,
  SpendQuery,
  StopRequest,
  type AttentionAck,
  type BudgetView,
  type BudgetsView,
  type CommandView,
  type EventsPage,
  type ExportRunAccepted,
  type Fleet,
  type FleetPauseState,
  type Health,
  type OperatorSettingsView,
  type SessionView,
  type SpendReport,
} from "@bayon/proto";
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Put,
  Query,
  StreamableFile,
} from "@nestjs/common";
import { z } from "zod";
import { Public } from "./auth.js";
import { CommandsService } from "./commands.service.js";
import { FrmHttpError, unwrap } from "./errors.js";
import { locatePayload, type PayloadConfig } from "./payloads.js";
import type { ApiStore } from "./store.js";
import { API_STORE, PAYLOAD_CONFIG } from "./tokens.js";

// The /api/v1 routes (§12.1 subset). Reads come from the store; every POST inserts one `commands`
// row and answers 202 with its id.

/** The Idempotency-Key header as Node delivers it, for `@Headers()`. */
export const IDEMPOTENCY = IDEMPOTENCY_HEADER.toLowerCase();
const EventId = z.coerce.number().pipe(z.int().positive());

/** The Idempotency-Key header, validated; absent is undefined. */
export function idempotencyKey(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const parsed = IdempotencyKey.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new FrmHttpError({
    class: "validation",
    message: `${IDEMPOTENCY_HEADER}: ${z.prettifyError(parsed.error)}`,
    retryable: false,
  });
}

const notFound = (message: string) =>
  new FrmHttpError({ class: "not_found", message, retryable: false });

@Controller("health")
export class HealthController {
  @Public()
  @Get()
  health(): Health {
    return { status: "ok" };
  }
}

@Controller("fleet")
export class FleetController {
  readonly #store: ApiStore;

  constructor(@Inject(API_STORE) store: ApiStore) {
    this.#store = store;
  }

  /**
   * `?project=<workspace id>` keeps one project's sessions; an unknown project is an
   * empty list, as a filter is. Everything else in the body stays fleet-wide.
   */
  @Get()
  async fleet(
    @Query({ schema: FleetQuery }) query: FleetQuery,
  ): Promise<Fleet> {
    return unwrap(
      await this.#store.fleet(
        query.project === undefined ? {} : { project: query.project },
      ),
    );
  }

  /**
   * The kill switch (M4 §13.3): new spawns and new turns wait (`fleet_paused`), turns in
   * flight and hand-off packets finish, the pulse scheduler freezes and no reviewer launches, until
   * resumed. Audited; the same state again changes nothing (`changed: false`).
   */
  @Post("pause")
  @HttpCode(HttpStatus.OK)
  async pause(): Promise<FleetPauseState> {
    return unwrap(await this.#store.setFleetPaused(true));
  }

  /** Lifts the pause: admission's next recheck admits what it queued. Audited. */
  @Post("resume")
  @HttpCode(HttpStatus.OK)
  async resume(): Promise<FleetPauseState> {
    return unwrap(await this.#store.setFleetPaused(false));
  }

  /**
   * Dismisses a finished session's error from the attention strip for good. Audited as
   * `attention.ack`, and idempotent. Only an error exit can be dismissed: a stale session is a live
   * condition that clears itself on its next event or when it is stopped, so dismissing one would
   * hide something still true — that is refused as a conflict.
   */
  @Post("attention/:sessionId/ack")
  @HttpCode(HttpStatus.OK)
  async ackAttention(
    @Param("sessionId") sessionId: string,
  ): Promise<AttentionAck> {
    return unwrap(await this.#store.ackAttention(sessionId));
  }
}

@Controller("sessions")
export class SessionsController {
  readonly #store: ApiStore;
  readonly #commands: CommandsService;
  readonly #payloads: PayloadConfig;

  constructor(
    @Inject(API_STORE) store: ApiStore,
    @Inject(CommandsService) commands: CommandsService,
    @Inject(PAYLOAD_CONFIG) payloads: PayloadConfig,
  ) {
    this.#store = store;
    this.#commands = commands;
    this.#payloads = payloads;
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async spawn(
    @Body({ schema: SpawnRequest }) body: SpawnRequest,
    @Headers(IDEMPOTENCY) key: string | undefined,
  ): Promise<CommandAccepted> {
    return unwrap(await this.#commands.spawn(body, idempotencyKey(key)));
  }

  @Get(":id")
  async session(@Param("id") id: string): Promise<SessionView> {
    return unwrap(await this.#store.session(id));
  }

  @Get(":id/events")
  async events(
    @Param("id") id: string,
    @Query({ schema: EventsQuery }) query: EventsQuery,
  ): Promise<EventsPage> {
    return unwrap(
      await this.#store.eventsSince({
        sessionId: id,
        since: query.since,
        limit: query.limit,
        kinds: query.kind,
      }),
    );
  }

  /**
   * The full text behind a capped event, streamed from its `payload_path`. Exempt from the 8 KB /
   * 200-line tool-result cap (§8.5, Invariant 9) on purpose: that cap bounds what agents are handed,
   * and this route is the operator's explicit way to read the whole file. Only files inside
   * `<runtime>/sessions/<id>/` are served (payloads.ts).
   */
  @Get(":id/events/:eventId/payload")
  async payload(
    @Param("id") id: string,
    @Param("eventId", { schema: EventId }) eventId: number,
  ): Promise<StreamableFile> {
    const { runtimeDir } = this.#payloads;
    if (runtimeDir === null)
      throw notFound(
        "payload files are not served: set FRM_HOME or FRM_RUNTIME_DIR",
      );
    const page = unwrap(
      await this.#store.eventsSince({
        sessionId: id,
        since: eventId - 1,
        limit: 1,
      }),
    );
    const event = page.items[0];
    if (event?.id !== eventId)
      throw notFound(`session ${id} has no event ${eventId}`);
    if (event.payload_path === undefined)
      throw notFound(`event ${eventId} has no payload on disk`);
    const file = unwrap(
      await locatePayload(runtimeDir, id, event.payload_path),
    );
    // Stream from the fd `locatePayload` already opened and checked — never re-open by path,
    // which is exactly the TOCTOU window this route used to have.
    const stream = file.handle.createReadStream();
    stream.on("close", () => {
      file.handle.close().catch(() => undefined);
    });
    return new StreamableFile(stream, {
      type: "text/plain; charset=utf-8",
      length: file.size,
    });
  }

  @Post(":id/interrupt")
  @HttpCode(HttpStatus.ACCEPTED)
  async interrupt(
    @Param("id") id: string,
    @Headers(IDEMPOTENCY) key: string | undefined,
  ): Promise<CommandAccepted> {
    return unwrap(await this.#commands.interrupt(id, idempotencyKey(key)));
  }

  @Post(":id/stop")
  @HttpCode(HttpStatus.ACCEPTED)
  async stop(
    @Param("id") id: string,
    @Body({ schema: StopRequest }) body: StopRequest,
    @Headers(IDEMPOTENCY) key: string | undefined,
  ): Promise<CommandAccepted> {
    return unwrap(
      await this.#commands.stop(id, body.mode, idempotencyKey(key)),
    );
  }

  /**
   * Hands the session off now (§7.1): 202 with the session.handoff command, `operator` unless the
   * body says why. The supervisor refuses a session that is not running or holds no ticket.
   */
  @Post(":id/handoff")
  @HttpCode(HttpStatus.ACCEPTED)
  async handoff(
    @Param("id") id: string,
    @Body({ schema: SessionHandoffRequest }) body: SessionHandoffRequest,
    @Headers(IDEMPOTENCY) key: string | undefined,
  ): Promise<CommandAccepted> {
    return unwrap(await this.#commands.handoff(id, body, idempotencyKey(key)));
  }

  /**
   * §12.5: takes the session's attach lease. 202, like every other session command — the
   * supervisor claims it asynchronously (mints the lease, starts the interactive process);
   * `GET /sessions/:id` shows `attach_lease_owner`/`tmux_target` once it has. An optional
   * `client_token` becomes the lease owner verbatim instead of a server-minted one, so the caller
   * can recognize its own lease later by simple equality (§12.5 GUI: no other reliable way to tell
   * "my own attach won" from "some other lease is now non-null"). `when`: `now`, the
   * default, or `turn_end` to take over only once the open run has ended.
   */
  @Post(":id/attach")
  @HttpCode(HttpStatus.ACCEPTED)
  async attach(
    @Param("id") id: string,
    @Body({ schema: AttachRequest }) body: AttachRequest,
    @Headers(IDEMPOTENCY) key: string | undefined,
  ): Promise<CommandAccepted> {
    return unwrap(await this.#commands.attach(id, body, idempotencyKey(key)));
  }

  /** §12.5: releases the attach lease early, or cancels a pending takeover. */
  @Delete(":id/attach")
  @HttpCode(HttpStatus.ACCEPTED)
  async detach(
    @Param("id") id: string,
    @Headers(IDEMPOTENCY) key: string | undefined,
  ): Promise<CommandAccepted> {
    return unwrap(await this.#commands.detach(id, idempotencyKey(key)));
  }
}

@Controller("commands")
export class CommandsController {
  readonly #store: ApiStore;

  constructor(@Inject(API_STORE) store: ApiStore) {
    this.#store = store;
  }

  @Get(":id")
  async command(@Param("id") id: string): Promise<CommandView> {
    return unwrap(await this.#store.command(id));
  }
}

/** `POST /exports/run`: inserts one `export.run` command; the supervisor decides
 * whether to reuse the exporter's live session or spawn one. */
@Controller("exports")
export class ExportsController {
  readonly #commands: CommandsService;

  constructor(@Inject(CommandsService) commands: CommandsService) {
    this.#commands = commands;
  }

  @Post("run")
  @HttpCode(HttpStatus.ACCEPTED)
  async run(
    @Headers(IDEMPOTENCY) key: string | undefined,
  ): Promise<ExportRunAccepted> {
    return unwrap(await this.#commands.exportsRun(idempotencyKey(key)));
  }
}

/**
 * `GET/PUT /settings` (M4 §12.1): the whitelisted operator settings (core OPERATOR_SETTINGS); any
 * other key, or a value out of its bounds, is 400 and writes nothing. `GET/PUT /settings/budget`:
 * the daily cap.
 */
@Controller("settings")
export class SettingsController {
  readonly #store: ApiStore;

  constructor(@Inject(API_STORE) store: ApiStore) {
    this.#store = store;
  }

  @Get()
  async settings(): Promise<OperatorSettingsView> {
    return unwrap(await this.#store.operatorSettings());
  }

  @Put()
  async putSettings(
    @Body({ schema: PutOperatorSettings }) body: PutOperatorSettings,
  ): Promise<OperatorSettingsView> {
    return unwrap(await this.#store.putOperatorSettings(body.settings));
  }

  @Get("budget")
  async getBudget(): Promise<BudgetSettings> {
    return unwrap(await this.#store.getBudgetSettings());
  }

  @Put("budget")
  async putBudget(
    @Body({ schema: BudgetSettings }) body: BudgetSettings,
  ): Promise<BudgetSettings> {
    return unwrap(await this.#store.setBudgetSettings(body));
  }
}

/**
 * `/budgets` (§12.1, §13.4): the fleet's and each agent's caps over a UTC day or month. What a
 * budget has spent is computed from `spend` at read time, so a window rolls and a breach lifts by
 * itself. `on_breach: 'kill'` is refused — deferred past M4 — by the schema here, by the repo and
 * by a CHECK in 012_fleet. Every write is audited in its own transaction (§9.5).
 */
@Controller("budgets")
export class BudgetsController {
  readonly #store: ApiStore;

  constructor(@Inject(API_STORE) store: ApiStore) {
    this.#store = store;
  }

  @Get()
  async budgets(): Promise<BudgetsView> {
    return unwrap(await this.#store.budgets());
  }

  /** Replaces the budget of its scope and period whole, keeping its id. */
  @Put()
  async put(@Body({ schema: PutBudget }) body: PutBudget): Promise<BudgetView> {
    return unwrap(await this.#store.putBudget(body));
  }

  /** The deleted budget, with what it had spent when it went. A missing id is 404. */
  @Delete(":id")
  async remove(@Param("id") id: string): Promise<BudgetView> {
    return unwrap(await this.#store.deleteBudget(id));
  }
}

/**
 * `GET /spend?group=ticket|tier|class|day&project=` (§12.1, §8.9): the summary (waste, burn,
 * projection, alarm) and one grouping's rows, one project's with `project`. The
 * supervisor writes spend; this route only reads it (§9.5).
 */
@Controller("spend")
export class SpendController {
  readonly #store: ApiStore;

  constructor(@Inject(API_STORE) store: ApiStore) {
    this.#store = store;
  }

  @Get()
  async report(
    @Query({ schema: SpendQuery }) query: SpendQuery,
  ): Promise<SpendReport> {
    return unwrap(await this.#store.spendReport(query));
  }
}
