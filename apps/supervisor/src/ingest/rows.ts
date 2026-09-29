// Canonical events → `events` rows. Pure apart from capEvent's spill files.
import type { CanonicalEvent } from "@bayon/core";
import type { EventInsert } from "@bayon/db/supervisor";
import { capEvent } from "./cap.js";

/**
 * A terminal that lost to its run's first one, or that no open run owns (§5.2): stored as
 * `runner_native` with the original payload, never dropped (Invariant 4). Its runner_type and
 * raw_offset stay, so a replay demotes it to the same row.
 */
export function demote(e: CanonicalEvent): CanonicalEvent {
  return {
    kind: "runner_native",
    ts: e.ts,
    runner_type: e.runner_type,
    ...(e.text === undefined ? {} : { text: e.text }),
    payload: { raw: e.payload, demoted_kind: e.kind },
  };
}

export interface RowInput {
  readonly sessionId: string;
  /** The open run the event belongs to; ingest decides it, never the runner. */
  readonly runId: string | undefined;
  readonly event: CanonicalEvent;
  readonly rawOffset: number;
  readonly toolDir: string;
}

export function toRow(o: RowInput): EventInsert {
  const e = o.event;
  return {
    session_id: o.sessionId,
    run_id: o.runId ?? null,
    ts: e.ts,
    kind: e.kind,
    runner_type: e.runner_type,
    tool_name: e.tool_name ?? null,
    status: e.status ?? null,
    exit_code: e.exit_code ?? null,
    ...capEvent(e, { toolDir: o.toolDir, rawOffset: o.rawOffset }),
    raw_offset: o.rawOffset,
  };
}
