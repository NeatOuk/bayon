import type { ExecutorHealthAccepted, ExecutorsView } from "@bayon/proto";
import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
} from "@nestjs/common";
import { CommandsService } from "./commands.service.js";
import { IDEMPOTENCY, idempotencyKey } from "./controllers.js";
import { unwrap } from "./errors.js";
import type { ApiStore } from "./store.js";
import { API_STORE } from "./tokens.js";

/**
 * `GET /executors` and `POST /executors/:id/health` (§6.1, §12.1). The supervisor writes
 * executor health (§9.5); this reads the rows, and the POST inserts one `executor.health` command,
 * whose result says what the check found.
 */
@Controller("executors")
export class ExecutorsController {
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
  async executors(): Promise<ExecutorsView> {
    return unwrap(await this.#store.executors());
  }

  @Post(":id/health")
  @HttpCode(HttpStatus.ACCEPTED)
  async health(
    @Param("id") id: string,
    @Headers(IDEMPOTENCY) key: string | undefined,
  ): Promise<ExecutorHealthAccepted> {
    return unwrap(await this.#commands.executorHealth(id, idempotencyKey(key)));
  }
}
