// POST /mcp, outside /api/v1. The operator bearer is refused here and a
// session token is refused at /api/v1: two boundaries, never crossed. A 401 carries no
// WWW-Authenticate, so a runner never starts OAuth discovery. Stateless: GET and DELETE are 405.
import { IncomingMessage, ServerResponse } from "node:http";
import { sha256Hex, type Clock } from "@bayon/core";
import {
  Controller,
  Delete,
  Get,
  Inject,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import { Public, bearerMatches } from "../auth.js";
import type { ApiConfig } from "../config.js";
import { FrmHttpError } from "../errors.js";
import { API_CONFIG, CLOCK, MCP_DEPS } from "../tokens.js";
import { SessionRate } from "./rate.js";
import { serveMcp, type McpDeps } from "./server.js";
import type { McpSession } from "./store.js";

const unauthorized = (message: string) =>
  new FrmHttpError({ class: "validation", message, retryable: false }, 401);

const BEARER = /^Bearer (\S+)$/i;

@Controller("mcp")
@Public() // not the operator's bearer: each request is checked against a session token below
export class McpController {
  readonly #deps: McpDeps;
  readonly #config: ApiConfig;
  readonly #clock: Clock;
  readonly #rate: SessionRate;

  constructor(
    @Inject(MCP_DEPS) deps: McpDeps,
    @Inject(API_CONFIG) config: ApiConfig,
    @Inject(CLOCK) clock: Clock,
  ) {
    this.#deps = deps;
    this.#config = config;
    this.#clock = clock;
    this.#rate = new SessionRate({
      calls: deps.limits.rateCalls,
      windowMs: deps.limits.rateWindowMs,
      clock,
    });
  }

  @Post()
  async post(
    @Req() req: IncomingMessage & { readonly body?: unknown },
    @Res() res: ServerResponse,
  ): Promise<void> {
    this.#checkSize(req);
    const session = await this.#authenticate(req.headers.authorization);
    if (!this.#rate.take(session.id)) {
      throw new FrmHttpError(
        {
          class: "admission_refused",
          message: "too many MCP calls from this session: slow down",
          retryable: true,
        },
        429,
      );
    }
    await serveMcp(req, res, req.body, session, this.#deps, this.#clock);
  }

  @Get()
  get(): never {
    throw notAllowed();
  }

  @Delete()
  remove(): never {
    throw notAllowed();
  }

  /** 413 past `limits.bodyBytes`, by the declared length or the parsed body, before anything else. */
  #checkSize(req: IncomingMessage & { readonly body?: unknown }): void {
    const limit = this.#deps.limits.bodyBytes;
    const declared = Number(req.headers["content-length"] ?? "0");
    const parsed = Buffer.byteLength(JSON.stringify(req.body ?? null), "utf8");
    if (declared > limit || parsed > limit) {
      throw new FrmHttpError(
        {
          class: "validation",
          message: `an MCP request body is at most ${limit} bytes`,
          retryable: false,
        },
        413,
      );
    }
  }

  async #authenticate(header: string | undefined): Promise<McpSession> {
    const presented = BEARER.exec(header ?? "")?.[1];
    if (presented === undefined) throw unauthorized("missing bearer token");
    if (bearerMatches(header, this.#config.token)) {
      throw unauthorized("the operator bearer is not accepted at /mcp");
    }
    const found = await this.#deps.store.sessionByTokenHash(
      await sha256Hex(presented),
    );
    if (!found.ok) throw new FrmHttpError(found.error);
    if (found.value === null) {
      throw unauthorized("invalid or revoked session token");
    }
    return found.value;
  }
}

const notAllowed = () =>
  new FrmHttpError(
    {
      class: "validation",
      message: "/mcp is stateless: POST only",
      retryable: false,
    },
    405,
  );
