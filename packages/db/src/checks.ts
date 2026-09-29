import { err, ok, type Result } from "@bayon/core";
import { failure } from "./errors.js";

// Input checks the repositories run before they open a transaction.

/** The first failed check, or ok. */
export const allOk = (...checks: readonly Result<void>[]): Result<void> =>
  checks.find((c) => !c.ok) ?? ok(undefined);

/** A validation error with `message` unless `condition` holds. */
export const check = (condition: boolean, message: string): Result<void> =>
  condition ? ok(undefined) : err(failure("validation", message));

/** A validation error naming every field that is empty or only whitespace. */
export function requireText(
  fields: Readonly<Record<string, string>>,
): Result<void> {
  const empty = Object.entries(fields)
    .filter(([, value]) => value.trim().length === 0)
    .map(([name]) => name);
  return check(empty.length === 0, `${empty.join(", ")} must not be empty`);
}

/** The keys of `o` whose values are set: an update ignores undefined ones. */
export const definedKeys = (o: object): string[] =>
  Object.entries(o)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
