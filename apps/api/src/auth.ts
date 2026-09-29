import {
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { ApiConfig } from "./config.js";
import { FrmHttpError } from "./errors.js";
import { API_CONFIG } from "./tokens.js";

const IS_PUBLIC = "frm:public";

/** Marks a route that needs no bearer. Only /health. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Constant-time check of `Authorization: Bearer <token>`. */
export function bearerMatches(
  header: string | undefined,
  token: string,
): boolean {
  const presented = /^Bearer (\S+)$/i.exec(header ?? "")?.[1];
  return (
    presented !== undefined && timingSafeEqual(digest(presented), digest(token))
  );
}

/** The local bearer (§12.1) on every HTTP route. /ws checks it at the handshake instead. */
@Injectable()
export class BearerGuard implements CanActivate {
  readonly #config: ApiConfig;
  readonly #reflector: Reflector;

  constructor(
    @Inject(API_CONFIG) config: ApiConfig,
    @Inject(Reflector) reflector: Reflector,
  ) {
    this.#config = config;
    this.#reflector = reflector;
  }

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== "http") return true;
    const isPublic = this.#reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) return true;
    const request = context.switchToHttp().getRequest<IncomingMessage>();
    if (bearerMatches(request.headers.authorization, this.#config.token))
      return true;
    throw new FrmHttpError(
      {
        class: "validation",
        message: "missing or invalid bearer token",
        retryable: false,
      },
      401,
    );
  }
}
