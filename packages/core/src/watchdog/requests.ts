// System human_requests: what the supervisor's named writer
// insertSystemHumanRequest takes. Each request is keyed `<rule>:<subject>:<window>`, and a unique
// index on that key makes a second request for the same condition and window impossible at the
// database. The rule is also the row's kind.
import { z } from "zod";

/**
 * The rules that file system requests: the watchdog's three, M4-c's blocked pulse, and delivery's
 * — a push the remote refused, or a forge that would not take the pull request, which
 * only the operator can resolve.
 */
export const SystemRequestRule = z.enum([
  "circuit",
  "split",
  "retry_storm",
  "budget_pulse",
  "delivery",
  // a spawn whose repo cannot be read — only the operator can fix a URL or an access.
  "repo",
]);
export type SystemRequestRule = z.infer<typeof SystemRequestRule>;

/** `human_requests.kind` of each rule's rows. */
export const SYSTEM_REQUEST_KIND: Readonly<Record<SystemRequestRule, string>> =
  {
    circuit: "circuit_breaker",
    split: "split",
    retry_storm: "retry_storm",
    budget_pulse: "budget",
    delivery: "delivery",
    repo: "repo_access",
  };

/** Caps on what a system request carries (Invariant 9 in spirit: ids and states, never bodies). */
export const SYSTEM_QUESTION_MAX = 500;
export const SYSTEM_CONTEXT_MAX = 2_048;
/** How much of a stored error message a request quotes. */
export const ERROR_EXCERPT_MAX = 200;

/** A key part: no colon (it separates the parts) and no whitespace. */
const KeyPart = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\s:]+$/, "a key part has no colon and no whitespace");

export const SystemHumanRequest = z.object({
  rule: SystemRequestRule,
  /** The ticket id, `<runner>/<executor>`, the budget id, or delivery's `<ticket>`. */
  subject: KeyPart,
  /** The incident or window: a second request for it is refused by the key. */
  window: KeyPart,
  question: z.string().trim().min(1).max(SYSTEM_QUESTION_MAX),
  context_md: z.string().max(SYSTEM_CONTEXT_MAX),
  options: z.array(z.string().min(1).max(80)).max(8),
  ticket_id: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  expires_at: z.int().nonnegative().optional(),
});
export type SystemHumanRequest = z.infer<typeof SystemHumanRequest>;

/** Every key of one (rule, subject) starts with this. */
export const dedupePrefix = (
  rule: SystemRequestRule,
  subject: string,
): string => `${rule}:${subject}:`;

/** The request's key: one per rule, subject and window. */
export const dedupeKey = (
  r: Pick<SystemHumanRequest, "rule" | "subject" | "window">,
): string => `${dedupePrefix(r.rule, r.subject)}${r.window}`;

/** A (runner, executor) pair as a key subject. */
export const pairKey = (runnerId: string, executorId: string): string =>
  `${runnerId}/${executorId}`;

/** `text` cut to `max` characters, marked when cut. */
export const excerpt = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
