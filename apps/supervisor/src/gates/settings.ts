// The gate engine's settings: the gate settings core reads, the poll
// (011), whether a reviewer must differ from the builder (§9.8), and the paths a plan_review may
// touch (laws.plan_paths, the same setting the API's no_source_changes reads).
import {
  GATE_SETTING_KEYS,
  err,
  ok,
  parseTicketSettings,
  readGateSettings,
  type GateSettings,
  type PlanPaths,
  type Result,
} from "@bayon/core";
import { getSettings, type Db } from "@bayon/db";
import { z } from "zod";

export const SUPERSEDE_POLL_KEY = "gates.supersede_poll_ms";
const REQUIRE_DISTINCT_KEY = "roles.require_distinct_reviewer";
const PLAN_PATHS_KEY = "laws.plan_paths";

export interface EngineSettings {
  readonly gate: GateSettings;
  readonly pollMs: number;
  readonly requireDistinct: boolean;
  readonly planPaths: PlanPaths;
}

const PollMs = z.int().positive();
/** 002 seeds it `1`; absent means distinct (§9.8's default). */
const Distinct = z.union([z.literal(0), z.literal(1), z.boolean()]).default(1);

const invalid = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

export async function loadEngineSettings(
  db: Db,
): Promise<Result<EngineSettings>> {
  const rows = await getSettings(db, [
    ...Object.values(GATE_SETTING_KEYS),
    SUPERSEDE_POLL_KEY,
    REQUIRE_DISTINCT_KEY,
    PLAN_PATHS_KEY,
  ]);
  if (!rows.ok) return rows;
  const gate = readGateSettings(rows.value);
  if (!gate.ok) return gate;
  const poll = PollMs.safeParse(rows.value.get(SUPERSEDE_POLL_KEY));
  if (!poll.success) {
    return invalid(
      `${SUPERSEDE_POLL_KEY} is not a positive integer (migration 011 seeds it)`,
    );
  }
  const distinct = Distinct.safeParse(rows.value.get(REQUIRE_DISTINCT_KEY));
  if (!distinct.success)
    return invalid(`${REQUIRE_DISTINCT_KEY} is not 0 or 1`);
  const plan = rows.value.get(PLAN_PATHS_KEY);
  const tickets = parseTicketSettings(
    new Map(plan === undefined ? [] : [[PLAN_PATHS_KEY, plan]]),
  );
  if (!tickets.ok) return tickets;
  return ok({
    gate: gate.value,
    pollMs: poll.data,
    requireDistinct: distinct.data === 1 || distinct.data === true,
    planPaths: tickets.value["laws.plan_paths"],
  });
}
