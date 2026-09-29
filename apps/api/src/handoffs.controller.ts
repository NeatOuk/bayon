import {
  HandoffsQuery,
  type HandoffDetail,
  type HandoffsPage,
} from "@bayon/proto";
import { Controller, Get, Inject, Param, Query } from "@nestjs/common";
import { unwrap } from "./errors.js";
import type { ApiStore } from "./store.js";
import { API_STORE } from "./tokens.js";

// /api/v1/handoffs (§12.1, M2): hand-offs, read only. The operator's trigger is
// POST /sessions/:id/handoff; the chain also rides in GET /tickets/:ref.

@Controller("handoffs")
export class HandoffsController {
  readonly #store: ApiStore;

  constructor(@Inject(API_STORE) store: ApiStore) {
    this.#store = store;
  }

  /** Oldest first; `ticket` is its id or number; `pending=1` keeps the takeable ones. */
  @Get()
  async list(
    @Query({ schema: HandoffsQuery }) query: HandoffsQuery,
  ): Promise<HandoffsPage> {
    return unwrap(
      await this.#store.handoffs({
        ...(query.ticket === undefined ? {} : { ticket: query.ticket }),
        pending: query.pending === true,
        limit: query.limit,
      }),
    );
  }

  @Get(":id")
  async detail(@Param("id") id: string): Promise<HandoffDetail> {
    return unwrap(await this.#store.handoff(id));
  }
}
