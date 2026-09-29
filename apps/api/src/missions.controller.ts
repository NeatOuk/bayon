import {
  MissionSaveRequest,
  MissionVersionNumber,
  type MissionDiff,
  type MissionVersion,
  type MissionView,
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
} from "@nestjs/common";
import { unwrap } from "./errors.js";
import { diffMissions } from "./mission-diff.js";
import type { ApiStore } from "./store.js";
import { API_STORE } from "./tokens.js";

// `/missions/:agent` (§12.1, M1 contract 7): versioned mission notes, keyed by agent name. A save
// is a new version with a changelog note; nothing is edited in place.

@Controller("missions")
export class MissionsController {
  readonly #store: ApiStore;

  constructor(@Inject(API_STORE) store: ApiStore) {
    this.#store = store;
  }

  /** The newest version (null before the first save) and the changelog, newest first. */
  @Get(":agent")
  async history(@Param("agent") agent: string): Promise<MissionView> {
    return unwrap(await this.#store.missionHistory(agent));
  }

  @Get(":agent/versions/:v")
  async version(
    @Param("agent") agent: string,
    @Param("v", { schema: MissionVersionNumber }) v: number,
  ): Promise<MissionVersion> {
    return unwrap(await this.#store.missionVersion(agent, v));
  }

  /** 201 with version `base_version + 1`; 400 without a note, 409 (`current_version`) on a stale base. */
  @Post(":agent")
  @HttpCode(HttpStatus.CREATED)
  async save(
    @Param("agent") agent: string,
    @Body({ schema: MissionSaveRequest }) body: MissionSaveRequest,
  ): Promise<MissionVersion> {
    return unwrap(await this.#store.saveMission(agent, body));
  }

  @Get(":agent/diff/:a/:b")
  async diff(
    @Param("agent") agent: string,
    @Param("a", { schema: MissionVersionNumber }) a: number,
    @Param("b", { schema: MissionVersionNumber }) b: number,
  ): Promise<MissionDiff> {
    const from = unwrap(await this.#store.missionVersion(agent, a));
    const to = unwrap(await this.#store.missionVersion(agent, b));
    return diffMissions(agent, from, to);
  }
}
