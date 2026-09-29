import type { ErrorClass, FrmError } from "@bayon/core";

/** Builds core's FrmError: plain data, so it can cross processes, the DB and the wire. */
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

export function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && err.code === code;
}
