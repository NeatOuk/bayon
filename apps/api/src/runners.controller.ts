import {
  ModelCreateRequest,
  ModelPatchRequest,
  RunnerConformanceRequest,
  type ModelWriteReply,
  type RunnerConformanceAccepted,
  type RunnerUpdateDismissed,
  type RunnersView,
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
  Patch,
  Post,
} from "@nestjs/common";
import { CommandsService } from "./commands.service.js";
import { IDEMPOTENCY, idempotencyKey } from "./controllers.js";
import { unwrap } from "./errors.js";
import type { ApiStore } from "./store.js";
import { API_STORE } from "./tokens.js";

/**
 * `GET /runners` and `POST /runners/:id/conformance` (§12.1, §15). The supervisor writes
 * runners and their certifications (§9.5); this reads them, and the POST inserts one
 * `runner.conformance` command, whose result names the report and says what it certified.
 *
 * `POST|PATCH|DELETE /runners/:id/models[/:model]`: the operator's models, each judged
 * by the runner's adapter, the one-active-per-tier rule enforced by the writer, audited. Settings
 * are not taken here (they direct network egress): `frm config apply … --yes` changes them.
 */
@Controller("runners")
export class RunnersController {
  readonly #store: ApiStore;
  readonly #commands: CommandsService;

  constructor(
    @Inject(API_STORE) store: ApiStore,
    @Inject(CommandsService) commands: CommandsService,
  ) {
    this.#store = store;
    this.#commands = commands;
  }

  @Get()
  async runners(): Promise<RunnersView> {
    return unwrap(await this.#store.runners());
  }

  @Post(":id/conformance")
  @HttpCode(HttpStatus.ACCEPTED)
  async conformance(
    @Param("id") id: string,
    @Body({ schema: RunnerConformanceRequest }) body: RunnerConformanceRequest,
    @Headers(IDEMPOTENCY) key: string | undefined,
  ): Promise<RunnerConformanceAccepted> {
    return unwrap(
      await this.#commands.runnerConformance(id, body, idempotencyKey(key)),
    );
  }

  @Post(":id/models")
  @HttpCode(HttpStatus.CREATED)
  async createModel(
    @Param("id") id: string,
    @Body({ schema: ModelCreateRequest }) body: ModelCreateRequest,
  ): Promise<ModelWriteReply> {
    return unwrap(await this.#store.createModel(id, body));
  }

  @Patch(":id/models/:model")
  async patchModel(
    @Param("id") id: string,
    @Param("model") model: string,
    @Body({ schema: ModelPatchRequest }) body: ModelPatchRequest,
  ): Promise<ModelWriteReply> {
    return unwrap(await this.#store.patchModel(id, model, body));
  }

  @Delete(":id/models/:model")
  async deactivateModel(
    @Param("id") id: string,
    @Param("model") model: string,
  ): Promise<ModelWriteReply> {
    return unwrap(await this.#store.deactivateModel(id, model));
  }

  /**
   * Dismisses one open runner update check, audited as `runner_update.dismiss` and
   * idempotent. `not_found` for a (runner, latest) pair the supervisor never recorded.
   */
  @Post(":id/updates/:version/dismiss")
  @HttpCode(HttpStatus.OK)
  async dismissUpdate(
    @Param("id") id: string,
    @Param("version") version: string,
  ): Promise<RunnerUpdateDismissed> {
    return unwrap(await this.#store.dismissRunnerUpdate(id, version));
  }
}
