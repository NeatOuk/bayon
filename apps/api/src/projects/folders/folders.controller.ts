import {
  FolderAllowRequest,
  FolderCheckRequest,
  FolderInitRequest,
  type FolderAllowed,
  type FolderCheck,
} from "@bayon/proto";
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Req,
} from "@nestjs/common";
import type { IncomingMessage } from "node:http";
import { FrmHttpError, unwrap } from "../../errors.js";
import { FOLDERS_SERVICE } from "../../tokens.js";
import type { FoldersService } from "./folders-service.js";

/**
 * `/folders`: a folder checked before New project creates anything, and its
 * two actions. "From a browser on this host" is decided here, from the request itself
 * (local-request.ts), never from the body.
 */
@Controller("folders")
export class FoldersController {
  readonly #folders: FoldersService;
  readonly #logger = new Logger("folders");

  constructor(@Inject(FOLDERS_SERVICE) folders: FoldersService) {
    this.#folders = folders;
  }

  /** What the folder is; writes nothing. */
  @Post("check")
  @HttpCode(HttpStatus.OK)
  async check(
    @Req() request: IncomingMessage,
    @Body({ schema: FolderCheckRequest }) body: FolderCheckRequest,
  ): Promise<FolderCheck> {
    return unwrap(
      await this.#folders.check(body.path, this.#folders.isLocal(request)),
    );
  }

  /** Appends the folder or its parent to the allowed folders: 403 unless from this host. */
  @Post("allow")
  @HttpCode(HttpStatus.OK)
  async allow(
    @Req() request: IncomingMessage,
    @Body({ schema: FolderAllowRequest }) body: FolderAllowRequest,
  ): Promise<FolderAllowed> {
    const local = this.#folders.isLocal(request);
    const allowed = await this.#folders.allow(body, local);
    if (!allowed.ok && !local) {
      const origin = request.headers.origin;
      this.#logger.warn(
        `refused to allow a folder for a browser not on this host: peer ${request.socket.remoteAddress ?? "unknown"}, origin ${typeof origin === "string" ? origin : "none"}, path ${JSON.stringify(body.path)}`,
      );
      throw new FrmHttpError(allowed.error, 403);
    }
    return unwrap(allowed);
  }

  /** git init and one empty commit, for an allowed folder with no commit; then the check again. */
  @Post("init")
  @HttpCode(HttpStatus.OK)
  async init(
    @Req() request: IncomingMessage,
    @Body({ schema: FolderInitRequest }) body: FolderInitRequest,
  ): Promise<FolderCheck> {
    return unwrap(
      await this.#folders.init(body.path, this.#folders.isLocal(request)),
    );
  }
}
