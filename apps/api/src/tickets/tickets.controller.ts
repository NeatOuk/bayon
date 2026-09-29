import type { Actor } from "@bayon/core";
import {
  CommentRequest,
  CreateTicketRequest,
  ETAG_HEADER,
  IF_MATCH_HEADER,
  LinkRequest,
  PatchTicketRequest,
  StaffRequest,
  TicketEventsQuery,
  TicketsQuery,
  TransitionRequest,
  etagOf,
  type NextStep,
  type StaffAccepted,
  type TicketDetail,
  type TicketEventView,
  type TicketEventsPage,
  type TicketLinkView,
  type TicketView,
  type TicketsPage,
} from "@bayon/proto";
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import { IDEMPOTENCY, idempotencyKey } from "../controllers.js";
import { FrmHttpError, unwrap } from "../errors.js";
import { TICKET_SERVICE } from "../tokens.js";
import { ifMatchVersion } from "./if-match.js";
import { staffRefusalError } from "./staffing.js";
import type { TicketService } from "./ticket-service.js";

// /api/v1/tickets (§12.1; M1 contracts 2, 3 and 8). REST callers are the operator; sessions reach
// the same TicketService through /mcp. Every ticket response carries its version as
// the ETag; PATCH and transition take it back as If-Match.

const OPERATOR: Actor = { kind: "operator" };
const IF_MATCH = IF_MATCH_HEADER.toLowerCase();
const CACHE_CONTROL_HEADER = "Cache-Control";
const NO_STORE = "no-store";

/** The part of Express's response the controller touches. */
interface HeaderSink {
  setHeader(name: string, value: string): unknown;
}

const tagged = (res: HeaderSink, view: TicketView): TicketView => {
  res.setHeader(ETAG_HEADER, etagOf(view.version));
  return view;
};

@Controller("tickets")
export class TicketsController {
  readonly #tickets: TicketService;

  constructor(@Inject(TICKET_SERVICE) tickets: TicketService) {
    this.#tickets = tickets;
  }

  @Get()
  async list(
    @Query({ schema: TicketsQuery }) query: TicketsQuery,
  ): Promise<TicketsPage> {
    return unwrap(await this.#tickets.list(query));
  }

  /** 201 with the new backlog ticket, scored from its complexity facts (§8.8). */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body({ schema: CreateTicketRequest }) body: CreateTicketRequest,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<TicketView> {
    return tagged(res, unwrap(await this.#tickets.create(body, OPERATOR)));
  }

  /**
   * `:ref` is the ULID or the number. The detail carries the operator's allowed transitions. Never
   * cached: its ETag is the ticket's version, which the events, gates, hand-offs and next step all
   * change without moving, so a cache revalidating on it would get a 304 for a stale body.
   */
  @Get(":ref")
  async detail(
    @Param("ref") ref: string,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<TicketDetail> {
    const detail = unwrap(await this.#tickets.get(ref, OPERATOR));
    res.setHeader(CACHE_CONTROL_HEADER, NO_STORE);
    res.setHeader(ETAG_HEADER, etagOf(detail.ticket.version));
    return detail;
  }

  /** Who the ticket waits on, why, and the operator's way on; 404 for no such ticket. */
  @Get(":ref/next")
  async next(@Param("ref") ref: string): Promise<NextStep> {
    return unwrap(await this.#tickets.next(ref));
  }

  @Get(":ref/events")
  async events(
    @Param("ref") ref: string,
    @Query({ schema: TicketEventsQuery }) query: TicketEventsQuery,
  ): Promise<TicketEventsPage> {
    return unwrap(await this.#tickets.events(ref, query));
  }

  /** 428 without If-Match, 409 (`current_version`) when stale, 422 when a law refuses. */
  @Patch(":ref")
  async update(
    @Param("ref") ref: string,
    @Headers(IF_MATCH) ifMatch: string | undefined,
    @Body({ schema: PatchTicketRequest }) body: PatchTicketRequest,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<TicketView> {
    const version = ifMatchVersion(ifMatch);
    return tagged(
      res,
      unwrap(await this.#tickets.update(ref, version, body, OPERATOR)),
    );
  }

  /** 200 with the moved ticket; 422 `law_refused` names the rule, the reason and the detail. */
  @Post(":ref/transition")
  @HttpCode(HttpStatus.OK)
  async transition(
    @Param("ref") ref: string,
    @Headers(IF_MATCH) ifMatch: string | undefined,
    @Body({ schema: TransitionRequest }) body: TransitionRequest,
    @Res({ passthrough: true }) res: HeaderSink,
  ): Promise<TicketView> {
    const version = ifMatchVersion(ifMatch);
    return tagged(
      res,
      unwrap(await this.#tickets.transition(ref, version, body, OPERATOR)),
    );
  }

  @Post(":ref/comments")
  @HttpCode(HttpStatus.CREATED)
  async comment(
    @Param("ref") ref: string,
    @Body({ schema: CommentRequest }) body: CommentRequest,
  ): Promise<TicketEventView> {
    return unwrap(await this.#tickets.comment(ref, body, OPERATOR));
  }

  @Post(":ref/links")
  @HttpCode(HttpStatus.CREATED)
  async link(
    @Param("ref") ref: string,
    @Body({ schema: LinkRequest }) body: LinkRequest,
  ): Promise<TicketLinkView> {
    return unwrap(await this.#tickets.link(ref, body, OPERATOR));
  }

  /**
   * ticket_staff's twin (M2 amendment h): 202 with the queued session.spawn. 409 when the ticket
   * takes no session or already has one; 429 over the daily cap or with no free agent.
   */
  @Post(":ref/staff")
  @HttpCode(HttpStatus.ACCEPTED)
  async staff(
    @Param("ref") ref: string,
    @Body({ schema: StaffRequest }) body: StaffRequest,
    @Headers(IDEMPOTENCY) key: string | undefined,
  ): Promise<StaffAccepted> {
    const staffed = unwrap(
      await this.#tickets.staff(ref, body, OPERATOR, idempotencyKey(key)),
    );
    if (staffed.kind === "refused") {
      throw new FrmHttpError(staffRefusalError(staffed));
    }
    return staffed.accepted;
  }
}
