import type { WorkspacesView } from "@bayon/proto";
import { Controller, Get, Inject } from "@nestjs/common";
import { unwrap } from "./errors.js";
import type { ApiStore } from "./store.js";
import { API_STORE } from "./tokens.js";

/** `GET /workspaces` (§4): every workspace row, for the New ticket dialog's picker. */
@Controller("workspaces")
export class WorkspacesController {
  readonly #store: ApiStore;

  constructor(@Inject(API_STORE) store: ApiStore) {
    this.#store = store;
  }

  @Get()
  async workspaces(): Promise<WorkspacesView> {
    return unwrap(await this.#store.workspaces());
  }
}
