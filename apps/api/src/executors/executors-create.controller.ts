import { CreateExecutorRequest, type ExecutorCreated } from "@bayon/proto";
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
} from "@nestjs/common";
import { unwrap } from "../errors.js";
import { EXECUTORS_CREATE_SERVICE } from "../tokens.js";
import type { ExecutorsCreateService } from "./executors-create-service.js";

/** `POST /executors` (§9.5 amendment): 201 with the new executor's id, no command row
 * (nothing to claim), no `If-Match` (create carries none, as `POST /projects`). A separate
 * controller from `ExecutorsController` (`GET /executors`, `POST /executors/:id/health`) so this
 * route can be left unmounted wherever that one is exercised without it. */
@Controller("executors")
export class ExecutorsCreateController {
  readonly #executors: ExecutorsCreateService;

  constructor(
    @Inject(EXECUTORS_CREATE_SERVICE) executors: ExecutorsCreateService,
  ) {
    this.#executors = executors;
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body({ schema: CreateExecutorRequest }) body: CreateExecutorRequest,
  ): Promise<ExecutorCreated> {
    return unwrap(await this.#executors.create(body));
  }
}
