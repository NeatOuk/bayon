import { FrmError, type ErrorClass } from "@bayon/core";

export const frmError = (
  errorClass: ErrorClass,
  message: string,
  cause?: unknown,
): FrmError => ({
  class: errorClass,
  message,
  retryable: false,
  ...(cause === undefined ? {} : { cause }),
});

/** A rejection as an FrmError: executors and adapters reject with FrmError data; anything else is `fallback`. */
export function asFrmError(
  reason: unknown,
  fallback: ErrorClass,
  message: string,
): FrmError {
  const known = FrmError.safeParse(reason);
  return known.success
    ? known.data
    : frmError(
        fallback,
        message,
        reason instanceof Error ? reason.message : String(reason),
      );
}

/** A stop aborted the spawn pipeline. */
export const stopped = (): FrmError =>
  frmError("interrupted", "stopped during spawn");
