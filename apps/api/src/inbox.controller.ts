import { STAFF_APPROVAL_KIND, staffDecisionOf } from "@bayon/core";
import {
  AnswerRequest,
  InboxQuery,
  type InboxItem,
  type InboxPage,
} from "@bayon/proto";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Optional,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { FrmHttpError, unwrap } from "./errors.js";
import type { ApiStore } from "./store.js";
import type { TicketService } from "./tickets/ticket-service.js";
import { API_STORE, TICKET_SERVICE } from "./tokens.js";

// `/inbox` (§12.1): the human requests agents open with human_ask (§11.1), and the operator's
// answer. The asking session reads the answer through ticket_get; its pulse wakes on answered_at.
// A staffing proposal is answered `approve` or `reject`, and an approval staffs: the
// tickets module answers it, in one transaction with the spawn.

@Controller("inbox")
export class InboxController {
  readonly #store: ApiStore;
  readonly #tickets: TicketService | undefined;

  constructor(
    @Inject(API_STORE) store: ApiStore,
    @Optional() @Inject(TICKET_SERVICE) tickets?: TicketService,
  ) {
    this.#store = store;
    this.#tickets = tickets;
  }

  /** Open requests first, then answered ones, newest asked first; `?status=` keeps one kind. */
  @Get()
  async list(
    @Query({ schema: InboxQuery }) query: InboxQuery,
  ): Promise<InboxPage> {
    return unwrap(await this.#store.inbox(query));
  }

  /**
   * 200 with the answered request; 400 for an empty answer, 404 unknown, 409 already answered. A
   * staffing proposal takes `approve` or `reject` (else 400); an approval the fleet cannot staff
   * now (the agent busy or disabled, the ticket held or moved on) is a 409 naming why, and the
   * request stays open.
   */
  @Post(":id/answer")
  @HttpCode(HttpStatus.OK)
  async answer(
    @Param("id") id: string,
    @Body({ schema: AnswerRequest }) body: AnswerRequest,
  ): Promise<InboxItem> {
    const request = unwrap(await this.#store.inboxItem(id));
    if (request.kind !== STAFF_APPROVAL_KIND) {
      return unwrap(await this.#store.answerHumanRequest(id, body.answer));
    }
    const decision = staffDecisionOf(body.answer);
    if (decision === null) {
      throw new FrmHttpError({
        class: "validation",
        message: `human request ${id} is a staffing proposal: answer approve or reject`,
        retryable: false,
      });
    }
    if (this.#tickets === undefined) {
      throw new FrmHttpError({
        class: "internal",
        message:
          "the tickets module is not mounted: a staffing proposal cannot be answered",
        retryable: false,
      });
    }
    unwrap(await this.#tickets.answerStaffProposal(id, decision));
    return unwrap(await this.#store.inboxItem(id));
  }

  /**
   * The operator withdraws an open question that no longer matters: 200 with the
   * dismissed request, audited. It stops holding its ticket, and the last open question's dismissal
   * wakes the orchestrator as a last answer does. 404 unknown, 409 already closed, 400 for a staffing
   * proposal (reject it instead). REST is the operator's door; no session can reach it.
   */
  @Post(":id/dismiss")
  @HttpCode(HttpStatus.OK)
  async dismiss(@Param("id") id: string): Promise<InboxItem> {
    return unwrap(await this.#store.dismissHumanRequest(id));
  }
}
