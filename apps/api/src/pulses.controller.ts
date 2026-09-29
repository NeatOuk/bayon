import type { Clock } from "@bayon/core";
import {
  PulsePolicyPatch,
  PulseRunRequest,
  PulsesQuery,
  type AgentPulsesPage,
  type PulseDetail,
  type PulsePolicy,
  type PulseRunAccepted,
  type PulsesPage,
} from "@bayon/proto";
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { CommandsService } from "./commands.service.js";
import { IDEMPOTENCY, idempotencyKey } from "./controllers.js";
import { unwrap } from "./errors.js";
import type { ApiStore } from "./store.js";
import { API_STORE, CLOCK } from "./tokens.js";

// /api/v1/pulses and /api/v1/agents/:id/pulse-policy (§12.1, M2). The supervisor writes pulses
// (§9.5): the API reads them, inserts `pulse.run`, and writes the agents' pulse policy.

@Controller("pulses")
export class PulsesController {
  readonly #store: ApiStore;
  readonly #commands: CommandsService;

  constructor(
    @Inject(API_STORE) store: ApiStore,
    @Inject(CommandsService) commands: CommandsService,
  ) {
    this.#store = store;
    this.#commands = commands;
  }

  /** Newest first; `agent` is an agent id. */
  @Get()
  async list(
    @Query({ schema: PulsesQuery }) query: PulsesQuery,
  ): Promise<PulsesPage> {
    return unwrap(
      await this.#store.pulses({
        ...(query.agent === undefined ? {} : { agentId: query.agent }),
        limit: query.limit,
      }),
    );
  }

  /** 202 with the pulse.run command. The supervisor leases it at once; concurrent ones make one pulse. */
  @Post("run-now")
  @HttpCode(HttpStatus.ACCEPTED)
  async runNow(
    @Body({ schema: PulseRunRequest }) body: PulseRunRequest,
    @Headers(IDEMPOTENCY) key: string | undefined,
  ): Promise<PulseRunAccepted> {
    return unwrap(
      await this.#commands.pulseRun(body.agent_id, idempotencyKey(key)),
    );
  }

  /** The pulse with its probe checks. */
  @Get(":id")
  async detail(@Param("id") id: string): Promise<PulseDetail> {
    return unwrap(await this.#store.pulse(id));
  }
}

@Controller("agents")
export class AgentsController {
  readonly #store: ApiStore;
  readonly #clock: Clock;

  constructor(@Inject(API_STORE) store: ApiStore, @Inject(CLOCK) clock: Clock) {
    this.#store = store;
    this.#clock = clock;
  }

  /** Every agent that pulses, by id: its policy and next scheduled pulse (the Fleet header, M2). */
  @Get("pulse-policies")
  async pulsePolicies(): Promise<AgentPulsesPage> {
    return unwrap(await this.#store.pulseAgents(this.#clock.now()));
  }

  /** Sets any of the policy's fields; the scheduler picks it up on its next tick. */
  @Patch(":id/pulse-policy")
  async pulsePolicy(
    @Param("id") id: string,
    @Body({ schema: PulsePolicyPatch }) body: PulsePolicyPatch,
  ): Promise<PulsePolicy> {
    return unwrap(await this.#store.setPulsePolicy(id, body));
  }
}
