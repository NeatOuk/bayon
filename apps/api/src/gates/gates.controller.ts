import {
  GatesQuery,
  PutRoleBinding,
  ResolveFindingRequest,
  WaiveRequest,
  type FindingView,
  type GateRunAccepted,
  type GateView,
  type GatesPage,
  type RoleBindingView,
  type RoleBindingsPage,
} from "@bayon/proto";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { unwrap } from "../errors.js";
import { GATE_SERVICE } from "../tokens.js";
import type { GateService } from "./gate-service.js";

// /api/v1/gates, /findings and /role-bindings (§12.1). The operator's doors:
// 409 when a gate or finding is no longer in the state the write needs, 422 when a law refuses
// (a rerun outside its review status, a fixing run on another ticket).

@Controller("gates")
export class GatesController {
  readonly #gates: GateService;

  constructor(@Inject(GATE_SERVICE) gates: GateService) {
    this.#gates = gates;
  }

  /**
   * `?state=running,failed&ticket=&project=&latest=1&cursor=&limit=`: the review queue by default,
   * one project's with `project`.
   */
  @Get()
  async list(
    @Query({ schema: GatesQuery }) query: GatesQuery,
  ): Promise<GatesPage> {
    return unwrap(await this.#gates.list(query));
  }

  /** 202 with the new attempt and its gate.run command; 409 while one of the kind runs. */
  @Post(":id/run")
  @HttpCode(HttpStatus.ACCEPTED)
  async run(@Param("id") id: string): Promise<GateRunAccepted> {
    return unwrap(await this.#gates.run(id));
  }

  /** running | failed → waived; the reason is shown forever (§10.3). */
  @Post(":id/waive")
  @HttpCode(HttpStatus.OK)
  async waive(
    @Param("id") id: string,
    @Body({ schema: WaiveRequest }) body: WaiveRequest,
  ): Promise<GateView> {
    return unwrap(await this.#gates.waive(id, body.reason));
  }
}

@Controller("findings")
export class FindingsController {
  readonly #gates: GateService;

  constructor(@Inject(GATE_SERVICE) gates: GateService) {
    this.#gates = gates;
  }

  /** open → resolved, naming the fixing run; 422 `cross_ticket_write` for a run on another ticket. */
  @Post(":id/resolve")
  @HttpCode(HttpStatus.OK)
  async resolve(
    @Param("id") id: string,
    @Body({ schema: ResolveFindingRequest }) body: ResolveFindingRequest,
  ): Promise<FindingView> {
    return unwrap(await this.#gates.resolveFinding(id, body));
  }

  /** open → waived, with the reason shown forever. */
  @Post(":id/waive")
  @HttpCode(HttpStatus.OK)
  async waive(
    @Param("id") id: string,
    @Body({ schema: WaiveRequest }) body: WaiveRequest,
  ): Promise<FindingView> {
    return unwrap(await this.#gates.waiveFinding(id, body.reason));
  }
}

@Controller("role-bindings")
export class RoleBindingsController {
  readonly #gates: GateService;

  constructor(@Inject(GATE_SERVICE) gates: GateService) {
    this.#gates = gates;
  }

  @Get()
  async list(): Promise<RoleBindingsPage> {
    return unwrap(await this.#gates.roleBindings());
  }

  /** One role's binding, replaced whole; 404 names an unknown runner, executor or profile. */
  @Put()
  async put(
    @Body({ schema: PutRoleBinding }) body: PutRoleBinding,
  ): Promise<RoleBindingView> {
    return unwrap(await this.#gates.putRoleBinding(body));
  }
}
