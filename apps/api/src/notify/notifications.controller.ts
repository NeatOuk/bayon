import {
  NotificationsQuery,
  NotifyTestRequest,
  PutNotifyConfig,
  type NotificationsPage,
  type NotifyChannelsView,
  type NotifyConfigView,
  type NotifyTestResult,
} from "@bayon/proto";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { unwrap } from "../errors.js";
import { NOTIFICATIONS_SERVICE } from "../tokens.js";
import type { NotificationsService } from "./service.js";

/**
 * The notifier: `GET /notifications/channels` (each channel's status: booleans and the
 * secret's name, never a destination), `POST /notifications/test` (one test send, audited; an
 * unknown channel 400, a repeat within the cooldown 409), `GET /notifications` (the outbox, newest
 * first) and, `GET`/`PUT /notifications/config`: the three destination settings — the
 * mail recipient and sender and the deep-link origin — which the GUI may change through this door
 * alone, each value checked, each change audited as `notify.config` and announced (§14).
 */
@Controller("notifications")
export class NotificationsController {
  readonly #service: NotificationsService;

  constructor(@Inject(NOTIFICATIONS_SERVICE) service: NotificationsService) {
    this.#service = service;
  }

  @Get("channels")
  async channels(): Promise<NotifyChannelsView> {
    return unwrap(await this.#service.channels());
  }

  @Post("test")
  @HttpCode(HttpStatus.OK)
  async test(
    @Body({ schema: NotifyTestRequest }) body: NotifyTestRequest,
  ): Promise<NotifyTestResult> {
    return unwrap(await this.#service.test(body.channel));
  }

  @Get("config")
  async config(): Promise<NotifyConfigView> {
    return unwrap(await this.#service.config());
  }

  @Put("config")
  async putConfig(
    @Body({ schema: PutNotifyConfig }) body: PutNotifyConfig,
  ): Promise<NotifyConfigView> {
    return unwrap(await this.#service.putConfig(body));
  }

  @Get()
  async list(
    @Query({ schema: NotificationsQuery }) query: NotificationsQuery,
  ): Promise<NotificationsPage> {
    return unwrap(await this.#service.list(query));
  }
}
