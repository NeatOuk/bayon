import type { Clock } from "@bayon/core";
import { Inject, Logger } from "@nestjs/common";
import { WebSocketGateway, type OnGatewayConnection } from "@nestjs/websockets";
import type { RawData, WebSocket } from "ws";
import type { ApiStore } from "../store.js";
import { API_STORE, CLOCK, WS_TUNING_TOKEN } from "../tokens.js";
import {
  WsConnection,
  shareSpendSummary,
  type FeedSource,
  type WsTuning,
} from "./hub.js";

export const WS_PATH = "/ws";

/** Client frames are a few dozen bytes; `ws` refuses anything past this. */
const MAX_CLIENT_FRAME_BYTES = 64 * 1024;

const text = (data: RawData): string =>
  Array.isArray(data)
    ? Buffer.concat(data).toString("utf8")
    : new TextDecoder().decode(data);

/** Hands each /ws socket to a WsConnection. Auth happened at the handshake (BearerWsAdapter). */
@WebSocketGateway({ path: WS_PATH, maxPayload: MAX_CLIENT_FRAME_BYTES })
export class FeedGateway implements OnGatewayConnection {
  readonly #logger = new Logger("ws");
  /** The store, with the spend summary read once per tick for every socket. */
  readonly #source: FeedSource;
  readonly #clock: Clock;
  readonly #tuning: WsTuning;

  constructor(
    @Inject(API_STORE) store: ApiStore,
    @Inject(CLOCK) clock: Clock,
    @Inject(WS_TUNING_TOKEN) tuning: WsTuning,
  ) {
    this.#source = shareSpendSummary(store, clock, tuning.fleetMs);
    this.#clock = clock;
    this.#tuning = tuning;
  }

  handleConnection(socket: WebSocket): void {
    const connection = new WsConnection(socket, {
      source: this.#source,
      clock: this.#clock,
      tuning: this.#tuning,
      log: (error) => this.#logger.warn(`${error.class}: ${error.message}`),
    });
    // A binary frame is not a protocol frame: "" parses as a malformed one.
    socket.on("message", (data: RawData, isBinary: boolean) =>
      connection.receive(isBinary ? "" : text(data)),
    );
    socket.on("close", () => connection.close());
  }
}
