import { err, ok, type FrmError, type Result } from "@bayon/core";
import { z } from "zod";

// Stored rows into proto DTOs: a row that does not fit its DTO is an internal error, never passed on.

const corrupt = (what: string, detail: string): FrmError => ({
  class: "internal",
  message: `stored ${what} does not fit its DTO: ${detail}`,
  retryable: false,
});

export function parseAs<T>(
  schema: z.ZodType<T>,
  value: unknown,
  what: string,
): Result<T> {
  const parsed = schema.safeParse(value);
  return parsed.success
    ? ok(parsed.data)
    : err(corrupt(what, z.prettifyError(parsed.error)));
}

/** A JSON text column's value; null stays null. */
export function jsonColumn(text: string | null, what: string): Result<unknown> {
  if (text === null) return ok(null);
  try {
    const value: unknown = JSON.parse(text);
    return ok(value);
  } catch {
    return err(corrupt(what, "not JSON"));
  }
}
