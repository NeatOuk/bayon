import { z } from "zod";

/** The closed set of error classes stored in every `error_class` column. */
export const ErrorClass = z.enum([
  "db_busy",
  "validation",
  "not_found",
  "conflict",
  "law_refused", // a §3.2 transition law said no; the cause carries rule, reason and detail
  "admission_refused",
  "over_budget", // pre-flight refused a prompt over its cap (§8.4); the cause carries the sizes
  "spawn_failed",
  // The project's repo could not be read: not found, no access, an unknown ssh host
  // key, or its host unreachable. The message says which in plain words, and what to do.
  "repo_unreachable",
  "runner_exited_without_terminal",
  "runner_error", // a runner- or provider-side failure, e.g. an API error result
  "timeout",
  "interrupted",
  // The reconciler ended it because its process predates this supervisor; the outcome stays
  // failed or timeout, only the class says why. Never a ticket's failure.
  "supervisor_restart",
  "unknown_command",
  "internal",
]);
export type ErrorClass = z.infer<typeof ErrorClass>;

/** The one error shape. Plain data, because it crosses processes, the DB and the wire. */
export const FrmError = z.object({
  class: ErrorClass,
  message: z.string(),
  retryable: z.boolean(),
  cause: z.unknown().optional(),
});
export type FrmError = z.infer<typeof FrmError>;

export type Result<T, E = FrmError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = (error: FrmError): Result<never> => ({ ok: false, error });
