import { z } from "zod";

// Ticket keys (M1 amendment 13) and the plan-path rule of no_source_changes. The key helpers are
// shared by the API and the markdown exporter, so both render the same key.

export const TicketKeyPrefix = z
  .string()
  .regex(
    /^[A-Z][A-Z0-9]{0,9}-$/,
    "a key prefix is a capital, up to 9 more capitals or digits, then '-'",
  );

export const DEFAULT_TICKET_KEY_PREFIX = "FRM-";

/** `settings.tickets.key_prefix` + `tickets.num`, e.g. FRM-42. */
export const ticketKey = (prefix: string, num: number): string =>
  `${prefix}${num}`;

/** What a ticket ref names: a number, or else an id to look up. */
export type TicketRefTarget =
  { readonly num: number } | { readonly id: string };

const NUM = /^[0-9]{1,15}$/;

/**
 * Every ticket form a prompt shows: the key (`prefix` + num, e.g. FRM-1, any case),
 * `#1` and `1` name a number; anything else is taken as an id (a ULID).
 */
export function ticketRefOf(ref: string, prefix: string): TicketRefTarget {
  const r = ref.trim();
  const digits = r.startsWith("#")
    ? r.slice(1)
    : r.toUpperCase().startsWith(prefix)
      ? r.slice(prefix.length)
      : r;
  return NUM.test(digits) ? { num: Number(digits) } : { id: r };
}

/** Paths a plan-only diff may touch (`settings.laws.plan_paths`). */
export const PlanPaths = z.object({
  prefixes: z.array(z.string().min(1)),
  suffixes: z.array(z.string().min(1)),
});
export type PlanPaths = z.infer<typeof PlanPaths>;

/** A path under a plan prefix or with a plan suffix is not a source change. */
export const isNonSource = (path: string, paths: PlanPaths): boolean =>
  paths.prefixes.some((prefix) => path.startsWith(prefix)) ||
  paths.suffixes.some((suffix) => path.endsWith(suffix));
