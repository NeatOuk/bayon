// The one ticket-ref resolver every MCP ticket tool uses: a ref is the ticket's id
// (ULID), its key (FRM-1, by settings.tickets.key_prefix), #1 or 1 — the forms prompts show. The
// store parses it (core ticketRefOf); an unknown ref is not_found, naming the accepted forms.
// it is also the one door a project's orchestrator is held to its project at — a ticket
// in another project, or in none, is refused cross_project for every tool that names one.
import { outsideProject } from "./scope.js";
import type { TicketTarget } from "./store.js";
import { failed, refused, type ToolCtx, type ToolOutcome } from "./tool-kit.js";

export const TICKET_REF_FORMS =
  "name a ticket by its id (ULID), its key (e.g. FRM-1), #<number> or <number>";

export type Resolved =
  | { readonly ok: true; readonly target: TicketTarget }
  | { readonly ok: false; readonly outcome: ToolOutcome };

/** The ticket `ref` names, or the outcome that says why not: unknown, or outside the project. */
export async function resolveTicket(
  ctx: ToolCtx,
  ref: string,
): Promise<Resolved> {
  const found = await ctx.store.ticketOf(ref);
  if (!found.ok) return { ok: false, outcome: failed(found.error) };
  if (found.value === null) {
    return {
      ok: false,
      outcome: refused({
        reason: "not_found",
        detail: `no ticket ${ref}; ${TICKET_REF_FORMS}`,
      }),
    };
  }
  const outside = outsideProject(ctx.actor, found.value.workspaceId);
  return outside === null
    ? { ok: true, target: found.value }
    : {
        ok: false,
        outcome: refused({ reason: "cross_project", detail: outside }),
      };
}
