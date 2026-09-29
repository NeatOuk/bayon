import { canonicalJson, err, ok, type Result } from "@bayon/core";
import { z } from "zod";
import { failure } from "./errors.js";

const Json = z.json();

/** `value` as canonical JSON text (sorted keys), or a validation error naming `what`. */
export function toJsonText(value: unknown, what: string): Result<string> {
  const parsed = Json.safeParse(value);
  return parsed.success
    ? ok(canonicalJson(parsed.data))
    : err(
        failure(
          "validation",
          `${what} is not JSON: ${z.prettifyError(parsed.error)}`,
        ),
      );
}

/** An optional value as canonical JSON text, or null when it is absent. */
export const optionalJson = (
  value: unknown,
  what: string,
): Result<string | null> =>
  value === undefined ? ok(null) : toJsonText(value, what);
