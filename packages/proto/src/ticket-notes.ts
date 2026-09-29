import { z } from "zod";
import { TicketRef } from "./tickets.js";

// `POST /tickets/:ref/comments` and `/links` (§11.1 ticket.comment and ticket.link): history and
// cross-references any actor may add. Neither moves the status or the version.

export const CommentRequest = z.strictObject({
  body_md: z.string().trim().min(1).max(20_000),
});
export type CommentRequest = z.infer<typeof CommentRequest>;

/** A link names exactly one of a url or a target ticket (its ULID or number). */
export const LinkRequest = z
  .strictObject({
    kind: z.string().trim().min(1).max(40),
    url: z.url().max(2_000).optional(),
    target: TicketRef.optional(),
  })
  .refine(
    (link) => (link.url === undefined) !== (link.target === undefined),
    "a link names a url or a target ticket, not both",
  );
export type LinkRequest = z.infer<typeof LinkRequest>;
