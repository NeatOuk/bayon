// What every tool handler shares: its context, its outcome, and the small
// helpers for pages and windows. Handlers parse their own input and return plain data; the server
// caps, audits refusals and serializes.
import type { FrmError, JsonValue } from "@bayon/core";
import type { AuditEntry } from "@bayon/db/api";
import { MCP_PAGE_ROWS } from "@bayon/proto";
import type { DocsReader } from "../docs/reader.js";
import type { TicketService } from "../tickets/ticket-service.js";
import type { Refusal } from "./refusals.js";
import type { McpActor } from "./scope.js";
import type { McpSession, McpStore } from "./store.js";

export interface ToolCtx {
  readonly session: McpSession;
  readonly actor: McpActor;
  readonly store: McpStore;
  /** tickets module; absent when the API mounts no /tickets. */
  readonly tickets: TicketService | undefined;
  /** documentation reader; absent when the API was given no host secret store. */
  readonly docs: DocsReader | undefined;
  /** This call's audit entry for a write that lands (outcome ok). */
  audit(targetKind: string, targetId: string | null): AuditEntry;
}

export type ToolOutcome =
  | { readonly kind: "ok"; readonly data: JsonValue }
  | { readonly kind: "refused"; readonly refusal: Refusal }
  | { readonly kind: "failed"; readonly error: FrmError };

export type Handler = (ctx: ToolCtx, raw: unknown) => Promise<ToolOutcome>;

/** A windowed body in a list row: enough to decide whether to read on. */
export const EXCERPT = 160;

export const done = (data: JsonValue): ToolOutcome => ({ kind: "ok", data });
export const failed = (error: FrmError): ToolOutcome => ({
  kind: "failed",
  error,
});
export const refused = (refusal: Refusal): ToolOutcome => ({
  kind: "refused",
  refusal,
});
export const invalid = (message: string): ToolOutcome =>
  failed({ class: "validation", message, retryable: false });

export const excerpt = (text: string, max = EXCERPT) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** A page cursor is the offset of the page's first row, as the tool returned it. */
export function offsetOf(
  cursor: string | undefined,
  max: number,
): number | null {
  if (cursor === undefined) return 0;
  if (!/^\d{1,6}$/.test(cursor)) return null;
  const offset = Number(cursor);
  return offset + MCP_PAGE_ROWS < max ? offset : null;
}

export const badCursor = (): ToolOutcome =>
  invalid("cursor is not one this tool returned");

/** One page of `rows` fetched through `offset + 21`, and the next page's cursor. */
export function page<T>(rows: readonly T[], offset: number) {
  const end = offset + MCP_PAGE_ROWS;
  return {
    rows: rows.slice(offset, end),
    next_cursor: rows.length > end ? String(end) : null,
  };
}
