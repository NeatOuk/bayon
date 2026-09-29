import { AuditQuery, type AuditPage } from "@bayon/proto";
import { Controller, Get, Inject, Query } from "@nestjs/common";
import { unwrap } from "./errors.js";
import type { ApiStore } from "./store.js";
import { API_STORE } from "./tokens.js";

/**
 * `GET /audit?before=&limit=&actor=&action=` (M4 §12.1): audit_log newest first, a page
 * at a time. Read-only: the API and the supervisor's named writers append it (§9.5).
 */
@Controller("audit")
export class AuditController {
  readonly #store: ApiStore;

  constructor(@Inject(API_STORE) store: ApiStore) {
    this.#store = store;
  }

  @Get()
  async audit(
    @Query({ schema: AuditQuery }) query: AuditQuery,
  ): Promise<AuditPage> {
    return unwrap(await this.#store.audit(query));
  }
}
