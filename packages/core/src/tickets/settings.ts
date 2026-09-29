import { z } from "zod";
import {
  ComplexityRubric,
  DEFAULT_COMPLEXITY_RUBRIC,
} from "../complexity/rubric.js";
import { err, ok, type Result } from "../errors.js";
import {
  DEFAULT_TICKET_KEY_PREFIX,
  PlanPaths,
  TicketKeyPrefix,
} from "./key.js";

// The tickets module's tunables (config over code): `settings` rows, else these defaults. Same
// pattern as the supervisor's lifecycle settings; no migration seeds them.

export const TicketSettings = z.object({
  "tickets.key_prefix": TicketKeyPrefix.default(DEFAULT_TICKET_KEY_PREFIX),
  "complexity.rubric": ComplexityRubric.default(DEFAULT_COMPLEXITY_RUBRIC),
  "laws.plan_paths": PlanPaths.default({
    prefixes: ["docs/"],
    suffixes: [".md"],
  }),
  /** Each git command of the no_source_changes check; past it the law refuses diff_unverifiable. */
  "laws.git_timeout_ms": z.int().positive().default(5_000),
});
export type TicketSettings = z.infer<typeof TicketSettings>;

export const DEFAULT_TICKET_SETTINGS: TicketSettings = TicketSettings.parse({});

export const TICKET_SETTINGS_KEYS: readonly string[] = Object.keys(
  TicketSettings.shape,
);

/** The settings from their rows (absent rows default); an invalid row is a validation error. */
export function parseTicketSettings(
  rows: ReadonlyMap<string, unknown>,
): Result<TicketSettings> {
  const parsed = TicketSettings.safeParse(Object.fromEntries(rows));
  return parsed.success
    ? ok(parsed.data)
    : err({
        class: "validation",
        message: `ticket settings: ${z.prettifyError(parsed.error)}`,
        retryable: false,
      });
}
