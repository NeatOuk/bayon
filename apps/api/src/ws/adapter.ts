import type { INestApplicationContext } from "@nestjs/common";
import { WsAdapter } from "@nestjs/platform-ws";
import type { IncomingMessage } from "node:http";
import { bearerMatches } from "../auth.js";

type GatewayOptions = Record<string, unknown> & {
  namespace?: string;
  server?: unknown;
  path?: string;
};

/** Nest's `ws` adapter, but a handshake without the bearer gets 401 before any frame. */
export class BearerWsAdapter extends WsAdapter {
  readonly #token: string;

  constructor(app: INestApplicationContext, token: string) {
    super(app);
    this.#token = token;
  }

  override create(port: number, options?: GatewayOptions): unknown {
    return super.create(port, {
      ...options,
      verifyClient: ({ req }: { req: IncomingMessage }) =>
        bearerMatches(req.headers.authorization, this.#token),
    });
  }
}
