import type { SessionDiff } from "@bayon/proto";
import { Controller, Get, Inject, Param } from "@nestjs/common";
import { unwrap } from "../errors.js";
import { DIFF_SERVICE } from "../tokens.js";
import type { SessionDiffService } from "./session-diff.js";

// GET /api/v1/sessions/:id/diff (§12.1): the operator's read of what a session changed.
// 404 for an unknown session; a repo whose diff cannot be read says why inside the 200.

@Controller("sessions")
export class SessionDiffController {
  readonly #diffs: SessionDiffService;

  constructor(@Inject(DIFF_SERVICE) diffs: SessionDiffService) {
    this.#diffs = diffs;
  }

  /** Per repo: the files, the untracked ones, and the patch capped per §8.5 with the full path. */
  @Get(":id/diff")
  async diff(@Param("id") id: string): Promise<SessionDiff> {
    return unwrap(await this.#diffs.diff(id));
  }
}
