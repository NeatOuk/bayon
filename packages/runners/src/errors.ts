import type { ErrorClass, FrmError } from "@bayon/core";

/** Builds core's FrmError: plain data, so it crosses processes, the DB and the wire. */
export function frmError(
  errorClass: ErrorClass,
  message: string,
  options: { readonly retryable?: boolean; readonly cause?: unknown } = {},
): FrmError {
  return {
    class: errorClass,
    message,
    retryable: options.retryable ?? false,
    ...(options.cause === undefined ? {} : { cause: options.cause }),
  };
}

/** A rejection as an FrmError: executors reject with FrmError data, anything else is `internal`. */
export function asFrmError(
  reason: unknown,
  fallback: ErrorClass,
  message: string,
): FrmError {
  if (
    typeof reason === "object" &&
    reason !== null &&
    "class" in reason &&
    "message" in reason &&
    typeof reason.message === "string"
  ) {
    return reason as FrmError;
  }
  return frmError(fallback, message, {
    cause: reason instanceof Error ? reason.message : String(reason),
  });
}
